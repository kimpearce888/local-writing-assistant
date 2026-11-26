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
import { FloatingWidget } from "./floating-widget";
import { HighlightLayer } from "./highlight-layer";
import { SuggestionPopup } from "./suggestion-popup";
import { SuggestionEngine, TaggedIssue } from "./suggestion-engine";
import { sendNativeViaRelay } from "./relay";
import { SynonymsCard, requestSynonyms } from "./synonyms";
import {
  appendDiagnostic,
  isSiteExcluded,
  isHostPaused,
  getSettings,
} from "../shared/storage";
import { computeTextStats } from "../shared/analysis";
import { hashText } from "../shared/text-utils";
import { t } from "../shared/i18n";
import { createPerKeyDebouncer } from "../shared/debounce";
import { computeScoreBreakdown } from "../shared/score";
import { detectTone } from "../shared/tone";
import {
  ExtensionSettings,
  ScoreBreakdown,
  TextStats,
  ToneReading,
} from "../shared/types";

interface EditorEntry {
  adapter: EditorAdapter;
  layer: HighlightLayer;
  /** Unsubscribers for adapter.onInput + element focus/blur listeners. */
  detach: () => void;
  /** Unsubscribe for the layer's click handler so we don't stack a new
   *  listener on every re-analysis. */
  unsubscribeClick: (() => void) | null;
  /** Hover wiring (task 3-a) — same lifetime contract as
   *  unsubscribeClick: replaced on every re-analysis, cleared on detach. */
  unsubscribeHover: (() => void) | null;
  unsubscribeHoverEnd: (() => void) | null;
}

const editors = new Map<HTMLElement, EditorEntry>();
let popup: SuggestionPopup | null = null;
let engine: SuggestionEngine;
let currentEditor: EditorAdapter | null = null;
const issuesByEditor = new Map<string, TaggedIssue[]>();
/** Latest tone readings per editor (widget chip + side panel broadcast). */
const tonesByEditor = new Map<string, ToneReading[]>();
/** Latest locally computed text stats per editor. */
const lastStatsByEditor = new Map<string, TextStats>();
/** Latest score breakdown per editor (widget tooltip). */
const lastScoreByEditor = new Map<string, ScoreBreakdown>();
let widget: FloatingWidget | null = null;
let synonymsCard: SynonymsCard | null = null;
/** Auto tone detection runs on its own slower debounce, independent of
 *  the analysis debouncer — a tone round trip is expensive. */
const toneDebouncer = createPerKeyDebouncer(() => 2500);
/** Single shared timer for hover show/hide so a new hover event always
 *  supersedes a pending hide (and vice versa). */
let hoverTimer: number | undefined;

/** Cache of the validated settings, refreshed at init and on every
 *  chrome.storage.onChanged("settings") event. The debounce path needs
 *  debounceMs SYNCHRONOUSLY — awaiting getSettings() inside the input
 *  handler is exactly what allowed the stale-timer bug to kill inline
 *  analysis (the async gap raced the "already scheduled?" check). */
let settingsCache: ExtensionSettings | null = null;

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

/* ---------------- Tone relay + floating widget (task 3-a) ---------------- */

/** Transport shape accepted by shared/detectTone (RelayLike). */
type ToneRelay = (
  command: string,
  payload: unknown,
  timeoutMs: number,
) => Promise<{ ok: boolean; errorCode?: string; error?: string; data?: unknown }>;

/** Content scripts cannot reach the native host directly — tone calls are
 *  forwarded through the service worker's "native-bridge-call" handler. */
const relayForTone: ToneRelay = (command, payload, timeoutMs) =>
  sendNativeViaRelay(command, payload, timeoutMs);

function runToneDetection(adapter: EditorAdapter): void {
  const text = adapter.getText();
  // Tone on a two-word chat message is noise — gate like the widget chip.
  if (text.trim().length < 150) {
    widget?.setTones([]);
    return;
  }
  detectTone(text, relayForTone)
    .then((tones) => {
      tonesByEditor.set(adapter.getEditorIdentity(), tones);
      widget?.setTones(tones);
      // Re-assert the score too — setTones rebuilds the widget tooltip
      // and the two states render together.
      if (widget) {
        widget.setScore(
          lastScoreByEditor.get(adapter.getEditorIdentity()) ?? null,
        );
      }
    })
    .catch(() => undefined);
}

