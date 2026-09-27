/**
 * Content script entry point.
 *
 * Responsibilities:
 *  - detect focusable editors on the page
 *  - attach an adapter per editor
 *  - debounce analysis on input
 *  - route messages to/from the service worker
 *  - render highlights + suggestion popup
 *  - apply replacements with stale-result protection
 *  - respect per-site exclusions and pause state
 *
 * This file must be defensive: it runs in every page on the web.
 */

import { findEditorAt, getAdapterForElement } from "./adapters";
import { EditorAdapter } from "./adapters/adapter";
import { HighlightLayer } from "./highlight-layer";
import { SuggestionPopup } from "./suggestion-popup";
import { SuggestionEngine, TaggedIssue } from "./suggestion-engine";
import { isTabPaused, isSiteExcluded, getSettings } from "../shared/storage";
import { hashText, normalizeText } from "../shared/text-utils";

const adapters = new Map<HTMLElement, EditorAdapter>();
const highlights = new Map<HTMLElement, HighlightLayer>();
let popup: SuggestionPopup | null = null;
let engine: SuggestionEngine;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let currentEditor: EditorAdapter | null = null;
const issuesByEditor = new Map<string, TaggedIssue[]>();

function isAllowedPage(): boolean {
  if (location.protocol === "chrome:" || location.protocol === "chrome-extension:") {
    return false;
  }
  if (location.protocol === "file:") return true;
  return true;
}

async function shouldRunOnSite(): Promise<boolean> {
  if (!isAllowedPage()) return false;
  if (isTabPaused(_tabId())) return false;
  if (await isSiteExcluded(location.host)) return false;
  return true;
}

function _tabId(): number {
  // best-effort: tab id isn't directly available in content scripts,
  // but background side tracks via the message sender.
  return -1;
}

function registerEditor(el: HTMLElement): void {
  if (adapters.has(el)) return;
  const adapter = getAdapterForElement(el);
  if (!adapter) return;
  adapters.set(el, adapter);
  const layer = new HighlightLayer(el);
  highlights.set(el, layer);
  adapter.onInput(() => {
    scheduleAnalysis(adapter);
  });
  el.addEventListener("focus", () => {
    currentEditor = adapter;
  });
  el.addEventListener("blur", () => {
    // Keep the editor reference so highlights can persist; just debounce.
    scheduleAnalysis(adapter);
  });
}

function scheduleAnalysis(adapter: EditorAdapter): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    engine.analyze(adapter).catch(() => {
      // errors are surfaced through cbs.onAnalyzeError
    });
  }, 700);
}

async function rescanPage(): Promise<void> {
  if (!(await shouldRunOnSite())) {
    for (const layer of highlights.values()) layer.dispose();
    highlights.clear();
    adapters.clear();
    return;
  }
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      "textarea, input[type='text'], input[type='email'], input[type='search'], input[type='url'], input[type='tel'], [contenteditable='true']",
    ),
  );
  for (const el of candidates) registerEditor(el);
}

function onIssueMarkerClick(editorId: string, issueId: string): void {
  const list = issuesByEditor.get(editorId) ?? [];
  const issue = list.find((x) => x.id === issueId);
  if (!issue) return;
  const adapter = [...adapters.values()].find(
    (a) => a.getEditorIdentity() === editorId,
  );
  if (!adapter) return;
  // Stale check: recompute the hash the same way the engine does —
  // normalizeText(getText()) + "|" + tone + "|" + model. If the
  // editor's text has changed since the issue was generated, the
  // hashes won't match and we show a stale-suggestion popup instead.
  void getSettings().then((s) => {
    const currentHash = hashText(
      normalizeText(adapter.getText()) + "|" + s.tone + "|" + s.model,
    );
    if (currentHash !== issue.textHash) {
      showStalePopup();
      return;
    }
    const caret = adapter.getCaretRect(issue.start);
    if (!caret) return;
    if (!popup) {
      popup = new SuggestionPopup({
        onReplace: (i) => handleReplace(i),
        onIgnore: (i) => handleIgnore(i),
        onIgnoreWord: (i) => handleIgnoreWord(i),
        onAddToDictionary: (i) => handleAddToDict(i),
        onClose: () => popup?.hide(),
      });
    }
    popup.show(issue, caret);
  });
}

function showStalePopup(): void {
  if (!popup) {
    popup = new SuggestionPopup({
      onReplace: () => popup?.hide(),
      onIgnore: () => popup?.hide(),
      onIgnoreWord: () => popup?.hide(),
      onAddToDictionary: () => popup?.hide(),
      onClose: () => popup?.hide(),
    });
  }
  // Show a synthetic stale-issue popup.
  popup.show(
    {
      id: "stale",
      start: 0,
      end: 0,
      original: "",
      replacement: "",
      category: "style",
      explanation: "This suggestion is no longer valid because the text changed.",
      confidence: 0,
      editorId: "",
      textHash: "",
      sourceSubstring: "",
    },
    new DOMRect(window.innerWidth / 2 - 120, window.innerHeight / 2, 240, 0),
  );
}

