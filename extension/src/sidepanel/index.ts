/**
 * Side panel entry. Receives selected text from the content script
 * (via the background) and lets the user trigger rewrite operations.
 *
 * Replacements are NEVER applied automatically — the user must click
 * Replace, which forwards an `apply-rewrite` message back to the
 * content script with the expected text hash for stale-result detection.
 */

import {
  ANALYSIS_OPERATIONS,
  RewriteOperation,
  ToneMode,
} from "../shared/types";

const $ = (id: string) => document.getElementById(id) as HTMLElement | null;

/**
 * The full action menu, grouped exactly like the reference product:
 * Rewrite / Write / Evaluate / Adjust tone. `kind: "op"` actions run
 * through the rewrite command; `kind: "tone"` through the tone command.
 * Evaluate actions are analysis-only — Replace is disabled for them.
 */
type ActionKind = "op" | "tone";

interface ActionDef {
  kind: ActionKind;
  id: string;
  label: string;
  icon: string;
}

interface CategoryDef {
  title: string;
  actions: ActionDef[];
}

const CATEGORIES: CategoryDef[] = [
  {
    title: "Rewrite",
    actions: [
      { kind: "op", id: "improve", label: "Improve it", icon: "✨" },
      { kind: "op", id: "shorter", label: "Shorten it", icon: "✂️" },
      { kind: "op", id: "clean-up-notes", label: "Clean up notes", icon: "📝" },
      { kind: "op", id: "professional", label: "Sound professional", icon: "💼" },
      { kind: "op", id: "descriptive", label: "Make it more descriptive", icon: "🖋️" },
      { kind: "op", id: "detailed", label: "Make it more detailed", icon: "🗂️" },
      { kind: "op", id: "simplify", label: "Simplify it", icon: "🧑‍🏫" },
      { kind: "op", id: "informative", label: "Make it informative", icon: "🤓" },
      { kind: "op", id: "paraphrase", label: "Paraphrase it", icon: "🔄" },
      { kind: "op", id: "summarize", label: "Summarize it", icon: "📋" },
      { kind: "op", id: "fix-mistakes", label: "Fix any mistakes", icon: "🔧" },
      { kind: "op", id: "fluent", label: "Sound fluent", icon: "💬" },
      { kind: "op", id: "objective", label: "Make it objective", icon: "⚖️" },
      { kind: "op", id: "general-audience", label: "Rewrite for a general audience", icon: "🌍" },
      { kind: "op", id: "esl-audience", label: "Rewrite for an ESL audience", icon: "🗣️" },
      { kind: "op", id: "expert-audience", label: "Rewrite for an expert audience", icon: "🎓" },
    ],
  },
  {
    title: "Write",
    actions: [
      { kind: "op", id: "tldr", label: "Create a TL;DR", icon: "📄" },
      { kind: "op", id: "bullets-to-prose", label: "Turn bullets to prose", icon: "➡️" },
    ],
  },
  {
    title: "Evaluate",
    actions: [
      { kind: "op", id: "main-point", label: "Pick out my main point", icon: "🏷️" },
      { kind: "op", id: "gaps", label: "Identify any gaps", icon: "🔍" },
      { kind: "op", id: "improvement-ideas", label: "Give me ideas for improvement", icon: "💡" },
    ],
  },
  {
    title: "Adjust tone",
    actions: [
      { kind: "tone", id: "anticipatory", label: "Sound anticipatory", icon: "👆" },
      { kind: "tone", id: "assertive", label: "Make it assertive", icon: "👉" },
      { kind: "tone", id: "compassionate", label: "Sound compassionate", icon: "🤗" },
      { kind: "tone", id: "confident", label: "Sound confident", icon: "🤝" },
      { kind: "tone", id: "constructive", label: "Make it constructive", icon: "👏" },
      { kind: "tone", id: "cooperative", label: "Sound cooperative", icon: "⭐" },
      { kind: "tone", id: "diplomatic", label: "Make it diplomatic", icon: "😊" },
      { kind: "tone", id: "empathetic", label: "Make it empathetic", icon: "🥳" },
      { kind: "tone", id: "friendly", label: "Make it friendly", icon: "😄" },
      { kind: "tone", id: "inspirational", label: "Make it inspirational", icon: "🌟" },
      { kind: "tone", id: "exciting", label: "Make it exciting", icon: "🤩" },
      { kind: "tone", id: "casual", label: "Sound casual", icon: "👕" },
      { kind: "tone", id: "formal", label: "Sound formal", icon: "🎩" },
      { kind: "tone", id: "engaging", label: "Make it engaging", icon: "🧲" },
      { kind: "tone", id: "persuasive", label: "Make it persuasive", icon: "🎯" },
      { kind: "tone", id: "direct", label: "Make it direct", icon: "📍" },
    ],
  },
];

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
  // Ask the content script for its current selection. The content
  // script's reply will arrive asynchronously via the side-panel-rewrite
  // message (forwarded by the SW). We don't need to await it here.
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
    scrollToResult();
    return;
  }
  setErr(null);
  setText($("resultText") as HTMLElement, "");
  scrollToResult();
  const isAnalysis = ANALYSIS_OPERATIONS.has(op);
  setReplaceEnabled(false, isAnalysis ? undefined : "Run the action first");
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
  if (isAnalysis) {
    // Analysis results must never replace the user's text.
    setReplaceEnabled(false, "This is an analysis of your text — use Copy to take it with you.");
    setErr(null);
  } else {
    setReplaceEnabled(true);
  }
}

