/**
 * Adapter registry. Picks the right adapter for a given element.
 */

import { EditorAdapter, isSensitiveField, isUnsupportedEditor } from "./adapter";
import { TextInputAdapter } from "./text-input";
import { ContentEditableAdapter } from "./content-editable";

let _lwaCounter = 0;

function ensureStableIdentity(el: HTMLElement): void {
  if (!el.dataset.lwaId) {
    el.dataset.lwaId = `lwa-${Date.now().toString(36)}-${(_lwaCounter++).toString(36)}`;
  }
}

export function getAdapterForElement(
  el: HTMLElement | null,
): EditorAdapter | null {
  if (!el) return null;
  if (isSensitiveField(el)) return null;
  if (isUnsupportedEditor(el)) return null;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const adapter = new TextInputAdapter(el);
    if (!adapter.isSupported()) return null;
    ensureStableIdentity(el);
    return adapter;
  }
  if (el instanceof HTMLElement && el.getAttribute("contenteditable") === "true") {
    const adapter = new ContentEditableAdapter(el);
    if (!adapter.isSupported()) return null;
    ensureStableIdentity(el);
    return adapter;
  }
  return null;
}

export function findEditorAt(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el;
  while (cur) {
    if (cur.getAttribute?.("contenteditable") === "true") return cur;
    if (cur instanceof HTMLTextAreaElement) return cur;
    if (cur instanceof HTMLInputElement) {
      const t = (cur.type || "text").toLowerCase();
      if (["text", "search", "email", "url", "tel"].includes(t)) return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

export type { EditorAdapter };