/** Lazily create the singleton floating widget with its menu callbacks. */
function ensureWidget(): FloatingWidget {
  if (!widget) {
    widget = new FloatingWidget({
      onOpenPanel: () => {
        chrome.runtime
          .sendMessage({ type: "open-side-panel" })
          .catch(() => undefined);
      },
      onCheckNow: () => {
        if (currentEditor) {
          void engine.analyze(currentEditor).catch(() => undefined);
        }
      },
      onDetectTone: () => {
        if (currentEditor) runToneDetection(currentEditor);
      },
      onOpenSettings: () => {
        chrome.runtime
          .sendMessage({ type: "open-options" })
          .catch(() => undefined);
      },
    });
  }
  return widget;
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
    // Dock the floating widget unless the user turned it off.
    if (settingsCache?.showFloatingWidget !== false) {
      ensureWidget().attach(adapter);
      widget?.setTones(tonesByEditor.get(adapter.getEditorIdentity()) ?? []);
    }
  });
  const blurUnsub = onBlur(el, () => {
    // Keep the editor reference so highlights can persist; just debounce.
    scheduleAnalysis(adapter);
    // Hide the widget AFTER scheduling the analysis — issues and
    // highlights stay alive while the widget is only visually hidden.
    widget?.hide();
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
      entry.unsubscribeHover?.();
      entry.unsubscribeHover = null;
      entry.unsubscribeHoverEnd?.();
      entry.unsubscribeHoverEnd = null;
      debouncer.cancel(adapter.getEditorIdentity());
      layer.dispose();
    },
    unsubscribeClick: null,
    unsubscribeHover: null,
    unsubscribeHoverEnd: null,
  };
  editors.set(el, entry);

  // If the element is ALREADY focused when we register it (page loaded
  // with focus on the editor, or a script/test focused it before this
  // content script ran), no future focus event will ever fire — so
  // treat registration as the focus event: mark it current and kick
  // off analysis. Without this, an editor that was focused before the
  // extension attached would never be analyzed until the user clicked
  // into it a second time.
  if (el === document.activeElement) {
    currentEditor = adapter;
    scheduleAnalysis(adapter);
  }
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

/* ---------------- Per-editor analysis debouncer ----------------
 *
 * Per-editor (per-key) debounce so typing in editor A doesn't reset
 * editor B's pending analysis, and every keystroke reliably re-schedules
 * the pending run (shared/debounce.ts documents the stale-timer bug
 * this replaces — it silently killed inline analysis after the first
 * burst of keystrokes, which is why highlights "never showed while
 * writing").
 *
 * The delay honors the user's `debounceMs` setting (100–5000,
 * validated/clamped by storage.ts) via the synchronous settings cache;
 * 700 is the fallback before the cache is populated. */
const debouncer = createPerKeyDebouncer(() => settingsCache?.debounceMs ?? 700);

function scheduleAnalysis(adapter: EditorAdapter): void {
  let registered = false;
  for (const e of editors.values()) {
    if (e.adapter === adapter) {
      registered = true;
      break;
    }
  }
  if (!registered) return;
  debouncer.schedule(adapter.getEditorIdentity(), () => {
    void engine.analyze(adapter).catch(() => {
      // errors are surfaced through cbs.onAnalyzeError
    });
  });
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
    widget?.hide();
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
  showSuggestionForIssue(editorId, issueId);
}

/** Shared by the layer's click handler AND the hover-suggestion timer.
 *  Skips re-showing when the popup already displays the same issue —
 *  hover events re-fire constantly and rebuilding the popup every time
 *  would make it flicker. */
