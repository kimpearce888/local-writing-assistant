/**
 * Wrapper around chrome.storage.local with typed getters/setters.
 *
 * Writing content is NEVER persisted here — only settings, the custom
 * dictionary, per-site exclusions, ignored suggestions, and diagnostics.
 *
 * Per the spec (section 20) we explicitly do NOT use chrome.storage.sync.
 */

import {
  DEFAULT_SETTINGS,
  ExtensionSettings,
  NATIVE_HOST_NAME,
  ToneMode,
} from "./types";
import {
  SNIPPET_LIMITS,
  Snippet,
  makeSnippetId,
  sanitizeSnippetInput,
} from "./snippets";

const KEY_SETTINGS = "settings";
const KEY_DICTIONARY = "customDictionary";
const KEY_SNIPPETS = "snippets";
const KEY_PENDING_SNIPPET = "pendingSnippet";
const KEY_EXCLUSIONS = "siteExclusions";
const KEY_IGNORED_WORDS = "ignoredWords";
const KEY_IGNORED_SUGGESTIONS = "ignoredSuggestions";
const KEY_DIAGNOSTICS = "diagnostics";

const TONE_VALUES: ReadonlySet<string> = new Set<ToneMode>([
  "neutral", "professional", "friendly", "formal", "casual", "concise",
  "confident", "anticipatory", "assertive", "compassionate", "constructive",
  "cooperative", "diplomatic", "empathetic", "inspirational", "exciting",
  "engaging", "persuasive", "direct",
]);

const DIALECT_VALUES: ReadonlySet<string> = new Set(["us", "uk", "ca", "au"]);
const AUDIENCE_VALUES: ReadonlySet<string> = new Set(["general", "knowledgeable", "expert"]);
const GOAL_FORMALITY_VALUES: ReadonlySet<string> = new Set(["informal", "neutral", "formal"]);
const DOMAIN_VALUES: ReadonlySet<string> = new Set([
  "general", "academic", "business", "email", "casual", "creative",
]);

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampFloat(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function coerceBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function coerceString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function isValidLmStudioUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Coerce an untrusted partial-settings object (message from the popup,
 * settings-import file) into a safe Partial<ExtensionSettings>:
 * unknown keys are dropped, booleans/numbers are type-checked, numeric
 * fields are clamped to their UI ranges, `tone` must be a known ToneMode,
 * and lmStudioUrl must be a valid http(s) URL. Prevents persisted garbage
 * (e.g. enabled: "yes", temperature: "abc", maxTextSize: -999999) from
 * silently corrupting runtime behavior.
 */
export function validateSettings(
  partial: unknown,
): Partial<ExtensionSettings> {
  if (typeof partial !== "object" || partial === null || Array.isArray(partial)) {
    return {};
  }
  const p = partial as Record<string, unknown>;
  const out: Partial<ExtensionSettings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof ExtensionSettings>) {
    if (!(key in p)) continue;
    const v = p[key as string];
    switch (key) {
      case "enabled":
      case "autoCheck":
      case "inlineSuggestions":
      case "checkSpelling":
      case "checkGrammar":
      case "checkPunctuation":
      case "checkClarity":
      case "checkWordChoice":
      case "showFloatingWidget":
      case "hoverSuggestions":
      case "doubleClickSynonyms":
      case "autoToneDetect":
      case "enableSnippets":
        (out[key] as boolean) = coerceBool(v, DEFAULT_SETTINGS[key]);
        break;
      case "tone":
        if (typeof v === "string" && TONE_VALUES.has(v)) {
          out.tone = v as ToneMode;
        }
        break;
      case "dialect":
        if (typeof v === "string" && DIALECT_VALUES.has(v)) {
          out.dialect = v as ExtensionSettings["dialect"];
        }
        break;
      case "audience":
        if (typeof v === "string" && AUDIENCE_VALUES.has(v)) {
          out.audience = v as ExtensionSettings["audience"];
        }
        break;
      case "formality":
        if (typeof v === "string" && GOAL_FORMALITY_VALUES.has(v)) {
          out.formality = v as ExtensionSettings["formality"];
        }
        break;
      case "domain":
        if (typeof v === "string" && DOMAIN_VALUES.has(v)) {
          out.domain = v as ExtensionSettings["domain"];
        }
        break;
      case "debounceMs":
        out.debounceMs = clampInt(v, 100, 5000, DEFAULT_SETTINGS.debounceMs);
        break;
      case "maxTextSize":
        out.maxTextSize = clampInt(v, 100, 100000, DEFAULT_SETTINGS.maxTextSize);
        break;
      case "maxConcurrent":
        out.maxConcurrent = clampInt(v, 1, 8, DEFAULT_SETTINGS.maxConcurrent);
        break;
      case "minConfidence":
        out.minConfidence = clampFloat(v, 0, 1, DEFAULT_SETTINGS.minConfidence);
        break;
      case "temperature":
        out.temperature = clampFloat(v, 0, 2, DEFAULT_SETTINGS.temperature);
        break;
      case "maxTokens":
        out.maxTokens = clampInt(v, 1, 8192, DEFAULT_SETTINGS.maxTokens);
        break;
      case "requestTimeoutMs":
        out.requestTimeoutMs = clampInt(v, 1000, 120000, DEFAULT_SETTINGS.requestTimeoutMs);
        break;
      case "lmStudioUrl": {
        const s = coerceString(v, DEFAULT_SETTINGS.lmStudioUrl);
        if (isValidLmStudioUrl(s)) out.lmStudioUrl = s;
        break;
      }
      case "model":
        out.model = coerceString(v, DEFAULT_SETTINGS.model).slice(0, 200);
        break;
      case "snippetTriggerPrefix": {
        // 0-3 chars, whitespace-free — it must be typeable as a tight
        // run right before the shortcut.
        const s = coerceString(v, DEFAULT_SETTINGS.snippetTriggerPrefix)
          .slice(0, 3)
          .replace(/\s+/g, "");
        out.snippetTriggerPrefix = s;
        break;
      }
    }
  }
  return out;
}