async function runTone(tone: ToneMode): Promise<void> {
  if (!state.text.trim()) {
    setErr("Select some text in the page first.");
    scrollToResult();
    return;
  }
  setErr(null);
  setText($("resultText") as HTMLElement, "");
  scrollToResult();
  setReplaceEnabled(false, "Run the action first");
  const res = (await chrome.runtime.sendMessage({
    type: "side-panel-run-tone",
    text: state.text,
    tone,
  })) as { ok: boolean; rewritten?: string; explanation?: string; error?: string } | null;
  if (!res?.ok) {
    setErr(res?.error ?? "tone change failed");
    return;
  }
  state.rewritten = res.rewritten ?? "";
  setText($("resultText") as HTMLElement, state.rewritten);
  setReplaceEnabled(true);
}

/**
 * Render the action menu as collapsible groups. The first group
 * (Rewrite — the most-used actions) starts expanded; the rest start
 * collapsed so the block below the working area stays compact.
 */
function renderActionMenu(): void {
  const menu = $("actionMenu");
  if (!menu) return;
  menu.textContent = "";
  CATEGORIES.forEach((cat, i) => {
    const expanded = i === 0;
    const section = document.createElement("section");
    section.className = "action-cat";
    const h = document.createElement("button");
    h.type = "button";
    h.className = "cat-title";
    h.setAttribute("aria-expanded", String(expanded));
    const arrow = document.createElement("span");
    arrow.className = "cat-arrow";
    arrow.textContent = expanded ? "\u25be" : "\u25b8"; // ▾ / ▸
    arrow.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.textContent = cat.title;
    h.append(arrow, title);
    const list = document.createElement("div");
    list.className = expanded ? "cat-actions" : "cat-actions collapsed";
    for (const action of cat.actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "action-item";
      const icon = document.createElement("span");
      icon.className = "action-icon";
      icon.textContent = action.icon;
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "action-label";
      label.textContent = action.label;
      btn.append(icon, label);
      btn.addEventListener("click", () => {
        if (action.kind === "tone") {
          void runTone(action.id as ToneMode);
        } else {
          void runOp(action.id as RewriteOperation);
        }
      });
      list.appendChild(btn);
    }
    h.addEventListener("click", () => {
      const collapsed = list.classList.toggle("collapsed");
      h.setAttribute("aria-expanded", String(!collapsed));
      arrow.textContent = collapsed ? "\u25b8" : "\u25be";
    });
    section.append(h, list);
    menu.appendChild(section);
  });
}

/**
 * The action menu now sits BELOW the working area, so after an action
 * is triggered (or fails) bring the Result section back into view.
 */
function scrollToResult(): void {
  const sec = $("resultSection");
  if (sec) sec.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setReplaceEnabled(enabled: boolean, note?: string): void {
  const btn = $("replaceBtn") as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = !enabled;
  btn.title = enabled ? "Replace the selected text with the result" : note ?? "";
}

function hookActions(): void {
  renderActionMenu();
  ($("runCustom") as HTMLElement).addEventListener("click", () => {
    const custom = ($("customInstruction") as HTMLInputElement).value.trim();
    void runOp("custom", custom);
  });
  ($("replaceBtn") as HTMLElement).addEventListener("click", async () => {
    if (!state.rewritten) {
      setErr("Nothing to replace with. Run a rewrite first.");
      return;
    }
    if (state.editorId == null || typeof state.start !== "number" || typeof state.end !== "number") {
      setErr("No editor is bound to this rewrite. Select text in the page first.");
      return;
    }
    if (!state.expectedHash) {
      setErr("Cannot apply rewrite — text hash is missing. Please re-select the text and try again.");
      return;
    }
    const res = (await chrome.runtime.sendMessage({
      type: "side-panel-apply-rewrite",
      tabId: state.tabId,
      editorId: state.editorId,
      start: state.start,
      end: state.end,
      replacement: state.rewritten,
      expectedHash: state.expectedHash,
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
    setReplaceEnabled(false, "Run an action first");
  }
});

(async function init() {
  hookActions();
  await getCurrentTabSelection();
})();