function showSuggestionForIssue(editorId: string, issueId: string): void {
  if (popup?.isShowing(issueId)) return;
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
      explanation: t("suggestionStale"),
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

/** Send a selection to the side panel together with the editor offsets
 *  + a hash of the FULL editor text so the apply step can verify the
 *  editor hasn't changed. (Previously we sent only {text, editorId} and
 *  the side panel's Replace button always failed with "No editor is
 *  bound to this rewrite.") */
function pushRewriteSelection(
  adapter: EditorAdapter,
  text: string,
  start: number,
  end: number,
): void {
  currentEditor = adapter;
  void getSettings().then((s) => {
    const fullText = adapter.getText();
    const expectedHash = hashText(fullText + "|" + s.tone + "|" + s.model);
    chrome.runtime.sendMessage({
      type: "selection-for-rewrite",
      text,
      editorId: adapter.getEditorIdentity(),
      start,
      end,
      expectedHash,
    }).catch(() => undefined);
  });
}

/** Compute the current rewrite selection, or null when there is nothing
 *  to send.
 *
 * `fallbackToFullEditor` (explicit queries only — side panel open /
 *  keyboard shortcut) makes a focused text field that has content but no
 *  explicit selection send its FULL contents, so the "Selected text" box
 *  shows what the user is working on instead of staying empty. */
function getRewriteSelection(fallbackToFullEditor: boolean): {
  adapter: EditorAdapter;
  text: string;
  start: number;
  end: number;
} | null {
  // Case 1: selection inside a form control (textarea / input). Chrome
  // does NOT reflect <input>/<textarea> selections in
  // window.getSelection(), so read them from the element's own
  // selectionStart/selectionEnd via the adapter instead.
  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement
  ) {
    const adapter = getAdapterForElement(findEditorAt(active));
    if (adapter) {
      const off = adapter.getSelection();
      const value = adapter.getText();
      if (off.end > off.start && value.length > 0) {
        return {
          adapter,
          text: value.slice(off.start, off.end),
          start: off.start,
          end: off.end,
        };
      }
      if (fallbackToFullEditor && value.trim().length > 0) {
        return { adapter, text: value, start: 0, end: value.length };
      }
    }
  }

  // Case 2: normal DOM selection (body text / contenteditable).
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const anchor = sel.anchorNode as Node | null;
  if (!anchor) return null;
  const el = anchor.nodeType === Node.ELEMENT_NODE
    ? (anchor as HTMLElement)
    : anchor.parentElement;
  const adapter = getAdapterForElement(findEditorAt(el));
  if (!adapter) return null;
  const off = adapter.getSelection();
  return { adapter, text: sel.toString(), start: off.start, end: off.end };
}

function handleSelectionForRewrite(fallbackToFullEditor = false): void {
  const s = getRewriteSelection(fallbackToFullEditor);
  if (s) pushRewriteSelection(s.adapter, s.text, s.start, s.end);
}

/* ---------------- Engine setup ---------------- */

