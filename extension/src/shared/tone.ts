/**
 * Tone detection (Grammarly-parity tone card).
 *
 * Two paths:
 *  1. LLM detection via the existing `rewrite` native command with a
 *     dedicated prompt (no native-host changes needed) — authoritative.
 *  2. A pure-local heuristic fallback so the tone card still works when
 *     LM Studio is offline (like the rest of the local-first design).
 *
 * The detected tone list is deliberately aligned with Grammarly's tone
 * detector vocabulary (~26 tones) and every tone carries an emoji so the
 * floating widget and tone card can render without extra lookups.
 */

import { ToneReading } from "./types";
import { buildToneDetectPrompt } from "./prompts";
import { parseToneDetectResponse } from "./ai-validation";
import { getSettings } from "./storage";

export interface ToneDef {
  tone: string;
  emoji: string;
}

/** Grammarly-aligned detectable tones with emoji for UI rendering. */
export const DETECTABLE_TONES: readonly ToneDef[] = [
  { tone: "confident", emoji: "💪" },
  { tone: "friendly", emoji: "😊" },
  { tone: "formal", emoji: "🎩" },
  { tone: "informal", emoji: "👕" },
  { tone: "optimistic", emoji: "🌞" },
  { tone: "joyful", emoji: "😄" },
  { tone: "encouraging", emoji: "🌱" },
  { tone: "supportive", emoji: "🤝" },
  { tone: "excited", emoji: "🤩" },
  { tone: "curious", emoji: "🤔" },
  { tone: "hopeful", emoji: "🕊️" },
  { tone: "proud", emoji: "🏅" },
  { tone: "grateful", emoji: "🙏" },
  { tone: "calm", emoji: "😌" },
  { tone: "assertive", emoji: "👉" },
  { tone: "empathetic", emoji: "💗" },
  { tone: "appreciative", emoji: "👏" },
  { tone: "respectful", emoji: "🫡" },
  { tone: "neutral", emoji: "⚖️" },
  { tone: "blunt", emoji: "💢" },
  { tone: "urgent", emoji: "⏰" },
  { tone: "serious", emoji: "🧐" },
  { tone: "sad", emoji: "😢" },
  { tone: "frustrated", emoji: "😤" },
  { tone: "direct", emoji: "📍" },
  { tone: "persuasive", emoji: "🎯" },
];

const TONE_SET = new Set(DETECTABLE_TONES.map((t) => t.tone));

export function toneEmoji(tone: string): string {
  return DETECTABLE_TONES.find((t) => t.tone === tone)?.emoji ?? "📝";
}

export function isKnownTone(tone: string): boolean {
  return TONE_SET.has(tone.toLowerCase());
}

/* ---------------- Local heuristic fallback ---------------- */

const FORMAL_MARKERS = [
  "hereby", "regarding", "pursuant", "therefore", "furthermore",
  "accordingly", "sincerely", "respectfully", "kindly", "aforementioned",
];
const INFORMAL_MARKERS = [
  "gonna", "wanna", "yeah", "hey", "hi there", "kinda", "super",
  "awesome", "lol", "stuff", "guys",
];
const HEDGES = [
  "maybe", "perhaps", "might", "possibly", "i think", "i guess",
  "sort of", "kind of", "just wondering",
];
const URGENT_MARKERS = [
  "asap", "urgent", "immediately", "right away", "deadline", "as soon as possible",
];

interface Counter {
  [k: string]: number;
}

/**
 * Offline tone heuristic. Signals: exclamation marks, question marks,
 * formal/informal vocabulary, hedging, urgency words, gratitude.
 * Returns up to 3 tones sorted by strength — never empty for non-empty
 * text (falls back to "neutral").
 */
export function heuristicTone(text: string): ToneReading[] {
  const t = text.toLowerCase();
  if (!text.trim()) return [];
  const c: Counter = {};
  const exclam = (text.match(/!/g) ?? []).length;
  const questions = (text.match(/\?/g) ?? []).length;
  if (exclam >= 2) c.excited = 0.8;
  if (exclam >= 1 && exclam < 2) c.optimistic = 0.6;
  if (questions >= 1) c.curious = Math.min(0.8, 0.5 + questions * 0.1);
  const hits = (list: string[]): number =>
    list.reduce((acc, m) => acc + (t.includes(m) ? 1 : 0), 0);
  const formalHits = hits(FORMAL_MARKERS);
  if (formalHits > 0) c.formal = Math.min(0.9, 0.5 + formalHits * 0.15);
  const informalHits = hits(INFORMAL_MARKERS);
  if (informalHits > 0) c.informal = Math.min(0.9, 0.5 + informalHits * 0.15);
  const hedgeHits = hits(HEDGES);
  if (hedgeHits >= 2) c.blunt = 0.4; // hedging → less assertive; show as blunt-low
  const urgentHits = hits(URGENT_MARKERS);
  if (urgentHits > 0) c.urgent = Math.min(0.9, 0.5 + urgentHits * 0.2);
  if (/\b(thanks|thank you|appreciate)\b/.test(t)) c.grateful = 0.7;
  if (/\b(sorry|apolog|unfortunately)\b/.test(t)) c.empathetic = 0.5;
  if (/\b(must|need to|ensure|required)\b/.test(t)) c.direct = 0.5;
  if (Object.keys(c).length === 0) c.neutral = 0.6;
  return Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tone, score]) => ({ tone, score: Math.round(score * 100) / 100 }));
}

/* ---------------- LLM detection ---------------- */

interface RelayLike {
  (command: string, payload: unknown, timeoutMs: number): Promise<{
    ok: boolean;
    errorCode?: string;
    error?: string;
    data?: unknown;
  }>;
}

/**
 * Detect tones for `text`. `relay` injects the transport so the same
 * function works from the service worker (sendNative) and from the
 * content script (the SW message relay). On any failure the local
 * heuristic is used so the UI never blocks.
 */
export async function detectTone(
  text: string,
  relay: RelayLike,
): Promise<ToneReading[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const heuristic = heuristicTone(trimmed);
  try {
    const settings = await getSettings();
    const prompt = buildToneDetectPrompt();
    const resp = await relay(
      "rewrite",
      {
        text: trimmed.slice(0, 4000),
        systemPrompt: prompt.system,
        model: settings.model,
        temperature: 0.2,
        maxTokens: 256,
        timeoutMs: settings.requestTimeoutMs,
      },
      settings.requestTimeoutMs + 5000,
    );
    if (!resp.ok) return heuristic;
    const data = resp.data as { raw?: string } | undefined;
    if (!data || typeof data.raw !== "string") return heuristic;
    const parsed = parseToneDetectResponse(data.raw);
    return parsed.length > 0 ? parsed : heuristic;
  } catch {
    return heuristic;
  }
}

/** Parse a raw model output into validated ToneReadings (exported for tests). */
export { parseToneDetectResponse };
