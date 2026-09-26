/**
 * Popup entry. Wires up DOM and asks the background service worker for
 * connection status / settings.
 */

import { getSettings, saveSettings } from "../shared/storage";

const $ = (id: string) => document.getElementById(id) as HTMLElement | null;

async function refreshStatus(): Promise<void> {
  const status = (await chrome.runtime.sendMessage({ type: "popup-status-query" })) as {
    enabled: boolean;
    connected: boolean;
    model: string;
    suggestionCount: number;
  } | null;
  if (!status) return;
  ($("enabledToggle") as HTMLInputElement).checked = status.enabled;
  ($("connStatus") as HTMLElement).textContent = status.connected
    ? "● Connected"
    : "○ Not connected";
  ($("modelValue") as HTMLElement).textContent = status.model || "—";
  ($("suggestionsValue") as HTMLElement).textContent = String(status.suggestionCount ?? 0);
}

function hookActions(): void {
  ($("enabledToggle") as HTMLInputElement).addEventListener("change", async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    await saveSettings({ enabled });
    chrome.runtime.sendMessage({ type: "popup-toggle", enabled }).catch(() => undefined);
  });
  ($("testBtn") as HTMLElement).addEventListener("click", async () => {
    const line = $("diagLine");
    if (line) {
      line.hidden = false;
      line.textContent = "Testing connection…";
    }
    const res = (await chrome.runtime.sendMessage({ type: "popup-test-connection" })) as {
      ok: boolean;
      data?: unknown;
      error?: string;
    } | null;
    if (line) {
      if (res?.ok) {
        line.textContent = "Connection test passed.";
      } else {
        line.textContent = `Connection test failed: ${res?.error ?? "unknown"}`;
      }
    }
    refreshStatus().catch(() => undefined);
  });
  ($("settingsBtn") as HTMLElement).addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
  ($("diagBtn") as HTMLElement).addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html#diagnostics") });
  });
  ($("enableSiteBtn") as HTMLElement).addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const host = new URL(tab.url).host;
      await chrome.runtime.sendMessage({ type: "popup-enable-site", host });
    }
  });
  ($("disableSiteBtn") as HTMLElement).addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const host = new URL(tab.url).host;
      await chrome.runtime.sendMessage({ type: "popup-disable-site", host });
    }
  });
  ($("pauseSiteBtn") as HTMLElement).addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.runtime.sendMessage({ type: "popup-pause-site", paused: true, tabId: tab.id });
    }
  });
}

(async function init() {
  await getSettings(); // ensure storage initialized
  hookActions();
  await refreshStatus();
})();
