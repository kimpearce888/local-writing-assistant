/**
 * Adapter for `contenteditable="true"` elements.
 *
 * We MUST NOT blindly manipulate the DOM of a rich editor (section 11).
 * This adapter:
 *  - reads text via the Selection API
 *  - replaces ranges using `document.execCommand('insertText')` when
 *    available (preserves undo history in most engines)
 *  - falls back to Range.deleteContents() + Range.insertNode() with a
 *    plain Text node otherwise
 *  - never replaces entire DOM trees
 *
 * For elements that are not actually editable (or whose host framework
 * exposes a virtual surface we cannot safely touch), `isSupported()`
 * returns false and the assistant skips them.
 */

import { EditorAdapter } from "./adapter";

export class ContentEditableAdapter implements EditorAdapter {
  readonly el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  getEditorIdentity(): string {
    return `ce:${this.el.tagName.toLowerCase()}:${this.el.id || ""}:${this.el.dataset.lwaId ?? ""}`;
  }

  isSupported(): boolean {
    if (this.el.getAttribute("contenteditable") !== "true") return false;
    // Reject elements inside virtual editor surfaces — they manage their own state.
    let cur: HTMLElement | null = this.el;
    while (cur) {
      const cls = typeof cur.className === "string" ? cur.className : "";
      if (/docs-texteventtarget|kix-canvas|monaco-editor|CodeMirror/.test(cls)) {
        return false;
      }
      cur = cur.parentElement;
    }
    return true;
  }

  getText(): string {
    // Walk every Text node and concatenate .data. This MUST match
    // the walk done by _textOffsetToRange below — otherwise the
    // offsets the LLM returns (computed against the string we sent
    // it) would not line up with the offsets we pass to
    // _textOffsetToRange at apply time, and the replacement would
    // land on the wrong characters.
    //
    // Previously this returned el.innerText, which is
    // layout-dependent (collapses whitespace, returns "" for
    // display:none) and uses different semantics than
    // TreeWalker.nextNode().data — so any multi-block contenteditable
    // (Gmail compose, Outlook web, Slack message input) produced
    // wrong offsets and silent failures.
    const doc = this.el.ownerDocument;
    const walker = doc.createTreeWalker(this.el, NodeFilter.SHOW_TEXT, {
      acceptNode: () => NodeFilter.FILTER_ACCEPT,
    });
    let out = "";
    let node: Text | null = walker.nextNode() as Text | null;
    while (node) {
      out += node.data;
      node = walker.nextNode() as Text | null;
    }
    return out;
  }

  getSelection(): { start: number; end: number } {
    const sel = this.el.ownerDocument.getSelection();
    if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
    const range = sel.getRangeAt(0);
    if (!this.el.contains(range.startContainer)) return { start: 0, end: 0 };
    const preRange = range.cloneRange();
    preRange.selectNodeContents(this.el);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const end = start + range.toString().length;
    return { start, end };
  }

  /**
   * Replace [start,end) in the plain-text view of the element with the
   * given replacement string. We compute a fresh Range over the text
   * content using a TreeWalker — this avoids clobbering inline formatting
   * nodes outside the replaced span.
   */
  replaceRange(start: number, end: number, replacement: string): void {
    if (start < 0 || end < start) return;
    const range = this._textOffsetToRange(start, end);
    if (!range) return;
    this.el.focus();
    const sel = this.el.ownerDocument.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // Prefer execCommand for undo history.
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, replacement);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      range.deleteContents();
      range.insertNode(document.createTextNode(replacement));
      range.collapse(false);
    }
  }

  getCaretRect(offset: number): DOMRect | null {
    const range = this._textOffsetToRange(offset, offset);
    if (!range) return null;
    const rects = range.getClientRects();
    if (rects.length > 0) return rects[0];
    return this.el.getBoundingClientRect();
  }

  onInput(cb: () => void): () => void {
    const handler = () => cb();
    this.el.addEventListener("input", handler);
    return () => this.el.removeEventListener("input", handler);
  }

  /**
   * Build a Range covering the text between `start` and `end` (in
   * code-unit length, as computed by Node.textContent length).
   *
   * Returns null if the offsets fall outside the element's text content.
   */
  private _textOffsetToRange(start: number, end: number): Range | null {
    const doc = this.el.ownerDocument;
    const walker = doc.createTreeWalker(this.el, NodeFilter.SHOW_TEXT, {
      acceptNode: () => NodeFilter.FILTER_ACCEPT,
    });
    let consumed = 0;
    let startNode: Text | null = null;
    let startOffsetInNode = 0;
    let endNode: Text | null = null;
    let endOffsetInNode = 0;
    let node: Text | null = walker.nextNode() as Text | null;
    while (node) {
      const len = node.data.length;
      const nextConsumed = consumed + len;
      if (!startNode && start <= nextConsumed) {
        startNode = node;
        startOffsetInNode = Math.max(0, start - consumed);
      }
      if (!endNode && end <= nextConsumed) {
        endNode = node;
        endOffsetInNode = Math.max(0, end - consumed);
        break;
      }
      consumed = nextConsumed;
      node = walker.nextNode() as Text | null;
    }
    if (!startNode) return null;
    if (!endNode) {
      endNode = startNode;
      endOffsetInNode = startOffsetInNode;
    }
    const range = doc.createRange();
    try {
      range.setStart(startNode, startOffsetInNode);
      range.setEnd(endNode, endOffsetInNode);
      return range;
    } catch {
      return null;
    }
  }
}