export async function getSettings(): Promise<ExtensionSettings> {
  const raw = await chrome.storage.local.get(KEY_SETTINGS);
  const partial = (raw[KEY_SETTINGS] ?? {}) as Record<string, unknown>;
  // Validate on read: unknown/stale keys (e.g. fields removed in later
  // versions, or values written before validation existed) are dropped,
  // and every value is coerced to its declared type. This also keeps the
  // settings-export path honest — removed secret fields can never leak
  // back out through getSettings().
  return { ...DEFAULT_SETTINGS, ...validateSettings(partial) };
}

export async function saveSettings(
  settings: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const current = await getSettings();
  const next: ExtensionSettings = { ...current, ...validateSettings(settings) };
  await chrome.storage.local.set({ [KEY_SETTINGS]: next });
  return next;
}

export async function resetSettings(): Promise<ExtensionSettings> {
  await chrome.storage.local.set({ [KEY_SETTINGS]: DEFAULT_SETTINGS });
  return DEFAULT_SETTINGS;
}

/* ---------------- Custom dictionary ---------------- */

export async function getDictionary(): Promise<string[]> {
  const raw = await chrome.storage.local.get(KEY_DICTIONARY);
  return (raw[KEY_DICTIONARY] ?? []) as string[];
}

export async function addWordToDictionary(word: string): Promise<string[]> {
  const w = word.trim();
  if (!w) return getDictionary();
  const list = await getDictionary();
  if (list.includes(w)) return list;
  const next = [...list, w];
  await chrome.storage.local.set({ [KEY_DICTIONARY]: next });
  return next;
}

export async function removeWordFromDictionary(
  word: string,
): Promise<string[]> {
  const list = await getDictionary();
  const next = list.filter((x) => x !== word);
  await chrome.storage.local.set({ [KEY_DICTIONARY]: next });
  return next;
}

export async function setDictionary(words: string[]): Promise<string[]> {
  const cleaned = Array.from(
    new Set(words.map((w) => w.trim()).filter(Boolean)),
  );
  await chrome.storage.local.set({ [KEY_DICTIONARY]: cleaned });
  return cleaned;
}

export async function clearDictionary(): Promise<void> {
  await chrome.storage.local.set({ [KEY_DICTIONARY]: [] });
}

