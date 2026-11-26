/**
 * Service worker (background).
 *
 * Responsibilities:
 *  - register context menu actions
 *  - handle keyboard commands
 *  - open the side panel
 *  - relay messages between content script and side panel
 *  - keep LM Studio connection state cached for the popup
 *  - run a one-off connection test on demand
 *
 * The service worker is intentionally stateless across restarts — all
 * persistent state lives in chrome.storage.local / chrome.storage.session.
 *
 * MV3 RULE: every chrome.* event listener MUST be registered synchronously
 * at the top level of the module. The context-menu click listener used to
 * live inside onInstalled/onStartup, so it vanished every time the worker
 * was killed and cold-restarted (menu clicks were silently dropped), and
 * stacked duplicates when both lifecycle events fired in one lifetime.
 */

import {
  ExtensionSettings,
  Issue,
  LIMITS,
  NativeCommand,
  NativeRequest,
  NativeResponse,
  RewriteOperation,
  ScoreBreakdown,
  TextStats,
  ToneMode,
  ToneReading,
  WritingInsights,
} from "../shared/types";
import {
  addSiteExclusion,
  getDictionary,
  getIgnoredWords,
  getSettings,
  removeSiteExclusion,
  saveSettings,
  setHostPaused,
  validateSettings,
} from "../shared/storage";
import { sendNative } from "../shared/native-bridge";
import { runRewrite, runToneTransform } from "../shared/rewrite";
import { buildGrammarPrompt, buildSynonymsPrompt } from "../shared/prompts";
import {
  parseGrammarResponse,
  parseSynonymsResponse,
} from "../shared/ai-validation";
import { detectTone } from "../shared/tone";
import { truncateToUtf8Bytes } from "../shared/text-utils";

const SIDE_PANEL_TAB_KEY = "sidePanelTabId";
const SUGGESTION_COUNT_PREFIX = "suggestionCount:";
/** Per-tab writing-insights cache for the popup's mini-dashboard.
 *  Written fire-and-forget by the content script on every analysis. */
const INSIGHTS_PREFIX = "insights:";

/** The only native commands a content-script bridge call may request. */
const BRIDGE_ALLOWED_COMMANDS: ReadonlySet<string> = new Set<NativeCommand>([
  "ping",
  "get_config",
  "get_models",
  "check_connection",
  "grammar_check",
  "rewrite",
]);

/* ---------------- Lifecycle ---------------- */

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaultContextMenus();
  void ensureSidePanelSetup();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureDefaultContextMenus();
  void ensureSidePanelSetup();
});

/** Context-menu definitions. The click listener below is registered at
 *  module top level (MV3 requirement) and reads from this constant. */
const CONTEXT_MENU_ENTRIES: Array<{
  id: string;
  title: string;
  op?: RewriteOperation;
}> = [
  { id: "lwa-improve", title: "Improve writing", op: "improve" },
  { id: "lwa-shorter", title: "Make shorter", op: "shorter" },
  { id: "lwa-professional", title: "Make professional", op: "professional" },
  // "Rewrite…" deliberately does NOT auto-run an operation: it opens the
  // side panel with the selection preloaded and lets the user pick an
  // action from the menu (the old entry mapped to op "improve" and was an
  // exact duplicate of "Improve writing").
  { id: "lwa-rewrite", title: "Rewrite…" },
  // No-op entries: handled explicitly by id in the click listener below.
  { id: "lwa-check", title: "Check writing now" },
  { id: "lwa-detect-tone", title: "Detect tone" },
];

async function ensureDefaultContextMenus(): Promise<void> {
  try {
    await chrome.contextMenus.removeAll();
    for (const entry of CONTEXT_MENU_ENTRIES) {
      chrome.contextMenus.create({
        id: entry.id,
        title: entry.title,
        contexts: ["selection"],
      });
    }
  } catch {
    // ignore
  }
}

