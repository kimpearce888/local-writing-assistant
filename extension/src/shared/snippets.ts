/**
 * Snippets (text expansion) — Grammarly parity, implemented locally.
 *
 * A snippet maps a short shortcut (e.g. "sig") to a longer text (e.g. a
 * full signature block). When the typed text immediately before the caret
 * ends with `triggerPrefix + shortcut`, the content script (or side panel
 * editor) replaces it with the snippet content.
 *
 * This module is PURE (no chrome.* APIs, no DOM) so the matcher can be
 * unit-tested in isolation and reused by the content script, the side
 * panel editor, and storage validation.
 */

/** Limits shared by storage writes and UI validation. */
export const SNIPPET_LIMITS = {
  /** Maximum number of stored snippets (storage-bloat guard). */
  maxCount: 100,
  /** Maximum shortcut length after normalization. */
  maxShortcutLen: 32,
  /** Maximum expanded content length. */
  maxContentLen: 5000,
  /** Maximum optional display-label length. */
  maxLabelLen: 100,
} as const;

export interface Snippet {
  /** Stable id (uuid-ish, generated at write time). */
  id: string;
  /** Lowercase, whitespace-free trigger word (without the prefix). */
  shortcut: string;
  /** Text the shortcut expands to. */
  content: string;
  /** Optional human label shown in the Options list. */
  label: string;
  createdAt: number;
}

/** Raw, untrusted snippet input (Options form, import, context menu). */
export interface RawSnippetInput {
  shortcut: unknown;
  content: unknown;
  label?: unknown;
}

/**
 * Normalize a shortcut: trim, lowercase, strip ALL whitespace, collapse
 * to the allowed charset. Returns "" when nothing usable remains.
 *
 * A shortcut must not contain whitespace (it must be typeable as one
 * unbroken run) — any inner whitespace invalidates it.
 */
export function normalizeShortcut(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const stripped = raw.trim().toLowerCase().replace(/\s+/g, "");
  return stripped.slice(0, SNIPPET_LIMITS.maxShortcutLen);
}

/**
 * Sanitize untrusted snippet input. Returns null when the pair is not
 * usable (empty shortcut/content, whitespace inside shortcut, over
 * limits). This is the single gate every storage write goes through —
 * mirrors validateSettings() in storage.ts.
 */
export function sanitizeSnippetInput(
  raw: RawSnippetInput,
): Pick<Snippet, "shortcut" | "content" | "label"> | null {
  const shortcut = normalizeShortcut(raw.shortcut);
  if (!shortcut) return null;
  if (typeof raw.content !== "string") return null;
  const content = raw.content.slice(0, SNIPPET_LIMITS.maxContentLen);
  if (!content.trim()) return null;
  const label =
    typeof raw.label === "string"
      ? raw.label.trim().slice(0, SNIPPET_LIMITS.maxLabelLen)
      : "";
  return { shortcut, content, label };
}

/** Generate a reasonably unique id without pulling in a uuid dep. */
export function makeSnippetId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `snip-${Date.now().toString(36)}-${rand}`;
}

/** Word-boundary class: characters that may precede a snippet trigger. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

export interface SnippetMatch {
  snippet: Snippet;
  /** Start of the matched `prefix + shortcut` run in the source text. */
  start: number;
  /** End of the matched run (== textBeforeCaret.length when matched). */
  end: number;
}

/**
 * Find the snippet that should expand at the caret.
 *
 * Matching rules (deliberately strict to avoid false positives):
 *  1. The text before the caret must END with `prefix + shortcut`
 *     (case-insensitive comparison against the normalized shortcut).
 *  2. The character BEFORE the prefix must be a word boundary: start of
 *     text, whitespace, or punctuation — "abc;sig" never expands, but
 *     "abc ;sig" and "(;sig" do.
 *  3. Longest shortcut wins when several match (e.g. "sig" vs "sig2").
 *
 * `textBeforeCaret` is expected to be the editor text up to the caret
 * (collapsed selection). `triggerPrefix` may be "" — then the boundary
 * check applies to the shortcut's first character instead.
 */
export function findSnippetMatch(
  textBeforeCaret: string,
  snippets: readonly Snippet[],
  triggerPrefix: string,
): SnippetMatch | null {
  if (!textBeforeCaret || snippets.length === 0) return null;
  const prefix = typeof triggerPrefix === "string" ? triggerPrefix : ";";
  const lower = textBeforeCaret.toLowerCase();

  // Longest-first so overlapping shortcuts resolve predictably.
  const ordered = [...snippets].sort(
    (a, b) => b.shortcut.length - a.shortcut.length,
  );

  for (const snip of ordered) {
    const full = (prefix + snip.shortcut).toLowerCase();
    if (full.length === 0) continue;
    if (!lower.endsWith(full)) continue;

    const start = lower.length - full.length;
    // Word boundary before the whole trigger run. When the prefix is
    // empty, the boundary applies directly to the shortcut itself.
    if (start > 0) {
      const prevChar = textBeforeCaret[start - 1];
      if (prevChar && WORD_CHAR.test(prevChar)) continue;
    }
    // The matched run must be the actual tail of the original text
    // (endsWith on the lowercased copy already guarantees this, but the
    // explicit check keeps the contract obvious for future edits).
    if (start + full.length !== textBeforeCaret.length) continue;
    return { snippet: snip, start, end: textBeforeCaret.length };
  }
  return null;
}
