/**
 * Adapter for <textarea> and supported <input> types.
 *
 * These elements have plain-text semantics, so we can use selectionStart
 * / selectionEnd / setRangeText — which preserves undo history natively.
 */

import { EditorAdapter } from "./adapter";

export class TextInputAdapter implements EditorAdapter {
  readonly el: HTMLInputElement | HTMLTextAreaElement;

  constructor(el: HTMLInputElement | HTMLTextAreaElement) {
    this.el = el;
  }

  getEditorIdentity(): string {
    return `ti:${this.el.tagName.toLowerCase()}:${this.el.id || this.el.name || ""}:${this.el.dataset.lwaId ?? ""}`;
  }

  isSupported(): boolean {
    if (this.el instanceof HTMLTextAreaElement) return true;
    if (this.el instanceof HTMLInputElement) {
      const t = (this.el.type || "text").toLowerCase();
      return ["text", "search", "email", "url", "tel"].includes(t);
    }
    return false;
  }

  getText(): string {
    return this.el.value ?? "";
  }

  getSelection(): { start: number; end: number } {
    return {
      start: this.el.selectionStart ?? 0,
      end: this.el.selectionEnd ?? 0,
    };
  }

  replaceRange(start: number, end: number, replacement: string): void {
    const len = this.getText().length;
    if (start < 0 || end > len || start > end) return;
    // setRangeText preserves undo history for textarea/input.
    try {
      this.el.focus();
      this.el.setSelectionRange(start, end);
      if (!document.execCommand || !document.execCommand("insertText", false, replacement)) {
        // Fallback: use setRangeText (preserves undo in most browsers).
        this.el.setRangeText(replacement, start, end, "end");
      }
    } catch {
      // Final fallback — direct value manipulation (loses undo, last resort).
      const text = this.getText();
      this.el.value = text.slice(0, start) + replacement + text.slice(end);
      const caret = start + replacement.length;
      this.el.setSelectionRange(caret, caret);
    }
  }

  getCaretRect(offset: number): DOMRect | null {
    // We can't easily measure a char rect inside a textarea, so we return
    // the element's bounding rect and let the popup layer figure out
    // vertical placement.
    return this.el.getBoundingClientRect();
  }

  onInput(cb: () => void): () => void {
    const handler = () => cb();
    this.el.addEventListener("input", handler);
    this.el.addEventListener("change", handler);
    return () => {
      this.el.removeEventListener("input", handler);
      this.el.removeEventListener("change", handler);
    };
  }
}
