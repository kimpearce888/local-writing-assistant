/**
 * Content script entry point.
 *
 * Responsibilities:
 *  - detect focusable editors on the page
 *  - attach an adapter per editor (and properly detach on cleanup)
 *  - debounce analysis on input (per-editor, not global)
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
import { isSiteExcluded, isHostPaused, getSettings } from "../shared/storage";
import { hashText } from "../shared/text-utils";

interface EditorEntry {
  adapter: EditorAdapter;
  layer: HighlightLayer;
  /** Unsubscribers for adapter.onInput + element focus/blur listeners. */
  detach: () => void;
  /** Per-editor debounce timer so typing in editor A doesn't reset
   *  editor B's pending analysis. */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Unsubscribe for the layer's click handler so we don't stack a new
   *  listener on every re-analysis. */
  unsubscribeClick: (() => void) | null;
}

const editors = new Map<HTMLElement, EditorEntry>();
let popup: SuggestionPopup | null = null;
let engine: SuggestionEngine;
let currentEditor: EditorAdapter | null = null;
const issuesByEditor = new Map<string, TaggedIssue[]>();

function isAllowedPage(): boolean {
  // chrome:// and chrome-extension:// pages are not user content.
  if (location.protocol === "chrome:" || location.protocol === "chrome-extension:") {
    return false;
  }
  return true;
}

async function shouldRunOnSite(): Promise<boolean> {
  if (!isAllowedPage()) return false;
  // Pause state lives in chrome.storage.local (always accessible
  // from content scripts). Keyed on the host so pausing slack.com
  // applies to all Slack tabs. Previously this used an in-memory
  // Set that diverged between SW and CS bundles — the pause
  // button did nothing.
  if (await isHostPaused(location.host)) return false;
  if (await isSiteExcluded(location.host)) return false;
  return true;
}

function registerEditor(el: HTMLElement): void {
  if (editors.has(el)) return;
  const adapter = getAdapterForElement(el);
  if (!adapter) return;
  const layer = new HighlightLayer(el);

  // Adapter input + element focus/blur listeners. We MUST capture the
  // unsubscribe functions and call them on cleanup; otherwise SPAs
  // (Gmail, Slack, Notion) that never do a full page navigation would
  // leak listeners across view switches.
  const inputUnsub = adapter.onInput(() => scheduleAnalysis(adapter));
  const focusUnsub = onFocus(el, () => {
    currentEditor = adapter;
  });
  const blurUnsub = onBlur(el, () => {
    // Keep the editor reference so highlights can persist; just debounce.
    scheduleAnalysis(adapter);
  });

  const entry: EditorEntry = {
    adapter,
    layer,
    detach: () => {
      inputUnsub();
      focusUnsub();
      blurUnsub();
      entry.unsubscribeClick?.();
      entry.unsubscribeClick = null;
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
        entry.debounceTimer = null;
      }
      layer.dispose();
    },
    debounceTimer: null,
    unsubscribeClick: null,
  };
  editors.set(el, entry);
}

/** Helper: add an event listener and return an unsubscribe function. */
function onFocus(el: HTMLElement, cb: () => void): () => void {
  el.addEventListener("focus", cb);
  return () => el.removeEventListener("focus", cb);
}
function onBlur(el: HTMLElement, cb: () => void): () => void {
  el.addEventListener("blur", cb);
  return () => el.removeEventListener("blur", cb);
}

/** Per-editor debounced analysis. The previous global debounce timer
 *  meant that typing in editor A then switching to editor B would
 *  reset A's pending analysis and only ever analyze B. */
function scheduleAnalysis(adapter: EditorAdapter): void {
  let entry: EditorEntry | undefined;
  for (const e of editors.values()) {
    if (e.adapter === adapter) {
      entry = e;
      break;
    }
  }
  if (!entry) return;
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  entry.debounceTimer = setTimeout(() => {
    entry!.debounceTimer = null;
    engine.analyze(adapter).catch(() => {
      // errors are surfaced through cbs.onAnalyzeError
    });
  }, 700);
}

let rescanTimer: ReturnType<typeof setTimeout> | null = null;
/** Debounced rescan: a single MutationObserver event can fire hundreds
 *  of times per second on a SPA like Notion. Without a debounce we'd
 *  run querySelectorAll over the whole document on every mutation,
 *  causing severe jank. */
function scheduleRescan(): void {
  if (rescanTimer) return;
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    rescanPage().catch(() => undefined);
  }, 250);
}

async function rescanPage(): Promise<void> {
  if (!(await shouldRunOnSite())) {
    for (const entry of editors.values()) entry.detach();
    editors.clear();
    return;
  }
  // Match both contenteditable="true" (explicit value) and bare
  // contenteditable / contenteditable="" (boolean attribute — same
  // semantics per HTML spec).
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      "textarea, input[type='text'], input[type='email'], input[type='search'], input[type='url'], input[type='tel'], [contenteditable]",
    ),
  );
  // Remove disposed editors first.
  for (const [el, entry] of editors) {
    if (!el.isConnected) {
      entry.detach();
      editors.delete(el);
    }
  }
  for (const el of candidates) {
    registerEditor(el);
  }
}

