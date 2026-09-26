/**
 * Side panel entry. Receives selected text from the content script
 * (via the background) and lets the user trigger rewrite operations.
 *
 * Replacements are NEVER applied automatically — the user must click
 * Replace, which forwards an `apply-rewrite` message back to the
 * content script with the expected text hash for stale-result detection.
 */

import { RewriteOperation } from "../shared/types";
import { hashText } from "../shared/text-utils";

const $ = (id: string) => document.getElementById(id) as HTMLElement | null;

interface RewriteState {
  text: string;
  editorId?: string;
  tabId?: number;
  start?: number;
  end?: number;
  expectedHash?: string;
  rewritten: string;
}

const state: RewriteState = { text: "", rewritten: "" };

async function getCurrentTabSelection(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  state.tabId = tab.id;
  // Ask the content script for its current selection.
  chrome.tabs.sendMessage(tab.id, { type: "selection-for-rewrite-query" }).catch(() => undefined);
}

function setErr(msg: string | null): void {
  const el = $("errorLine");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
  } else {
    el.hidden = false;
    el.textContent = msg;
  }
}

function setText(el: HTMLElement, value: string): void {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.value = value;
  } else {
    el.textContent = value;
  }
}

async function runOp(op: RewriteOperation, customInstruction?: string): Promise<void> {
  if (!state.text.trim()) {
    setErr("Select some text in the page first.");
    return;
  }
  setErr(null);
  setText($("resultText") as HTMLElement, "");
  const res = (await chrome.runtime.sendMessage({
    type: "side-panel-run-rewrite",
    text: state.text,
    op,
    customInstruction,
  })) as { ok: boolean; rewritten?: string; explanation?: string; error?: string } | null;
  if (!res?.ok) {
    setErr(res?.error ?? "rewrite failed");
    return;
  }
  state.rewritten = res.rewritten ?? "";
  setText($("resultText") as HTMLElement, state.rewritten);
}

function hookActions(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-op]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const op = btn.getAttribute("data-op") as RewriteOperation;
      void runOp(op);
    });
  });
  ($("runCustom") as HTMLElement).addEventListener("click", () => {
    const custom = ($("customInstruction") as HTMLInputElement).value.trim();
    void runOp("custom", custom);
  });
  ($("replaceBtn") as HTMLElement).addEventListener("click", async () => {
    if (!state.rewritten) {
      setErr("Nothing to replace with. Run a rewrite first.");
      return;
    }
    if (!state.editorId || typeof state.start !== "number" || typeof state.end !== "number") {
      setErr("No editor is bound to this rewrite.");
      return;
    }
    const expectedHash = state.expectedHash ?? hashText(state.text);
    const res = (await chrome.runtime.sendMessage({
      type: "side-panel-apply-rewrite",
      tabId: state.tabId,
      editorId: state.editorId,
      start: state.start,
      end: state.end,
      replacement: state.rewritten,
      expectedHash,
    })) as { ok: boolean; error?: string } | null;
    if (!res?.ok) {
      setErr(res?.error ?? "apply failed");
      return;
    }
    setErr("Replaced.");
  });
  ($("copyBtn") as HTMLElement).addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.rewritten);
    } catch {
      setErr("Clipboard not available.");
    }
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "side-panel-rewrite") {
    state.text = (msg.text as string) ?? "";
    state.editorId = msg.editorId as string | undefined;
    state.tabId = msg.tabId as number | undefined;
    state.start = msg.start as number | undefined;
    state.end = msg.end as number | undefined;
    state.expectedHash = msg.expectedHash as string | undefined;
    setText($("selectedText") as HTMLElement, state.text);
    setText($("resultText") as HTMLElement, "");
  }
});

(async function init() {
  hookActions();
  await getCurrentTabSelection();
})();