engine = new SuggestionEngine({
  onAnalyzeStart: () => {
    widget?.setChecking(true);
    chrome.runtime.sendMessage({ type: "status", state: "checking" }).catch(() => undefined);
  },
  onAnalyzeComplete: (result) => {
    issuesByEditor.set(result.editorId, result.issues);
    const entry = [...editors.values()].find(
      (e) => e.adapter.getEditorIdentity() === result.editorId,
    );
    // Local insights (stats + score) are computed on EVERY completion —
    // both are pure functions, cost nothing, and feed the floating
    // widget plus the side-panel dashboard broadcast below.
    if (entry) {
      const text = entry.adapter.getText();
      const stats = computeTextStats(text);
      const score = computeScoreBreakdown(text, result.issues);
      lastStatsByEditor.set(result.editorId, stats);
      lastScoreByEditor.set(result.editorId, score);
      widget?.setIssues(result.issues.length);
      widget?.setScore(score);
      widget?.setChecking(false);
      // Fire-and-forget broadcast for the side panel / popup dashboards.
      chrome.runtime
        .sendMessage({
          type: "insights-update",
          editorId: result.editorId,
          stats,
          score,
          tones: tonesByEditor.get(result.editorId) ?? [],
          issueCount: result.issues.length,
        })
        .catch(() => undefined);
      // Auto tone detection on its own (slower) debounce. Cancel first so
      // rapid successive analyses never stack tone requests.
      if (settingsCache?.autoToneDetect !== false) {
        toneDebouncer.cancel(result.editorId);
        toneDebouncer.schedule(result.editorId, () =>
          runToneDetection(entry.adapter),
        );
      }
    } else {
      widget?.setChecking(false);
    }
    // The inlineSuggestions setting gates marker rendering only — the
    // status/popup plumbing still runs so the toolbar state stays honest.
    void getSettings().then((s) => {
      if (!s.inlineSuggestions) return;
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
        // Hover suggestions (task 3-a): same replace-first wiring as the
        // click handler, with short delays so a mouse sweep across many
        // markers doesn't pop a card for every one it crosses. The shared
        // timer means a new hover always supersedes a pending hide.
        entry.unsubscribeHover?.();
        entry.unsubscribeHoverEnd?.();
        entry.unsubscribeHover = null;
        entry.unsubscribeHoverEnd = null;
        if (settingsCache?.hoverSuggestions !== false) {
          entry.unsubscribeHover = entry.layer.onHover((id) => {
            window.clearTimeout(hoverTimer);
            hoverTimer = window.setTimeout(
              () => showSuggestionForIssue(result.editorId, id),
              350,
            );
          });
          entry.unsubscribeHoverEnd = entry.layer.onHoverEnd(() => {
            window.clearTimeout(hoverTimer);
            hoverTimer = window.setTimeout(() => popup?.hide(), 400);
          });
        }
      }
    });
    chrome.runtime
      .sendMessage({ type: "status", state: "done", count: result.issues.length })
      .catch(() => undefined);
  },
  onAnalyzeError: (editorId, code, message) => {
    // Stop the widget spinner even when the failing editor is gone.
    widget?.setChecking(false);
    // Persist a local diagnostics entry so the options page's
    // "Recent diagnostics" list reflects real analysis failures
    // (capped in storage.ts — never contains user text).
    void appendDiagnostic({ level: "error", code, message }).catch(() => undefined);
    chrome.runtime
      .sendMessage({ type: "status", state: "error", code, message, editorId })
      .catch(() => undefined);
  },
});

/* ---------------- Bootstrap ---------------- */