/* ---------------- Snippets (text expansion) ---------------- */

export async function getSnippets(): Promise<Snippet[]> {
  const raw = await chrome.storage.local.get(KEY_SNIPPETS);
  const list = raw[KEY_SNIPPETS];
  if (!Array.isArray(list)) return [];
  // Defensive re-validation on read: entries written by older versions
  // or by hand-edited exports can never poison the matcher.
  const out: Snippet[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const clean = sanitizeSnippetInput({
      shortcut: rec.shortcut,
      content: rec.content,
      label: rec.label,
    });
    if (!clean) continue;
    out.push({
      id: typeof rec.id === "string" ? rec.id : makeSnippetId(),
      ...clean,
      createdAt: typeof rec.createdAt === "number" ? rec.createdAt : Date.now(),
    });
  }
  return out.slice(0, SNIPPET_LIMITS.maxCount);
}

export async function addSnippet(
  shortcut: unknown,
  content: unknown,
  label?: unknown,
): Promise<{ ok: boolean; snippets: Snippet[] }> {
  const clean = sanitizeSnippetInput({ shortcut, content, label });
  const list = await getSnippets();
  if (!clean) return { ok: false, snippets: list };
  // Same shortcut updates the existing entry instead of duplicating.
  const existingIdx = list.findIndex((s) => s.shortcut === clean.shortcut);
  if (existingIdx >= 0) {
    const next = [...list];
    next[existingIdx] = {
      ...list[existingIdx],
      content: clean.content,
      label: clean.label || list[existingIdx].label,
    };
    await chrome.storage.local.set({ [KEY_SNIPPETS]: next });
    return { ok: true, snippets: next };
  }
  if (list.length >= SNIPPET_LIMITS.maxCount) {
    return { ok: false, snippets: list };
  }
  const next = [
    ...list,
    { id: makeSnippetId(), ...clean, createdAt: Date.now() },
  ];
  await chrome.storage.local.set({ [KEY_SNIPPETS]: next });
  return { ok: true, snippets: next };
}

export async function removeSnippet(id: string): Promise<Snippet[]> {
  const list = await getSnippets();
  const next = list.filter((s) => s.id !== id);
  await chrome.storage.local.set({ [KEY_SNIPPETS]: next });
  return next;
}

export async function clearSnippets(): Promise<void> {
  await chrome.storage.local.set({ [KEY_SNIPPETS]: [] });
}

/** Pending snippet handed over from the context-menu
 *  "Save selection as snippet" flow; consumed once by the Options page. */
export async function setPendingSnippet(text: string): Promise<void> {
  await chrome.storage.local.set({
    [KEY_PENDING_SNIPPET]: { text: String(text).slice(0, SNIPPET_LIMITS.maxContentLen), ts: Date.now() },
  });
}

export async function takePendingSnippet(): Promise<string | null> {
  const raw = await chrome.storage.local.get(KEY_PENDING_SNIPPET);
  const pending = raw[KEY_PENDING_SNIPPET] as { text?: unknown } | undefined;
  await chrome.storage.local.remove(KEY_PENDING_SNIPPET);
  if (!pending || typeof pending.text !== "string" || !pending.text.trim()) {
    return null;
  }
  return pending.text;
}

/* ---------------- Site exclusions ---------------- */

export async function getSiteExclusions(): Promise<string[]> {
  const raw = await chrome.storage.local.get(KEY_EXCLUSIONS);
  return (raw[KEY_EXCLUSIONS] ?? []) as string[];
}

export async function addSiteExclusion(host: string): Promise<string[]> {
  const h = host.trim().toLowerCase();
  if (!h) return getSiteExclusions();
  const list = await getSiteExclusions();
  if (list.includes(h)) return list;
  const next = [...list, h];
  await chrome.storage.local.set({ [KEY_EXCLUSIONS]: next });
  return next;
}

export async function removeSiteExclusion(
  host: string,
): Promise<string[]> {
  const list = await getSiteExclusions();
  const next = list.filter((x) => x !== host.trim().toLowerCase());
  await chrome.storage.local.set({ [KEY_EXCLUSIONS]: next });
  return next;
}