// Registered synchronously at module scope — NOT inside onInstalled/onStartup.
// Dispatches on entry.id (NOT on the presence of .op — the no-op entries
// "lwa-check" and "lwa-detect-tone" have their own flows that must not
// fall through to the generic rewrite path).
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info.selectionText || !tab?.id) return;
  const entry = CONTEXT_MENU_ENTRIES.find((e) => e.id === info.menuItemId);
  if (!entry) return;
  void (async () => {
    switch (entry.id) {
      case "lwa-check":
        // Poke the content script to run a check in the focused editor
        // (same flow as the Alt+Shift+L command). No panel is opened.
        chrome.tabs
          .sendMessage(tab.id as number, { type: "trigger-check" })
          .catch(() => undefined);
        return;
      case "lwa-detect-tone": {
        // Open the panel for this tab, then broadcast the selection so
        // the panel runs a tone detection on it.
        await openSidePanelForTab(tab.id as number);
        chrome.runtime
          .sendMessage({
            type: "side-panel-detect-tone-request",
            text: info.selectionText,
          })
          .catch(() => undefined);
        return;
      }
      default:
        break;
    }
    await openSidePanelForTab(tab.id as number);
    if (entry.op) {
      await chrome.runtime.sendMessage({
        type: "side-panel-rewrite",
        op: entry.op,
        text: info.selectionText,
        tabId: tab.id,
      }).catch(() => undefined);
    } else {
      // "Rewrite…": let the panel pull the current selection itself.
      chrome.tabs.sendMessage(tab.id as number, {
        type: "selection-for-rewrite-query",
      }).catch(() => undefined);
    }
  })();
});

async function ensureSidePanelSetup(): Promise<void> {
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    }
  } catch {
    // ignore
  }
}

/* ---------------- Commands ---------------- */

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "open-assistant") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await openSidePanelForTab(tab.id);
    } else {
      chrome.action.openPopup?.();
    }
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === "check-writing") {
    chrome.tabs.sendMessage(tab.id, { type: "trigger-check" }).catch(() => undefined);
  } else if (command === "rewrite-selection") {
    await openSidePanelForTab(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: "selection-for-rewrite-query" }).catch(() => undefined);
  }
});

async function openSidePanelForTab(tabId: number): Promise<void> {
  try {
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ tabId });
    }
    await chrome.storage.session.set({ [SIDE_PANEL_TAB_KEY]: tabId });
  } catch {
    // ignore
  }
}