(async function init() {
  // Populate the synchronous settings cache BEFORE attaching editors —
  // the first keystroke already needs debounceMs.
  settingsCache = await getSettings().catch(() => null);
  if (!(await shouldRunOnSite())) return;
  await rescanPage();

  // Keep the side panel's "Selected text" box in sync when the user
  // selects text AFTER the panel is open (the panel only queries once,
  // on open). Only real, non-collapsed selections are pushed — plain
  // typing must not wipe a rewrite result that is on screen.
  let selPushTimer: number | undefined;
  const scheduleSelectionPush = (): void => {
    window.clearTimeout(selPushTimer);
    selPushTimer = window.setTimeout(
      () => handleSelectionForRewrite(false),
      150,
    );
  };
  document.addEventListener("mouseup", scheduleSelectionPush, true);
  document.addEventListener("keyup", scheduleSelectionPush, true);

  // Watch for dynamically added editors. Debounced so SPAs that fire
  // hundreds of mutations per second don't cripple the page.
  // Mutation batches that contain ONLY the extension's own injected DOM
  // (every element we create carries a data-lwa-* attribute) are skipped:
  // re-scanning after our own highlight/popup writes caused pointless
  // extra work on heavy pages while the user was typing.
  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((m) => {
      const nodes = [...m.addedNodes, ...m.removedNodes];
      return nodes.some((n) => {
        if (!(n instanceof HTMLElement)) return true; // text nodes etc.
        return !hasLwaMarker(n) &&
          !n.querySelector("[data-lwa-popup], [data-lwa-highlight]") &&
          !isInsideLwa(n);
      });
    });
    if (relevant) scheduleRescan();
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
      // Explicit query (side panel just opened / shortcut pressed): fall
      // back to the focused field's full text so a user who pasted a
      // draft into a form and never selected it still sees their text.
      handleSelectionForRewrite(true);
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

  // Re-evaluate pause / exclusion state live. Without this, resuming a
  // paused site required a full page reload because the content script
  // only consulted chrome.storage.local at boot.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    // Keep the synchronous settings cache (debounceMs, inlineSuggestions,
    // …) in step with user edits made in the options page.
    if (Object.prototype.hasOwnProperty.call(changes, "settings")) {
      void getSettings()
        .then((s) => {
          settingsCache = s;
          // Enforce widget visibility live (task 3-a): turning the widget
          // off in the options page must tear it down immediately, not on
          // next focus. Turning it back on re-docks on the next focus.
          if (s.showFloatingWidget === false && widget) {
            widget.dispose();
            widget = null;
          }
        })
        .catch(() => undefined);
    }
    const pauseKey = "paused:" + location.host;
    if (!Object.prototype.hasOwnProperty.call(changes, pauseKey) &&
        !Object.prototype.hasOwnProperty.call(changes, "siteExclusions")) {
      return;
    }
    void (async () => {
      if (await shouldRunOnSite()) {
        await rescanPage();
      } else {
        for (const entry of editors.values()) entry.detach();
        editors.clear();
        popup?.hide();
        widget?.hide();
      }
    })();
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

  // Double-click thesaurus (Grammarly parity, task 3-a). Capture listener
  // so it runs before site handlers can interfere; the setTimeout(0) lets
  // the browser finish selecting the double-clicked word before we read
  // the adapter's selection.
  document.addEventListener(
    "dblclick",
    () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        const editorEl = active instanceof HTMLElement ? findEditorAt(active) : null;
        const entry = editorEl ? editors.get(editorEl) : undefined;
        if (!entry) return;
        if (settingsCache?.doubleClickSynonyms === false) return;
        const adapter = entry.adapter;
        const sel = adapter.getSelection();
        const text = adapter.getText();
        const word = text.slice(sel.start, sel.end).trim();
        // Single words only — Latin + Latin-extended letters, apostrophes
        // and hyphens, min 2 chars. Anything else isn't thesaurus material.
        if (!/^[A-Za-z\u00C0-\u024F'’-]{2,}$/.test(word)) return;
        const caret = adapter.getCaretRect(sel.start);
        if (!caret) return;
        const context = text.slice(Math.max(0, sel.start - 80), sel.end + 80);
        void requestSynonyms(word, context)
          .then((list) => {
            if (!list.length) return;
            if (!synonymsCard) {
              synonymsCard = new SynonymsCard({
                onPick: (syn) => {
                  // Stale check: the exact word we looked up must still
                  // sit at the same offsets before we splice it.
                  const cur = adapter.getText();
                  if (cur.slice(sel.start, sel.end) !== word) {
                    synonymsCard?.hide();
                    return;
                  }
                  adapter.replaceRange(sel.start, sel.end, syn);
                  synonymsCard?.hide();
                  scheduleAnalysis(adapter);
                },
                onClose: () => synonymsCard?.hide(),
              });
            }
            synonymsCard.show(word, sel.start, sel.end, caret, list);
          })
          .catch(() => undefined);
      }, 0);
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
    debouncer.dispose();
    popup?.hide();
    widget?.dispose();
    toneDebouncer.dispose();
    synonymsCard?.hide();
  });
})();

/** True if the element (or its subtree/ancestor chain) belongs to the
 *  extension's own injected UI. Every element the extension creates is
 *  tagged with a data-lwa-* attribute. */
function isInsideLwa(el: HTMLElement): boolean {
  let cur: HTMLElement | null = el;
  while (cur) {
    if (hasLwaMarker(cur)) return true;
    cur = cur.parentElement;
  }
  return false;
}

function hasLwaMarker(el: HTMLElement): boolean {
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith("data-lwa-")) return true;
  }
  return false;
}
