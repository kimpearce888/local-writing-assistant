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
  LIMITS,
  NativeCommand,
  NativeRequest,
  NativeResponse,
  RewriteOperation,
  ToneMode,
} from "../shared/types";
import {
  addSiteExclusion,
  getSettings,
  removeSiteExclusion,
  saveSettings,
  setHostPaused,
  validateSettings,
} from "../shared/storage";
import { sendNative } from "../shared/native-bridge";
import { runRewrite, runToneTransform } from "../shared/rewrite";

const SIDE_PANEL_TAB_KEY = "sidePanelTabId";
const SUGGESTION_COUNT_PREFIX = "suggestionCount:";

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
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info.selectionText || !tab?.id) return;
  const entry = CONTEXT_MENU_ENTRIES.find((e) => e.id === info.menuItemId);
  if (!entry) return;
  void (async () => {
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
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const data = await chrome.storage.session.get(SUGGESTION_COUNT_PREFIX + tab.id);
      const v = data[SUGGESTION_COUNT_PREFIX + tab.id];
      if (typeof v === "number") suggestionCount = v;
    }
  } catch {
    suggestionCount = 0;
  }
  return {
    enabled: s.enabled,
    connected,
    model: s.model,
    suggestionCount,
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