function onIssueMarkerClick(editorId: string, issueId: string): void {
  const list = issuesByEditor.get(editorId) ?? [];
  const issue = list.find((x) => x.id === issueId);
  if (!issue) return;
  const entry = [...editors.values()].find(
    (e) => e.adapter.getEditorIdentity() === editorId,
  );
  if (!entry) return;
  const adapter = entry.adapter;
  // Stale check: same hash function as the engine — hash of raw text +
  // "|" + tone + "|" + model. If the editor's text has changed since
  // the issue was generated, the hashes won't match and we show a
  // stale-suggestion popup instead.
  void getSettings().then((s) => {
    const currentHash = hashText(
      adapter.getText() + "|" + s.tone + "|" + s.model,
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
  const entry = [...editors.values()].find(
    (e) => e.adapter.getEditorIdentity() === issue.editorId,
  );
  if (!entry) {
    popup?.hide();
    return;
  }
  const adapter = entry.adapter;
  // Re-validate against current text. The hash function MUST match
  // the engine's hash, otherwise every replacement would falsely fail.
  void getSettings().then((s) => {
    const currentText = adapter.getText();
    const currentHash = hashText(
      currentText + "|" + s.tone + "|" + s.model,
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
    // Remove the issue, re-render, re-analyze.
    const list = issuesByEditor.get(issue.editorId) ?? [];
    issuesByEditor.set(
      issue.editorId,
      list.filter((x) => x.id !== issue.id),
    );
    const layer = editors.get(adapter.el)?.layer;
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
  // Render against the *issue's* editor, not currentEditor. If the user
  // has switched editors since the popup was shown, currentEditor would
  // be a different adapter and we'd update the wrong layer.
  const entry = [...editors.values()].find(
    (e) => e.adapter.getEditorIdentity() === issue.editorId,
  );
  if (entry) {
    entry.layer.render(
      entry.adapter,
      issuesByEditor.get(issue.editorId) ?? [],
    );
  }
  popup?.hide();
}

function handleIgnoreWord(issue: TaggedIssue): void {
  // Section 25 — ignore this word going forward (storage-capped in storage.ts).
  import("../shared/storage").then((mod) =>
    mod.ignoreWord(issue.original),
  );
  handleIgnore(issue);
}

function handleAddToDict(issue: TaggedIssue): void {
  import("../shared/storage").then((mod) =>
    mod.addWordToDictionary(issue.original),
  );
  handleIgnore(issue);
}

/** When the user opens the side panel for a rewrite, we send the
 *  selected text + the editor offsets + a hash of the FULL editor text
 *  so the apply step can verify the editor hasn't changed. Previously
 *  we sent only {text, editorId} and the side panel's Replace button
 *  always failed with "No editor is bound to this rewrite." */
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
  const selOffsets = adapter.getSelection();
  void getSettings().then((s) => {
    const fullText = adapter.getText();
    const expectedHash = hashText(
      fullText + "|" + s.tone + "|" + s.model,
    );
    chrome.runtime.sendMessage({
      type: "selection-for-rewrite",
      text: sel.toString(),
      editorId: adapter.getEditorIdentity(),
      start: selOffsets.start,
      end: selOffsets.end,
      expectedHash,
    }).catch(() => undefined);
  });
}

/* ---------------- Engine setup ---------------- */

engine = new SuggestionEngine({
  onAnalyzeStart: () => {
    chrome.runtime.sendMessage({ type: "status", state: "checking" }).catch(() => undefined);
  },
  onAnalyzeComplete: (result) => {
    issuesByEditor.set(result.editorId, result.issues);
    const entry = [...editors.values()].find(
      (e) => e.adapter.getEditorIdentity() === result.editorId,
    );
    if (entry) {
      // Replace any previous click handler before attaching a new
      // one — HighlightLayer.onClick now removes the previous listener
      // internally, but we still capture the returned unsubscribe so
      // cleanup on dispose is correct.
      entry.unsubscribeClick?.();
      entry.layer.render(entry.adapter, result.issues);
      entry.unsubscribeClick = entry.layer.onClick((id) =>
        onIssueMarkerClick(result.editorId, id),
      );
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

  // Watch for dynamically added editors. Debounced so SPAs that fire
  // hundreds of mutations per second don't cripple the page.
  const observer = new MutationObserver(() => {
    scheduleRescan();
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
      const { editorId, start, end, replacement, expectedHash } = msg as {
        editorId: string;
        start: number;
        end: number;
        replacement: string;
        expectedHash: string;
      };
      const entry = [...editors.values()].find(
        (e) => e.adapter.getEditorIdentity() === editorId,
      );
      if (!entry) {
        reply({ ok: false, error: "EDITOR_UNSUPPORTED" });
        return true;
      }
      const adapter = entry.adapter;
      // Use the SAME hash function as the engine: raw text + "|" + tone
      // + "|" + model. The previous code used hashText(currentText)
      // without tone or model, which never matched the expectedHash
      // computed by the engine.
      getSettings()
        .then((s) => {
          const currentText = adapter.getText();
          const currentHash = hashText(
            currentText + "|" + s.tone + "|" + s.model,
          );
          if (currentHash !== expectedHash) {
            reply({ ok: false, error: "STALE_RESULT" });
            return;
          }
          try {
            adapter.replaceRange(start, end, replacement);
            reply({ ok: true });
          } catch {
            reply({ ok: false, error: "EDITOR_UNSUPPORTED" });
          }
        })
        .catch(() => reply({ ok: false, error: "EDITOR_UNSUPPORTED" }));
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
        const entry = editors.get(editorEl);
        if (entry) {
          currentEditor = entry.adapter;
          scheduleAnalysis(entry.adapter);
        }
      }
    },
    true,
  );

  // Disconnect observers + detach editors when the document is unloaded.
  // SPA route changes (pushState/replaceState) don't fire beforeunload,
  // but the focusin listener + observer.disconnect() on actual unload
  // is the best we can do without intercepting History API.
  window.addEventListener("beforeunload", () => {
    observer.disconnect();
    for (const entry of editors.values()) entry.detach();
    editors.clear();
    popup?.hide();
  });
})();