/* ---------------- Message router ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== "object") return false;

  switch (msg.type) {
    case "popup-status-query":
      handlePopupStatusQuery().then(reply).catch(() => reply(null));
      return true;

    case "popup-toggle":
      saveSettings({ enabled: !!msg.enabled }).then(() => reply({ ok: true }));
      return true;

    case "popup-test-connection":
      handleTestConnection().then(reply).catch(() => reply(null));
      return true;

    case "native-bridge-call":
      // Forward a native-messaging call from a content script (which
      // cannot call chrome.runtime.connectNative directly) to the host.
      // Guarded: only our own extension may call it, only whitelisted
      // commands pass, and the payload is size-capped.
      handleNativeBridgeCall(msg, sender).then(reply).catch((e) =>
        reply({ ok: false, error: String(e) }),
      );
      return true;

    case "popup-get-settings":
      getSettings().then(reply).catch(() => reply(null));
      return true;

    case "popup-save-settings":
      // Never persist unvalidated message payloads: validateSettings drops
      // unknown keys and coerces/clamps every value to its declared type.
      saveSettings(validateSettings(msg.settings) as Partial<ExtensionSettings>)
        .then((s) => reply({ ok: true, settings: s }));
      return true;

    case "popup-pause-site": {
      // The popup resolves the host from its own tab query (it holds an
      // activeTab grant). We no longer map tabId → URL here: without the
      // "tabs" permission chrome.tabs.get() does not return the URL, so
      // the old path silently no-op'd outside the popup.
      const host = typeof msg.host === "string" ? msg.host : "";
      handlePauseSite(host, !!msg.paused).then(() => reply({ ok: true }));
      return true;
    }

    case "popup-enable-site":
    case "popup-disable-site":
      handleSiteExclusion(msg.type === "popup-enable-site" ? "remove" : "add", msg.host as string)
        .then(() => reply({ ok: true }));
      return true;

    case "popup-get-models":
      handleGetModels().then(reply).catch((e) => reply({ ok: false, error: String(e) }));
      return true;

    case "open-side-panel":
      // From the popup (or another extension page): open the side panel
      // for the tab the message originates from. sender.tab.id is
      // SW-trusted (Chrome populates it; the caller cannot forge it).
      (async () => {
        const tabId = sender.tab?.id;
        if (typeof tabId !== "number") {
          reply({ ok: false, error: "no tab" });
          return;
        }
        await openSidePanelForTab(tabId);
        reply({ ok: true });
      })().catch((e) => reply({ ok: false, error: String(e) }));
      return true;

    case "open-options":
      // Open the settings page. openOptionsPage resolves once the page
      // has been opened (or rejects if unavailable — old Chromium).
      (async () => {
        try {
          await chrome.runtime.openOptionsPage();
          reply({ ok: true });
        } catch (e: unknown) {
          reply({ ok: false, error: String(e) });
        }
      })();
      return true;

    case "side-panel-check-text":
      // Side panel "Check writing" — runs the same grammar pipeline as
      // the inline engine (prompt goals, size caps, local filters).
      handlePanelGrammarCheck(msg.text)
        .then(reply)
        .catch((e) => reply({ ok: false, error: String(e) }));
      return true;

    case "side-panel-synonyms":
      handlePanelSynonyms(msg.word, msg.context)
        .then(reply)
        .catch((e) => reply({ ok: false, error: String(e) }));
      return true;

    case "side-panel-detect-tone":
      handlePanelDetectTone(msg.text)
        .then(reply)
        .catch((e) => reply({ ok: false, error: String(e) }));
      return true;

    case "side-panel-run-rewrite":
      handleSidePanelRewrite(
        msg.text as string,
        msg.op as RewriteOperation,
        msg.customInstruction as string | undefined,
      )
        .then(reply)
        .catch((e) => reply({ ok: false, error: String(e) }));
      return true;

    case "side-panel-run-tone":
      handleSidePanelTone(msg.text as string, msg.tone as ToneMode)
        .then(reply)
        .catch((e) => reply({ ok: false, error: String(e) }));
      return true;

    case "side-panel-apply-rewrite": {
      // Forward to the content script of the originating tab. We trust
      // ONLY the SW-stored SIDE_PANEL_TAB_KEY (set when the side panel
      // was opened for a specific tab via the context-menu / keyboard
      // shortcut / selection push) — NOT msg.tabId from the caller —
      // otherwise a content script in a different tab could send a
      // forged message and hijack the rewrite flow to inject text into
      // a tab the user didn't intend.
      (async () => {
        const sessionData = await chrome.storage.session.get(SIDE_PANEL_TAB_KEY);
        const trustedTabId = sessionData[SIDE_PANEL_TAB_KEY] as number | undefined;
        if (typeof trustedTabId !== "number") {
          reply({ ok: false, error: "EDITOR_UNSUPPORTED" });
          return;
        }
        chrome.tabs.sendMessage(trustedTabId, {
          type: "apply-rewrite",
          editorId: msg.editorId,
          start: msg.start,
          end: msg.end,
          replacement: msg.replacement,
          expectedHash: msg.expectedHash,
        }).then(reply).catch(() => reply({ ok: false, error: "EDITOR_UNSUPPORTED" }));
      })().catch(() => reply({ ok: false, error: "EDITOR_UNSUPPORTED" }));
      return true;
    }

    case "selection-for-rewrite":
      // From content script — forward to the side panel. Forward ALL
      // fields the side panel needs to apply the replacement: the
      // selected text, the editor id, the selection offsets, and the
      // hash of the full editor text (so the apply step can detect if
      // the editor's contents have changed since the rewrite was
      // triggered). Previously only {text, editorId} was forwarded,
      // so the side panel's Replace button always failed with
      // "No editor is bound to this rewrite."
      //
      // ALSO update SIDE_PANEL_TAB_KEY to the originating tab. Without
      // this, the apply-rewrite case would still trust the OLD tab
      // id (from when the side panel was first opened) and the
      // replacement would go to the wrong tab if the user switched
      // tabs, selected new text in tab B, ran a rewrite, and clicked
      // Replace — they'd see EDITOR_UNSUPPORTED because tab A's
      // editor doesn't have this editorId. sender.tab?.id is SW-trusted
      // (Chrome populates it, the content script cannot forge it).
      if (typeof sender.tab?.id === "number") {
        chrome.storage.session
          .set({ [SIDE_PANEL_TAB_KEY]: sender.tab.id })
          .catch(() => undefined);
      }
      chrome.runtime.sendMessage({
        type: "side-panel-rewrite",
        text: msg.text,
        editorId: msg.editorId,
        tabId: sender.tab?.id,
        start: msg.start,
        end: msg.end,
        expectedHash: msg.expectedHash,
      }).catch(() => undefined);
      return false;

    case "insights-update": {
      // From content script — fire-and-forget cache of the latest
      // writing insights for the popup's mini-dashboard. No reply:
      // returning false closes the message channel immediately.
      if (typeof sender.tab?.id === "number") {
        const insights = sanitizeInsights(msg);
        if (insights) {
          void chrome.storage.session
            .set({ [INSIGHTS_PREFIX + sender.tab.id]: insights })
            .catch(() => undefined);
        }
      }
      return false;
    }

    case "status":
      // From content script. Reflect analysis health on the toolbar
      // icon so a silent failure (LM Studio offline, model error, no
      // model loaded) is visible without opening the popup: a red "!"
      // badge with the error in the hover title, cleared as soon as an
      // analysis succeeds again. The per-tab suggestion count is cached
      // in session storage so the popup can show the real number.
      if (typeof sender.tab?.id === "number") {
        const countKey = SUGGESTION_COUNT_PREFIX + sender.tab.id;
        const count = msg.state === "done" && typeof msg.count === "number"
          ? msg.count
          : 0;
        chrome.storage.session.set({ [countKey]: count }).catch(() => undefined);
      }
      if (msg.state === "error") {
        chrome.action.setBadgeText({ text: "!" }).catch(() => undefined);
        chrome.action.setBadgeBackgroundColor({ color: "#c62828" }).catch(
          () => undefined,
        );
        chrome.action
          .setTitle({
            title: `Local Writing Assistant — error: ${msg.code ?? "UNKNOWN"} (${msg.message ?? "no details"})`,
          })
          .catch(() => undefined);
      } else if (msg.state === "done") {
        chrome.action.setBadgeText({ text: "" }).catch(() => undefined);
        chrome.action
          .setTitle({ title: "Local Writing Assistant" })
          .catch(() => undefined);
      }
      return false;

    default:
      return false;
  }
});

/* ---------------- Handlers ---------------- */

