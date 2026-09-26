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
} from "./types";

const KEY_SETTINGS = "settings";
const KEY_DICTIONARY = "customDictionary";
const KEY_EXCLUSIONS = "siteExclusions";
const KEY_IGNORED_WORDS = "ignoredWords";
const KEY_IGNORED_SUGGESTIONS = "ignoredSuggestions";
const KEY_DIAGNOSTICS = "diagnostics";
const KEY_EXT_ID = "extensionId";

/** Returns a Promise that resolves once storage is ready. */
export async function ensureStorageReady(): Promise<void> {
  // chrome.storage.local is always ready in MV3, but await ensures ordering.
  await chrome.storage.local.get(null);
}

export async function getSettings(): Promise<ExtensionSettings> {
  const raw = await chrome.storage.local.get(KEY_SETTINGS);
  const partial = (raw[KEY_SETTINGS] ?? {}) as Partial<ExtensionSettings>;
  return { ...DEFAULT_SETTINGS, ...partial };
}

export async function saveSettings(
  settings: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const current = await getSettings();
  const next: ExtensionSettings = { ...current, ...settings };
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

/* ---------------- Pause state (per-tab, in-memory only) ---------------- */

const pausedTabs = new Set<number>();

export function setTabPaused(tabId: number, paused: boolean): void {
  if (paused) pausedTabs.add(tabId);
  else pausedTabs.delete(tabId);
}

export function isTabPaused(tabId: number): boolean {
  return pausedTabs.has(tabId);
}

/* ---------------- Cached extension id (set by installer) ---------------- */

export async function getCachedExtensionId(): Promise<string | null> {
  const raw = await chrome.storage.local.get(KEY_EXT_ID);
  return (raw[KEY_EXT_ID] as string) ?? null;
}

export async function setCachedExtensionId(id: string): Promise<void> {
  await chrome.storage.local.set({ [KEY_EXT_ID]: id });
}

export { NATIVE_HOST_NAME };
