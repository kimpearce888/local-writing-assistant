/**
 * Editor adapter interface (section 75).
 *
 * Each adapter wraps a specific kind of editable element and exposes a
 * consistent interface so the rest of the assistant does not need to
 * care whether it's a <textarea>, <input>, or contenteditable.
 */

export interface EditorAdapter {
  /** Element being wrapped. */
  readonly el: HTMLElement;
  /** Stable identity for this editor instance. */
  getEditorIdentity(): string;
  /** True when the editor type is supported by this adapter. */
  isSupported(): boolean;
  /** Get the full text currently in the editor. */
  getText(): string;
  /** Get selection start/end (in UTF-16 code units). */
  getSelection(): { start: number; end: number };
  /** Replace [start,end) with `replacement`. Preserves cursor & history. */
  replaceRange(start: number, end: number, replacement: string): void;
  /** Returns the absolute viewport rect of the character at `offset`. */
  getCaretRect(offset: number): DOMRect | null;
  /** Subscribe to input/change events. Returns an unsubscribe fn. */
  onInput(cb: () => void): () => void;
}

/**
 * Detect a sensitive field that must NEVER be analyzed (section 21).
 */
export function isSensitiveField(el: HTMLElement): boolean {
  if (!(el instanceof HTMLInputElement)) {
    const ae = el.getAttribute("autocomplete") ?? "";
    if (/(password|cc-number|cc-csc|cc-exp|one-time-code|security-code)/i.test(ae)) {
      return true;
    }
    return false;
  }
  const type = (el.type || "").toLowerCase();
  if (type === "password" || type === "hidden") return true;
  const name = (el.name || "").toLowerCase();
  const id = (el.id || "").toLowerCase();
  const placeholder = (el.placeholder || "").toLowerCase();
  const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
  const sensitivePatterns =
    /(password|passwd|pwd|secret|api[-_]?key|access[-_]?token|auth[-_]?token|private[-_]?key|cc[-_]?number|cardnumber|cvc|cvv|csc|security[-_]?code|otp|one[-_]?time[-_]?code|client[-_]?secret)/i;
  return (
    sensitivePatterns.test(name) ||
    sensitivePatterns.test(id) ||
    sensitivePatterns.test(placeholder) ||
    sensitivePatterns.test(auto)
  );
}

/**
 * Detect editors we explicitly refuse to analyze (section 12).
 * Returns true if the element lives inside a known virtual editor
 * (Google Docs canvas, Monaco, CodeMirror) that we cannot safely touch.
 */
export function isUnsupportedEditor(el: HTMLElement): boolean {
  let cur: HTMLElement | null = el;
  while (cur) {
    const cls = cur.className || "";
    if (typeof cls === "string" && /docs-texteventtarget|kix-canvas|monaco-editor|CodeMirror/.test(cls)) {
      return true;
    }
    cur = cur.parentElement;
  }
  return false;
}