async function handlePopupStatusQuery(): Promise<{
  enabled: boolean;
  connected: boolean;
  model: string;
  suggestionCount: number;
  insights: WritingInsights | null;
}> {
  const s = await getSettings();
  let connected = false;
  try {
    const resp = await sendNative("check_connection", { lightweight: true }, 8000);
    connected = !!resp.ok && !!resp.data && (resp.data as { nativeHost?: boolean }).nativeHost === true;
  } catch {
    connected = false;
  }
  let suggestionCount = 0;
  let insights: WritingInsights | null = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const [countData, insightsData] = await Promise.all([
        chrome.storage.session.get(SUGGESTION_COUNT_PREFIX + tab.id),
        chrome.storage.session.get(INSIGHTS_PREFIX + tab.id).catch(() => ({} as Record<string, unknown>)),
      ]);
      const v = countData[SUGGESTION_COUNT_PREFIX + tab.id];
      if (typeof v === "number") suggestionCount = v;
      const raw = insightsData[INSIGHTS_PREFIX + tab.id];
      if (isWritingInsights(raw)) insights = raw;
    }
  } catch {
    suggestionCount = 0;
    insights = null;
  }
  return {
    enabled: s.enabled,
    connected,
    model: s.model,
    suggestionCount,
    insights,
  };
}

async function handleTestConnection(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const resp: NativeResponse = await sendNative("check_connection", {}, 15000);
    return { ok: resp.ok, data: resp.data, error: resp.error };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message };
  }
}

async function handleGetModels(): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  try {
    const resp: NativeResponse = await sendNative("get_models", {}, 10000);
    if (!resp.ok) return { ok: false, error: resp.error };
    const data = resp.data as { models?: Array<{ id: string }> };
    const models = (data.models ?? []).map((m) => m.id);
    return { ok: true, models };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message };
  }
}

async function handlePauseSite(host: string, paused: boolean): Promise<void> {
  if (!host) return;
  await setHostPaused(host, paused);
}

/* ---------------- Writing insights cache (popup mini-dashboard) ------- */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate an untrusted insights-update payload into a WritingInsights.
 * Returns null when the stats/score bundles are malformed — the popup
 * reads score.overall / stats.* directly, so garbage must never be
 * persisted. tones defaults to [] when missing or malformed.
 */
