/**
 * Strict parser/validator for AI responses from the local model.
 *
 * The model is treated as completely untrusted. Malformed output is
 * rejected with INVALID_AI_RESPONSE rather than inserted into the page
 * (spec sections 17, 61, 62, 65).
 */

import { GrammarCheckResponse, Issue, IssueCategory } from "./types";
import { hashText } from "./text-utils";

const VALID_CATEGORIES: ReadonlySet<string> = new Set<IssueCategory>([
  "spelling",
  "grammar",
  "punctuation",
  "clarity",
  "word_choice",
  "style",
]);

/** Strip code fences if the model wrapped its JSON in ```json … ```. */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    const end = trimmed.lastIndexOf("```");
    if (end <= 3) return trimmed.replace(/^```[a-zA-Z]*\s*/, "").trim();
    return trimmed.slice(3, end).replace(/^[a-zA-Z]*\s*/, "").trim();
  }
  return trimmed;
}

/** Find the first '{' … last '}' substring (best-effort recovery). */
function extractJsonBlock(raw: string): string {
  const fenced = stripFences(raw);
  const first = fenced.indexOf("{");
  const last = fenced.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return fenced;
  return fenced.slice(first, last + 1);
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

function asFloat(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  return null;
}

/**
 * Parse and validate a grammar-check response.
 *
 * Throws { code: 'INVALID_AI_RESPONSE', detail: string } on any
 * structural problem. Issue offsets that don't match the supplied text
 * are silently dropped (with a console warn) — we don't fail the whole
 * response for one bad issue.
 */
export function parseGrammarResponse(
  raw: string,
  analyzedText: string,
): GrammarCheckResponse {
  const block = extractJsonBlock(raw);
  const parsed = safeParse(block);
  if (!isObject(parsed)) {
    throw { code: "INVALID_AI_RESPONSE", detail: "not an object" };
  }
  const issuesRaw = parsed.issues;
  if (!Array.isArray(issuesRaw)) {
    // Treat missing issues as zero issues — only fail if correctedText is also missing.
    if (!("correctedText" in parsed)) {
      throw { code: "INVALID_AI_RESPONSE", detail: "issues not array" };
    }
  }

  const issues: Issue[] = [];
  const seenIds = new Set<string>();
  const arr = Array.isArray(issuesRaw) ? issuesRaw : [];

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!isObject(item)) continue;
    const id = asString(item.id) ?? `issue-${i + 1}`;
    if (seenIds.has(id)) continue;
    const start = asInt(item.start);
    const end = asInt(item.end);
    const original = asString(item.original);
    const replacement = asString(item.replacement);
    const category = asString(item.category);
    const explanation = asString(item.explanation) ?? "";
    const confidence = asFloat(item.confidence);

    if (
      start === null ||
      end === null ||
      original === null ||
      replacement === null ||
      category === null
    ) {
      continue;
    }
    if (!VALID_CATEGORIES.has(category)) continue;
    if (start < 0 || end > analyzedText.length || start >= end) continue;
    const slice = analyzedText.slice(start, end);
    if (slice !== original) {
      // Offsets don't match the original text — drop this issue silently.
      continue;
    }
    if (confidence !== null && (confidence < 0 || confidence > 1)) continue;

    seenIds.add(id);
    issues.push({
      id,
      start,
      end,
      original,
      replacement,
      category: category as IssueCategory,
      explanation: explanation.slice(0, 200),
      confidence: confidence ?? 0.5,
    });
    if (issues.length >= 20) break;
  }

  return {
    issues,
    correctedText: asString(parsed.correctedText) ?? undefined,
    textHash: hashText(analyzedText),
  };
}

export interface RewriteResult {
  rewritten: string;
  explanation: string;
}

export function parseRewriteResponse(raw: string): RewriteResult {
  const block = extractJsonBlock(raw);
  const parsed = safeParse(block);
  if (!isObject(parsed)) {
    // Small models (e.g. 2B-class) often ignore the JSON instruction and
    // return the rewritten prose directly. When the response is not JSON
    // at all (safeParse -> null), fall back to the plain text: the side
    // panel always shows the result for review before any Replace, so this
    // is safe and far more useful than a hard failure. A response that IS
    // valid JSON but not an object (e.g. an array) is still rejected.
    if (parsed === null) {
      const plain = raw.trim();
      if (plain.length > 0) {
        return { rewritten: plain, explanation: "model returned plain text (no JSON)" };
      }
    }
    throw { code: "INVALID_AI_RESPONSE", detail: "not an object" };
  }
  // Small models sometimes rename the key even when they do return JSON
  // (observed: "rewritten_statement"). Accept a small set of aliases so a
  // valid rewrite is not discarded over a key-name deviation. Empty strings
  // are skipped so {"rewritten":"", "text":"..."} still resolves.
  let rewritten: string | null = null;
  for (const key of ["rewritten", "rewritten_statement", "rewritten_text", "text", "output"]) {
    const s = asString((parsed as Record<string, unknown>)[key]);
    if (s !== null && s.trim().length > 0) {
      rewritten = s;
      break;
    }
  }
  if (rewritten === null) {
    throw { code: "INVALID_AI_RESPONSE", detail: "rewritten missing" };
  }
  const explanation = asString(parsed.explanation) ?? "";
  return { rewritten, explanation: explanation.slice(0, 240) };
}

/** Escape any string for safe insertion as text content of an HTMLElement. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------------- Tone detection ---------------- */

/** The tone vocabulary the detector prompt allows (keep in sync with
 *  shared/tone.ts DETECTABLE_TONES). */
const VALID_TONES: ReadonlySet<string> = new Set([
  "confident", "friendly", "formal", "informal", "optimistic", "joyful",
  "encouraging", "supportive", "excited", "curious", "hopeful", "proud",
  "grateful", "calm", "assertive", "empathetic", "appreciative",
  "respectful", "neutral", "blunt", "urgent", "serious", "sad",
  "frustrated", "direct", "persuasive",
]);

/**
 * Parse a tone-detection response ({tones:[{tone,score}]}) from the
 * untrusted model. Unknown tone names are dropped, scores clamped to
 * [0,1], duplicates collapsed, output sorted strongest-first and capped
 * at 3. If the model ignored the JSON instruction, any recognized tone
 * words in the plain text are used as a low-confidence fallback.
 */
export function parseToneDetectResponse(raw: string): Array<{ tone: string; score: number }> {
  const block = extractJsonBlock(raw);
  const parsed = safeParse(block);
  const out: Array<{ tone: string; score: number }> = [];
  if (isObject(parsed) && Array.isArray(parsed.tones)) {
    for (const item of parsed.tones.slice(0, 6)) {
      if (!isObject(item)) continue;
      const tone = asString(item.tone)?.trim().toLowerCase();
      if (!tone || !VALID_TONES.has(tone)) continue;
      const score = asFloat(item.score);
      if (score === null || score < 0 || score > 1) continue;
      if (out.some((x) => x.tone === tone)) continue;
      out.push({ tone, score: Math.round(score * 100) / 100 });
      if (out.length >= 3) break;
    }
  }
  if (out.length === 0) {
    // Plain-text fallback: recognized tone words mentioned by the model.
    const lowered = stripFences(raw).toLowerCase();
    for (const tone of VALID_TONES) {
      if (lowered.includes(tone) && !out.some((x) => x.tone === tone)) {
        out.push({ tone, score: 0.4 });
        if (out.length >= 3) break;
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/* ---------------- Synonyms ---------------- */

/**
 * Parse a synonyms response ({synonyms:[...]}) from the untrusted model.
 * Validates: strings, trimmed, deduped, ≤60 chars, ≤3 words each, never
 * equal to the original word. Returns up to 12 synonyms.
 */
export function parseSynonymsResponse(
  raw: string,
  originalWord: string,
): string[] {
  const block = extractJsonBlock(raw);
  const parsed = safeParse(block);
  const out: string[] = [];
  const push = (s: string): void => {
    const v = s.trim().replace(/\s+/g, " ");
    if (!v || v.length > 60) return;
    if (v.split(" ").length > 3) return;
    const lower = v.toLowerCase();
    if (lower === originalWord.trim().toLowerCase()) return;
    if (out.some((x) => x.toLowerCase() === lower)) return;
    out.push(v);
  };
  if (isObject(parsed)) {
    const arr =
      Array.isArray(parsed.synonyms)
        ? parsed.synonyms
        : Array.isArray(parsed.rewritten)
          ? parsed.rewritten
          : null;
    if (arr) {
      for (const item of arr) {
        const s = asString(item);
        if (s !== null) push(s);
        if (out.length >= 12) break;
      }
      return out;
    }
    // Model returned something else — if it returned a single rewritten
    // string with comma-separated words, split it.
    for (const key of ["rewritten", "text", "output"]) {
      const s = asString((parsed as Record<string, unknown>)[key]);
      if (s && s.trim()) {
        for (const piece of s.split(/[,;]/)) {
          push(piece.replace(/^["'\s]+|["'\s.]+$/g, ""));
          if (out.length >= 12) break;
        }
        return out;
      }
    }
    return out;
  }
  // Plain text fallback: comma / newline separated words.
  for (const piece of stripFences(raw).split(/[\n,;]/)) {
    push(piece.replace(/^["'\s]+|["'\s.]+$/g, ""));
    if (out.length >= 12) break;
  }
  return out;
}
