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

    case "popup-get-settings":
      getSettings().then(reply);
      return true;

    case "popup-save-settings":
      saveSettings(msg.settings as Partial<ExtensionSettings>).then(reply);
      return true;

    case "popup-pause-site":
      handlePauseSite(sender.tab?.id ?? -1, !!msg.paused).then(() => reply({ ok: true }));
      return true;

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

    case "side-panel-apply-rewrite":
      // Forward to content script of the originating tab.
      if (typeof msg.tabId === "number") {
        chrome.tabs.sendMessage(msg.tabId, {
          type: "apply-rewrite",
          editorId: msg.editorId,
          start: msg.start,
          end: msg.end,
          replacement: msg.replacement,
          expectedHash: msg.expectedHash,
        }).then(reply).catch(() => reply({ ok: false, error: "EDITOR_UNSUPPORTED" }));
      } else {
        reply({ ok: false, error: "EDITOR_UNSUPPORTED" });
      }
      return true;

    case "selection-for-rewrite":
      // From content script — forward to side panel.
      chrome.runtime.sendMessage({
        type: "side-panel-rewrite",
        text: msg.text,
        editorId: msg.editorId,
        tabId: sender.tab?.id,
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