function sanitizeInsights(msg: Record<string, unknown>): WritingInsights | null {
  const { stats, score, tones, editorId, issueCount } = msg;
  if (!isPlainObject(stats) || !isPlainObject(score)) return null;
  return {
    editorId: typeof editorId === "string" ? editorId : "",
    stats: stats as unknown as TextStats,
    score: score as unknown as ScoreBreakdown,
    tones: Array.isArray(tones)
      ? (tones as unknown[]).filter(
          (t): t is ToneReading =>
            isPlainObject(t) &&
            typeof (t as { tone?: unknown }).tone === "string" &&
            typeof (t as { score?: unknown }).score === "number",
        )
      : [],
    issueCount: typeof issueCount === "number" ? issueCount : 0,
    ts: Date.now(),
  };
}

/** Shape guard for insights read back from session storage. */
function isWritingInsights(v: unknown): v is WritingInsights {
  if (!isPlainObject(v)) return false;
  const ins = v as Partial<WritingInsights>;
  return (
    typeof ins.editorId === "string" &&
    isPlainObject(ins.stats) &&
    isPlainObject(ins.score) &&
    Array.isArray(ins.tones) &&
    typeof ins.ts === "number"
  );
}

/* ---------------- Side-panel helper handlers ---------------- */

/**
 * Full grammar check for the side panel's "Check writing" action.
 * Mirrors the inline suggestion-engine pipeline exactly: same prompt
 * (categories + writing goals), same UTF-8 byte truncation, and the same
 * local filters (min confidence, custom dictionary, ignored words).
 */