function handleReplace(issue: TaggedIssue): void {
  const adapter = [...adapters.values()].find(
    (a) => a.getEditorIdentity() === issue.editorId,
  );
  if (!adapter) {
    popup?.hide();
    return;
  }
  // Re-validate against current text (section 15, section 16). The
  // hash function must match what the engine uses — otherwise every
  // replacement would falsely fail as stale.
  void getSettings().then((s) => {
    const currentText = adapter.getText();
    const currentHash = hashText(
      normalizeText(currentText) + "|" + s.tone + "|" + s.model,
    );
    if (currentHash !== issue.textHash) {
      popup?.hide();
      showStalePopup();
      return;
    }
    // Verify the source substring still exists at the same offsets.
    const slice = currentText.slice(issue.start, issue.end);
    if (slice !== issue.original || slice !== issue.sourceSubstring) {
      popup?.hide();
      showStalePopup();
      return;
    }
    adapter.replaceRange(issue.start, issue.end, issue.replacement);
    // Remove the issue, re-analyze.
    const list = issuesByEditor.get(issue.editorId) ?? [];
    issuesByEditor.set(
      issue.editorId,
      list.filter((x) => x.id !== issue.id),
    );
    const layer = highlights.get(adapter.el);
    if (layer) layer.render(adapter, issuesByEditor.get(issue.editorId) ?? []);
    popup?.hide();
    // Re-analyze the editor (debounced).
    scheduleAnalysis(adapter);
  });
}

function handleIgnore(issue: TaggedIssue): void {
  engine.ignoreOnce(issue).catch(() => undefined);
  const list = issuesByEditor.get(issue.editorId) ?? [];
  issuesByEditor.set(
    issue.editorId,
    list.filter((x) => x.id !== issue.id),
  );
  if (currentEditor) {
    const layer = highlights.get(currentEditor.el);
    if (layer) layer.render(currentEditor, issuesByEditor.get(issue.editorId) ?? []);
  }
  popup?.hide();
}

function handleIgnoreWord(issue: TaggedIssue): void {
  // Section 25 — ignore this word going forward (storage-capped in storage.ts).
  import("../shared/storage").then((mod) =>
    mod.ignoreWord(issue.original),
  );
  // Also remove this specific issue from the list.
  handleIgnore(issue);
}

function handleAddToDict(issue: TaggedIssue): void {
  import("../shared/storage").then((mod) =>
    mod.addWordToDictionary(issue.original),
  );
  handleIgnore(issue);
}

function handleSelectionForRewrite(): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const anchor = sel.anchorNode as Node | null;
  if (!anchor) return;
  const el = anchor.nodeType === Node.ELEMENT_NODE
    ? (anchor as HTMLElement)
    : anchor.parentElement;
  if (!el) return;
  const editorEl = findEditorAt(el);
  if (!editorEl) return;
  const adapter = getAdapterForElement(editorEl);
  if (!adapter) return;
  currentEditor = adapter;
  chrome.runtime.sendMessage({
    type: "selection-for-rewrite",
    text: sel.toString(),
    editorId: adapter.getEditorIdentity(),
  });
}

/* ---------------- Engine setup ---------------- */

engine = new SuggestionEngine({
  onAnalyzeStart: () => {
    chrome.runtime.sendMessage({ type: "status", state: "checking" }).catch(() => undefined);
  },
  onAnalyzeComplete: (result) => {
    issuesByEditor.set(result.editorId, result.issues);
    const adapter = [...adapters.values()].find(
      (a) => a.getEditorIdentity() === result.editorId,
    );
    if (adapter) {
      const layer = highlights.get(adapter.el);
      if (layer) {
        layer.render(adapter, result.issues);
        layer.onClick((id) => onIssueMarkerClick(result.editorId, id));
      }
    }
    chrome.runtime
      .sendMessage({ type: "status", state: "done", count: result.issues.length })
      .catch(() => undefined);
  },
  onAnalyzeError: (editorId, code, message) => {
    chrome.runtime
      .sendMessage({ type: "status", state: "error", code, message, editorId })
      .catch(() => undefined);
  },
});

/* ---------------- Bootstrap ---------------- */

(async function init() {
  if (!(await shouldRunOnSite())) return;
  await rescanPage();

  // Watch for dynamically added editors.
  const observer = new MutationObserver(() => {
    rescanPage().catch(() => undefined);
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
  });

  // Listen for runtime messages from background / side panel.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "trigger-check") {
      if (currentEditor) engine.analyze(currentEditor);
      reply({ ok: true });
      return true;
    }
    if (msg?.type === "selection-for-rewrite-query") {
      handleSelectionForRewrite();
      reply({ ok: true });
      return true;
    }
    if (msg?.type === "apply-rewrite") {
      const { editorId, start, end, replacement, expectedHash } = msg;
      const adapter = [...adapters.values()].find(
        (a) => a.getEditorIdentity() === editorId,
      );
      if (!adapter) {
        reply({ ok: false, error: "EDITOR_UNSUPPORTED" });
        return true;
      }
      const currentText = adapter.getText();
      const currentHash = hashText(currentText);
      if (currentHash !== expectedHash) {
        reply({ ok: false, error: "STALE_RESULT" });
        return true;
      }
      try {
        adapter.replaceRange(start, end, replacement);
        reply({ ok: true });
      } catch {
        reply({ ok: false, error: "EDITOR_UNSUPPORTED" });
      }
      return true;
    }
    if (msg?.type === "ping") {
      reply({ ok: true });
      return true;
    }
    return false;
  });

  // Rescan on focus events (cheap; lets us lazily attach editors).
  document.addEventListener(
    "focusin",
    (e) => {
      const target = e.target as HTMLElement | null;
      const editorEl = target ? findEditorAt(target) : null;
      if (editorEl) {
        registerEditor(editorEl);
        const adapter = adapters.get(editorEl);
        if (adapter) {
          currentEditor = adapter;
          scheduleAnalysis(adapter);
        }
      }
    },
    true,
  );

  // Disconnect observers when the document is unloaded.
  window.addEventListener("beforeunload", () => {
    observer.disconnect();
    for (const layer of highlights.values()) layer.dispose();
    highlights.clear();
    adapters.clear();
    popup?.hide();
  });
})();
