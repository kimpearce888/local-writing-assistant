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
 * persistent state lives in chrome.storage.local.
 */

import {
  ExtensionSettings,
  NativeRequest,
  NativeResponse,
  RewriteOperation,
  ToneMode,
} from "../shared/types";
import { getSettings, saveSettings } from "../shared/storage";
import { sendNative } from "../shared/native-bridge";
import { runRewrite, runToneTransform } from "../shared/rewrite";

const SIDE_PANEL_TAB_KEY = "sidePanelTabId";

/* ---------------- Lifecycle ---------------- */

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaultContextMenus();
  await ensureSidePanelSetup();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaultContextMenus();
  await ensureSidePanelSetup();
});

async function ensureDefaultContextMenus(): Promise<void> {
  try {
    await chrome.contextMenus.removeAll();
    const entries: Array<{ id: string; title: string; op: RewriteOperation }> = [
      { id: "lwa-improve", title: "Improve writing", op: "improve" },
      { id: "lwa-shorter", title: "Make shorter", op: "shorter" },
      { id: "lwa-professional", title: "Make professional", op: "professional" },
      { id: "lwa-rewrite", title: "Rewrite…", op: "improve" },
    ];
    for (const entry of entries) {
      chrome.contextMenus.create({
        id: entry.id,
        title: entry.title,
        contexts: ["selection"],
      });
    }
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      if (!info.selectionText || !tab?.id) return;
      const op = entries.find((e) => e.id === info.menuItemId)?.op ?? "improve";
      await openSidePanelForTab(tab.id);
      await chrome.runtime.sendMessage({
        type: "side-panel-rewrite",
        op,
        text: info.selectionText,
        tabId: tab.id,
      }).catch(() => undefined);
    });
  } catch {
    // ignore
  }
}

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
      handleNativeBridgeCall(msg.command as string, msg.payload).then(reply).catch((e) =>
        reply({ ok: false, error: String(e) }),
      );
      return true;

    case "popup-get-settings":
      getSettings().then(reply);
      return true;

    case "popup-save-settings":
      saveSettings(msg.settings as Partial<ExtensionSettings>).then(reply);
      return true;

    case "popup-pause-site": {
      // The popup knows its own tab id; the SW's sender.tab?.id is
      // undefined for messages from extension pages (popups, side
      // panels). Use msg.tabId first, fall back to sender.tab?.id.
      const tabId = typeof msg.tabId === "number"
        ? msg.tabId
        : (sender.tab?.id ?? -1);
      handlePauseSite(tabId, !!msg.paused).then(() => reply({ ok: true }));
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
      // the SW-stored SIDE_PANEL_TAB_KEY (set when the side panel was
      // opened for a specific tab via the context-menu / keyboard
      // shortcut), NOT msg.tabId from the side panel — otherwise a
      // content script in a different tab could send a forged
      // selection-for-rewrite message and hijack the rewrite flow to
      // inject text into a tab the user didn't intend.
      (async () => {
        const sessionData = await chrome.storage.session.get(SIDE_PANEL_TAB_KEY);
        const trustedTabId = sessionData[SIDE_PANEL_TAB_KEY] as number | undefined;
        const targetTabId = typeof trustedTabId === "number"
          ? trustedTabId
          : msg.tabId;
        if (typeof targetTabId !== "number") {
          reply({ ok: false, error: "EDITOR_UNSUPPORTED" });
          return;
        }
        chrome.tabs.sendMessage(targetTabId, {
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
      // From content script — ignore (popup polls separately).
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
  return {
    enabled: s.enabled,
    connected,
    model: s.model,
    suggestionCount: 0, // populated per-tab; popup shows static 0 here.
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

async function handlePauseSite(tabId: number, paused: boolean): Promise<void> {
  if (tabId < 0) return;
  const mod = await import("../shared/storage");
  mod.setTabPaused(tabId, paused);
}

async function handleSiteExclusion(
  action: "add" | "remove",
  host: string,
): Promise<void> {
  const mod = await import("../shared/storage");
  if (action === "add") await mod.addSiteExclusion(host);
  else await mod.removeSiteExclusion(host);
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
 */
async function handleNativeBridgeCall(
  command: string,
  payload: unknown,
): Promise<NativeResponse> {
  try {
    const resp = await sendNative(command as NativeRequest["command"], payload);
    return resp;
  } catch (e: unknown) {
    const err = e as Error;
    return {
      ok: false,
      errorCode: "NATIVE_HOST_UNAVAILABLE",
      error: err?.message ?? "unknown error",
    };
  }
}