async function handlePanelGrammarCheck(
  text: unknown,
): Promise<{ ok: boolean; issues?: Issue[]; analyzedText?: string; error?: string }> {
  try {
    const settings = await getSettings();
    if (!settings.enabled) {
      return { ok: false, error: "Assistant is disabled" };
    }
    if (typeof text !== "string" || !text.trim()) {
      return { ok: false, error: "no text" };
    }
    if (text.length > settings.maxTextSize) {
      return {
        ok: false,
        error: `Text exceeds max size (${settings.maxTextSize} chars)`,
      };
    }
    // The host clamps by UTF-8 bytes — measure in the same unit so the
    // returned offsets line up with the text we hand back to the panel.
    const analyzed = truncateToUtf8Bytes(text, LIMITS.maxAnalyzeTextBytes).text;
    const prompt = buildGrammarPrompt({
      categories: {
        spelling: settings.checkSpelling,
        grammar: settings.checkGrammar,
        punctuation: settings.checkPunctuation,
        clarity: settings.checkClarity,
        word_choice: settings.checkWordChoice,
      },
      goals: {
        dialect: settings.dialect,
        audience: settings.audience,
        formality: settings.formality,
        domain: settings.domain,
      },
    });
    const resp: NativeResponse = await sendNative(
      "grammar_check",
      {
        text: analyzed,
        systemPrompt: prompt.system,
        model: settings.model,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        timeoutMs: settings.requestTimeoutMs,
      },
      settings.requestTimeoutMs + 5000,
    );
    if (!resp.ok) {
      return { ok: false, error: resp.error ?? "native host error" };
    }
    const parsed = parseGrammarResponse(
      (resp.data as { raw?: string }).raw ?? "",
      analyzed,
    );
    const [dictionary, ignored] = await Promise.all([
      getDictionary(),
      getIgnoredWords(),
    ]);
    // Same filter chain as suggestion-engine.ts: min confidence, then
    // dictionary/ignored-word lookups on the lowercased trimmed original.
    const issues = parsed.issues.filter((i) => {
      if (i.confidence < settings.minConfidence) return false;
      const lower = i.original.trim().toLowerCase();
      if (lower && dictionary.some((d) => d.toLowerCase() === lower)) return false;
      if (lower && ignored.includes(lower)) return false;
      return true;
    });
    return { ok: true, issues, analyzedText: analyzed };
  } catch (e: unknown) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Synonyms / thesaurus lookup for the side panel (double-click a word).
 * Uses the `rewrite` native command with a dedicated thesaurus prompt,
 * low temperature, and a small token budget — the output is parsed and
 * sanitized by parseSynonymsResponse.
 */
async function handlePanelSynonyms(
  word: unknown,
  context: unknown,
): Promise<{ ok: boolean; synonyms?: string[]; error?: string }> {
  try {
    if (typeof word !== "string" || !word.trim() || word.length > 80) {
      return { ok: false, error: "invalid word" };
    }
    const settings = await getSettings();
    const prompt = buildSynonymsPrompt({
      word,
      context: typeof context === "string" ? context : undefined,
    });
    const resp: NativeResponse = await sendNative(
      "rewrite",
      {
        text: word,
        systemPrompt: prompt.system,
        model: settings.model,
        temperature: 0.3,
        maxTokens: 200,
        timeoutMs: settings.requestTimeoutMs,
      },
      settings.requestTimeoutMs + 5000,
    );
    if (!resp.ok) {
      return { ok: false, error: resp.error ?? "native host error" };
    }
    return {
      ok: true,
      synonyms: parseSynonymsResponse((resp.data as { raw?: string }).raw ?? "", word),
    };
  } catch (e: unknown) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Tone detection for the side panel's tone card. detectTone() falls back
 * to the local heuristic when LM Studio is offline, so this never blocks
 * the UI on a failure.
 */
async function handlePanelDetectTone(
  text: unknown,
): Promise<{ ok: boolean; tones?: ToneReading[]; error?: string }> {
  try {
    if (typeof text !== "string" || !text.trim() || text.length > 6000) {
      return { ok: false, error: "invalid text" };
    }
    // sendNative's command param is narrower (NativeCommand) than the
    // relay's (string), so bridge through a tiny adapter that upcasts.
    const tones = await detectTone(text, (command, payload, timeoutMs) =>
      sendNative(command as NativeRequest["command"], payload, timeoutMs),
    );
    return { ok: true, tones };
  } catch (e: unknown) {
    return { ok: false, error: String(e) };
  }
}

async function handleSiteExclusion(
  action: "add" | "remove",
  host: string,
): Promise<void> {
  if (action === "add") await addSiteExclusion(host);
  else await removeSiteExclusion(host);
}

async function handleSidePanelRewrite(
  text: string,
  op: RewriteOperation,
  customInstruction?: string,
): Promise<{ ok: boolean; rewritten?: string; explanation?: string; error?: string }> {
  try {
    const out = await runRewrite(text, op, customInstruction);
    return { ok: true, rewritten: out.rewritten, explanation: out.explanation };
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    return { ok: false, error: err?.message ?? "rewrite failed" };
  }
}

async function handleSidePanelTone(
  text: string,
  tone: ToneMode,
): Promise<{ ok: boolean; rewritten?: string; explanation?: string; error?: string }> {
  try {
    const out = await runToneTransform(text, tone);
    return { ok: true, rewritten: out.rewritten, explanation: out.explanation };
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    return { ok: false, error: err?.message ?? "tone transform failed" };
  }
}

/**
 * Forward a native-messaging call from a content script to the host.
 * Content scripts cannot call chrome.runtime.connectNative directly —
 * only the service worker can — so the content script's suggestion engine
 * sends a runtime message to the SW, which calls sendNative() and
 * returns the result.
 *
 * Guards (the SW is the security boundary between page content and the
 * native host):
 *  1. sender identity — only this extension's own content scripts may
 *     use the bridge (sender.id must equal chrome.runtime.id);
 *  2. command allowlist — exactly the six documented NativeCommand values;
 *  3. payload size cap — the serialized envelope must stay within
 *     LIMITS.maxRequestBytes (1 MiB), mirroring the host-side frame cap.
 */
async function handleNativeBridgeCall(
  msg: { command?: unknown; payload?: unknown },
  sender: chrome.runtime.MessageSender,
): Promise<NativeResponse> {
  if (sender.id !== chrome.runtime.id) {
    return { ok: false, errorCode: "PERMISSION_ERROR", error: "bridge call from unknown sender" };
  }
  const command = typeof msg.command === "string" ? msg.command : "";
  if (!BRIDGE_ALLOWED_COMMANDS.has(command)) {
    return { ok: false, errorCode: "PERMISSION_ERROR", error: `command not allowed: ${command}` };
  }
  let envelopeSize = 0;
  try {
    envelopeSize = JSON.stringify({ command, payload: msg.payload }).length;
  } catch {
    return { ok: false, errorCode: "REQUEST_TOO_LARGE", error: "payload not serializable" };
  }
  if (envelopeSize > LIMITS.maxRequestBytes) {
    return { ok: false, errorCode: "REQUEST_TOO_LARGE", error: "payload exceeds size cap" };
  }
  try {
    return await sendNative(command as NativeRequest["command"], msg.payload);
  } catch (e: unknown) {
    const err = e as Error;
    return {
      ok: false,
      errorCode: "NATIVE_HOST_UNAVAILABLE",
      error: err?.message ?? "unknown error",
    };
  }
}