export async function isSiteExcluded(host: string): Promise<boolean> {
  const list = await getSiteExclusions();
  return list.includes(host.trim().toLowerCase());
}

/* ---------------- Ignored words / suggestions ---------------- */

export async function getIgnoredWords(): Promise<string[]> {
  const raw = await chrome.storage.local.get(KEY_IGNORED_WORDS);
  return (raw[KEY_IGNORED_WORDS] ?? []) as string[];
}

export async function ignoreWord(word: string): Promise<string[]> {
  const w = word.trim().toLowerCase();
  if (!w) return getIgnoredWords();
  const list = await getIgnoredWords();
  if (list.includes(w)) return list;
  const next = [...list, w];
  await chrome.storage.local.set({ [KEY_IGNORED_WORDS]: next });
  return next;
}

export async function getIgnoredSuggestions(): Promise<
  Array<{ original: string; category: string; ts: number }>
> {
  const raw = await chrome.storage.local.get(KEY_IGNORED_SUGGESTIONS);
  return (raw[KEY_IGNORED_SUGGESTIONS] ?? []) as Array<{
    original: string;
    category: string;
    ts: number;
  }>;
}

export async function ignoreSuggestionOnce(
  original: string,
  category: string,
): Promise<void> {
  const list = await getIgnoredSuggestions();
  // Cap ignored-suggestion memory so storage cannot grow unbounded.
  const capped = list.slice(-200);
  capped.push({
    original,
    category,
    ts: Date.now(),
  });
  await chrome.storage.local.set({ [KEY_IGNORED_SUGGESTIONS]: capped });
}

/* ---------------- Diagnostics (local only) ---------------- */

export interface DiagnosticEntry {
  ts: number;
  level: "info" | "warn" | "error";
  code: string;
  message: string;
}

export async function getDiagnostics(): Promise<DiagnosticEntry[]> {
  const raw = await chrome.storage.local.get(KEY_DIAGNOSTICS);
  return (raw[KEY_DIAGNOSTICS] ?? []) as DiagnosticEntry[];
}

export async function appendDiagnostic(
  entry: Omit<DiagnosticEntry, "ts">,
): Promise<void> {
  const list = await getDiagnostics();
  // Cap to last 500 entries.
  const capped = list.slice(-499);
  capped.push({ ...entry, ts: Date.now() });
  await chrome.storage.local.set({ [KEY_DIAGNOSTICS]: capped });
}

export async function clearDiagnostics(): Promise<void> {
  await chrome.storage.local.set({ [KEY_DIAGNOSTICS]: [] });
}

/* ---------------- Pause state (per-host, in chrome.storage.local) ----------------
 *
 * Pause state must be visible to BOTH the service worker and the
 * content script. Previously this lived in an in-memory Set at
 * module scope — but the SW and CS bundles instantiate separate
 * copies of the module, so the SW's view and the CS's view diverged.
 * The pause button did nothing.
 *
 * We tried chrome.storage.session first (so pause would auto-clear
 * on browser close), but storage.session is NOT readable from
 * content scripts in many Chromium variants and the Playwright
 * test Chromium doesn't expose it at all — the pause button did
 * nothing there too.
 *
 * Final design: store pause state in chrome.storage.local keyed on
 * the host (so pausing slack.com applies to all Slack tabs, which
 * is what users actually want). chrome.storage.local IS readable
 * from content scripts in every Chrome variant. Pause persists
 * across browser restarts by design; the popup exposes an explicit
 * "Resume on this site" action, and the content script re-evaluates
 * pause state live via storage.onChanged.
 */

const PAUSE_KEY_PREFIX = "paused:";

export async function setHostPaused(host: string, paused: boolean): Promise<void> {
  const h = host.trim().toLowerCase();
  if (!h) return;
  const key = PAUSE_KEY_PREFIX + h;
  if (paused) {
    await chrome.storage.local.set({ [key]: true });
  } else {
    await chrome.storage.local.remove(key);
  }
}

export async function isHostPaused(host: string): Promise<boolean> {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  const key = PAUSE_KEY_PREFIX + h;
  const res = await chrome.storage.local.get(key);
  return res[key] === true;
}

export { NATIVE_HOST_NAME };
