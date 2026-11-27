/**
 * Side panel entry — Grammarly-parity writing surface.
 *
 * The "Your text" box is a real, EDITABLE working area: the user can
 * write directly in the panel, or let a page selection prefill it.
 * Every keystroke in either box is synced into `state`, so actions
 * always operate on what is actually on screen.
 *
 * Three tabs sit under the editor:
 *  - Check:     local auto-analysis pipeline (debounced) + editable
 *               suggestion cards (accept / dismiss / accept-all).
 *  - Insights:  locally computed stats + performance score, tone
 *               detection (manual + auto), synonyms for the word at
 *               the caret.
 *  - Rewrite & Write: the categorized action menu, custom instruction,
 *               and the Result box (Replace / Copy).
 *
 * NOTE on the DOM shape: #resultSection and #actionMenu must remain
 * DIRECT children of <main> (layout contract — a test walks
 * main.children by id), so "tab panels" are expressed by toggling the
 * .hidden-tab class instead of nesting sections.
 *
 * Replacements into a PAGE editor are NEVER applied automatically — the
 * user must click Replace, which forwards an `apply-rewrite` message
 * back to the content script with the expected text hash for
 * stale-result detection. Text written purely in the panel has no page
 * editor to bind to; Copy is the apply path there. The "continue"
 * operation is the other exception: its result appends to the panel's
 * working text instead of a page editor.
 */

import {
  ANALYSIS_OPERATIONS,
  DEFAULT_SETTINGS,
  ExtensionSettings,
  Issue,
  IssueCategory,
  RewriteOperation,
  ToneMode,
} from "../shared/types";
import { computeTextStats } from "../shared/analysis";
import { computeScoreBreakdown, scoreBand } from "../shared/score";
import { toneEmoji } from "../shared/tone";
import { createPerKeyDebouncer } from "../shared/debounce";
import { addWordToDictionary, getSettings, getSnippets, ignoreWord } from "../shared/storage";
import { findSnippetMatch, Snippet } from "../shared/snippets";

const $ = (id: string) => document.getElementById(id) as HTMLElement | null;

/**
 * The full action menu, grouped exactly like the reference product:
 * Rewrite / Write / Evaluate / Adjust tone. `kind: "op"` actions run
 * through the rewrite command; `kind: "tone"` through the tone command.
 * Evaluate actions are analysis-only — Replace is disabled for them.
 * "continue" is special-cased after a successful run (append semantics).
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
      { kind: "op", id: "clearer", label: "Make it clearer", icon: "🧭" },
      { kind: "op", id: "shorter", label: "Shorten it", icon: "✂️" },
      { kind: "op", id: "clean-up-notes", label: "Clean up notes", icon: "📝" },
      { kind: "op", id: "professional", label: "Sound professional", icon: "💼" },
      { kind: "op", id: "friendly", label: "Sound friendly", icon: "😊" },
      { kind: "op", id: "formal", label: "Sound formal", icon: "🎩" },
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
      { kind: "op", id: "continue", label: "Continue writing", icon: "✍️" },
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
  /** Last successful operation — "continue" flips Replace into Append. */
  lastOp?: RewriteOperation;
}

const state: RewriteState = { text: "", rewritten: "" };

/** Issues from the most recent check — offsets refer to the analyzed
 *  text (usually the current working text; accept() verifies anyway). */
let activeIssues: Issue[] = [];

/** Cached settings (refreshed on chrome.storage.onChanged) — read by the
 *  debouncer delay getters and the auto-check / auto-tone switches. */
let settings: ExtensionSettings = { ...DEFAULT_SETTINGS };

const checkDebouncer = createPerKeyDebouncer(() => settings.debounceMs);
const toneDebouncer = createPerKeyDebouncer(() => 2500);

/* ---------------- Tabs ---------------- */

type TabId = "check" | "insights" | "actions";

const TAB_BUTTON_IDS: Record<TabId, string> = {
  check: "tab-check",
  insights: "tab-insights",
  actions: "tab-actions",
};

/**
 * Which top-level <main> children belong to which tab. `resultSection`
 * and `actionMenu` cannot be nested into a wrapper (layout contract:
 * they must be direct children of main, resultSection first), so tab
 * semantics are expressed purely with the .hidden-tab class.
 */
const TAB_SECTION_IDS: Record<TabId, string[]> = {
  check: ["panel-check"],
  insights: ["panel-insights"],
  actions: ["customSection", "resultSection", "errorLine", "actionMenu"],
};

let activeTab: TabId = "check";

function activateTab(tab: TabId): void {
  activeTab = tab;
  (Object.keys(TAB_SECTION_IDS) as TabId[]).forEach((t) => {
    const on = t === tab;
    const btn = $(TAB_BUTTON_IDS[t]);
    if (btn) {
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", String(on));
    }
    for (const id of TAB_SECTION_IDS[t]) {
      const el = $(id);
      if (!el) continue;
      el.classList.toggle("hidden-tab", !on);
      if (el.classList.contains("tab-panel")) el.classList.toggle("active", on);
    }
  });
}

/** Sync the working text from the (editable) box into state so every
 *  action runs against exactly what the user sees and edits. */
function syncWorkingText(): void {
  const el = $("selectedText") as HTMLTextAreaElement | null;
  if (el) state.text = el.value;
}

/** The Result box is editable too — user edits before Replace/Copy
 *  must be honored, otherwise Replace would silently apply the
 *  ORIGINAL rewrite and throw away the user's manual changes. */
function syncResultText(): void {
  const el = $("resultText") as HTMLTextAreaElement | null;
  if (el) state.rewritten = el.value;
}

function setText(el: HTMLElement, value: string): void {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.value = value;
  } else {
    el.textContent = value;
  }
}

function setErr(msg: string | null): void {
  const el = $("errorLine");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    // Restore tab-driven visibility (the line belongs to the actions tab).
    el.classList.toggle("hidden-tab", activeTab !== "actions");
  } else {
    // Errors can originate from any tab (tone / synonyms live on
    // Insights) — always surface them while they are active.
    el.hidden = false;
    el.textContent = msg;
    el.classList.remove("hidden-tab");
  }
}

/** Status chip next to the word count (Idle / Checking… / N suggestions). */
function setCheckChip(label: string, title?: string): void {
  const chip = $("checkChip");
  if (!chip) return;
  chip.textContent = label;
  if (title) chip.title = title;
  else chip.removeAttribute("title");
}

async function getCurrentTabSelection(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  state.tabId = tab.id;
  // Ask the content script for its current selection. The content
  // script's reply will arrive asynchronously via the side-panel-rewrite
  // message (forwarded by the SW). We don't need to await it here.
  chrome.tabs.sendMessage(tab.id, { type: "selection-for-rewrite-query" }).catch(() => undefined);
}

/* ---------------- Local stats + score (no LLM round trip) ---------------- */

function updateStatsUi(): void {
  const stats = computeTextStats(state.text);
  const wc = $("wordCount");
  if (wc) wc.textContent = `${stats.words} words`;
  const grid = $("statsGrid");
  if (!grid) return;
  grid.textContent = "";
  const cells: Array<[string, string, string?]> = [
    ["Words", String(stats.words)],
    ["Characters", String(stats.characters)],
    ["Sentences", String(stats.sentences)],
    ["Paragraphs", String(stats.paragraphs)],
    ["Reading time", `${stats.readingMinutes} min`],
    ["Speaking time", `${stats.speakingMinutes} min`],
    ["Readability", `${stats.readabilityLabel} (${stats.fleschReadingEase})`],
    ["Vocabulary richness", `${Math.round(stats.vocabularyRichness * 100)}%`],
    ["Avg sentence length", String(stats.avgWordsPerSentence)],
    ["Long sentences", String(stats.longSentences), "Sentences longer than 30 words"],
  ];
  for (const [label, value, title] of cells) {
    const cell = document.createElement("div");
    cell.className = "stat";
    if (title) cell.title = title;
    const v = document.createElement("div");
    v.className = "stat-value";
    v.textContent = value;
    const l = document.createElement("div");
    l.className = "stat-label";
    l.textContent = label;
    cell.append(v, l);
    grid.appendChild(cell);
  }
}

/** Grammarly-style performance dashboard, derived live from the current
 *  active issue list — no LLM wait. */
function updateScoreUi(): void {
  const dash = $("scoreDashboard");
  if (!dash) return;
  const score = computeScoreBreakdown(state.text, activeIssues);
  dash.textContent = "";
  const overall = document.createElement("div");
  overall.className = "score-overall";
  const num = document.createElement("span");
  num.className = `score-overall-num band-${scoreBand(score.overall)}`;
  num.textContent = String(score.overall);
  const cap = document.createElement("span");
  cap.className = "score-overall-label";
  cap.textContent = "Overall";
  overall.append(num, cap);
  dash.appendChild(overall);
  const rows: Array<[string, number]> = [
    ["Correctness", score.correctness],
    ["Clarity", score.clarity],
    ["Engagement", score.engagement],
    ["Delivery", score.delivery],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "score-row";
    const l = document.createElement("span");
    l.className = "score-label";
    l.textContent = label;
    const bar = document.createElement("div");
    bar.className = "score-bar";
    const fill = document.createElement("div");
    fill.className = `score-fill band-${scoreBand(value)}`;
    fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
    bar.appendChild(fill);
    const v = document.createElement("span");
    v.className = "score-value";
    v.textContent = String(value);
    row.append(l, bar, v);
    dash.appendChild(row);
  }
}

/* ---------------- Issues list (Check tab) ---------------- */

const CATEGORY_LABELS: Record<IssueCategory, string> = {
  spelling: "Spelling",
  grammar: "Grammar",
  punctuation: "Punctuation",
  clarity: "Clarity",
  word_choice: "Word choice",
  style: "Style",
};

function buildIssueCard(issue: Issue, index: number): HTMLElement {
  const li = document.createElement("li");
  li.className = "issue-card";
  li.dataset.issueId = issue.id;

  const pill = document.createElement("span");
  pill.className = "issue-pill";
  pill.dataset.cat = issue.category;
  // Decorative (color-coded) pill — the category is also exposed as
  // real text for screen readers below.
  pill.setAttribute("aria-hidden", "true");
  pill.textContent = CATEGORY_LABELS[issue.category] ?? issue.category;

  const expl = document.createElement("p");
  expl.className = "issue-explanation";
  const srCat = document.createElement("span");
  srCat.className = "sr-only";
  srCat.textContent = `${CATEGORY_LABELS[issue.category] ?? issue.category}. `;
  expl.append(srCat, document.createTextNode(issue.explanation));

  const row = document.createElement("div");
  row.className = "issue-row";
  const orig = document.createElement("span");
  orig.className = "issue-original";
  orig.textContent = issue.original;
  const arrow = document.createElement("span");
  arrow.className = "issue-arrow";
  arrow.textContent = "→";
  arrow.setAttribute("aria-hidden", "true");
  // Grammarly-parity: the replacement is EDITABLE before accepting.
  const edit = document.createElement("input");
  edit.type = "text";
  edit.className = "issue-edit";
  edit.value = issue.replacement;
  edit.setAttribute("aria-label", "Edit suggestion");
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "btn";
  accept.textContent = "Accept";
  accept.addEventListener("click", () => acceptIssue(index));
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "btn subtle";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => dismissIssue(index));
  row.append(orig, arrow, edit, accept, dismiss);

  // Spelling issues gain the same two actions the inline popup has
  // (parity): teach the custom dictionary the word, or permanently
  // ignore it. Either way the card is dismissed immediately and the
  // word is filtered out of future analyses.
  if (issue.category === "spelling" && issue.original.trim().length > 0) {
    const addDict = document.createElement("button");
    addDict.type = "button";
    addDict.className = "btn subtle";
    addDict.textContent = "Add to dictionary";
    addDict.addEventListener("click", () => {
      void addWordToDictionary(issue.original.trim());
      dismissIssue(index);
    });
    const ignoreW = document.createElement("button");
    ignoreW.type = "button";
    ignoreW.className = "btn subtle";
    ignoreW.textContent = "Ignore word";
    ignoreW.addEventListener("click", () => {
      void ignoreWord(issue.original.trim());
      dismissIssue(index);
    });
    row.append(addDict, ignoreW);
  }

  li.append(pill, expl, row);
  return li;
}

function renderIssues(): void {
  const list = $("issuesList");
  if (list) {
    list.textContent = "";
    activeIssues.forEach((issue, i) => {
      list.appendChild(buildIssueCard(issue, i));
    });
  }
  const empty = $("issuesEmpty");
  if (empty) empty.hidden = activeIssues.length > 0;
}

/**
 * Replace [start, end) in the working text, mirror it into the
 * textarea (caret parked at the end of the replacement), and keep the
 * active issue list consistent: suggestions overlapping the replaced
 * range are dropped, and offsets after it shift by the length delta so
 * they stay usable until the debounced re-check lands.
 */
function replaceWorkingText(start: number, end: number, replacement: string): void {
  const el = $("selectedText") as HTMLTextAreaElement | null;
  const delta = replacement.length - (end - start);
  state.text = state.text.slice(0, start) + replacement + state.text.slice(end);
  if (el) {
    el.value = state.text;
    try {
      el.setSelectionRange(start + replacement.length, start + replacement.length);
    } catch {
      /* selection not supported — ignore */
    }
  }
  activeIssues = activeIssues
    .filter((iss) => iss.end <= start || iss.start >= end)
    .map((iss) =>
      iss.start >= end
        ? { ...iss, start: iss.start + delta, end: iss.end + delta }
        : iss,
    );
}

function acceptIssue(index: number): void {
  const issue = activeIssues[index];
  if (!issue) return;
  const card = ($("issuesList") as HTMLElement | null)?.children[index] as
    | HTMLElement
    | undefined;
  // The suggestion must still match the live text — otherwise offsets
  // went stale (user edited between check and accept).
  if (state.text.slice(issue.start, issue.end) !== issue.original) {
    if (card) {
      card.classList.add("stale");
      card.title = "This suggestion no longer matches the text — run Check to refresh.";
    }
    return;
  }
  const input = card?.querySelector<HTMLInputElement>("input.issue-edit");
  const replacement = input ? input.value : issue.replacement;
  replaceWorkingText(issue.start, issue.end, replacement);
  renderIssues();
  updateStatsUi();
  updateScoreUi();
  schedulePanelCheck(true);
}

function dismissIssue(index: number): void {
  activeIssues = activeIssues.filter((_, i) => i !== index);
  renderIssues();
  updateScoreUi();
}

/**
 * Accept every suggestion whose text still matches, applying from the
 * END so earlier offsets stay valid. Honors each row's (possibly
 * edited) input value; overlapping suggestions are skipped.
 */
function acceptAllIssues(): void {
  const listEl = $("issuesList");
  const ordered = activeIssues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => b.issue.start - a.issue.start);
  const applied: Array<{ start: number; end: number }> = [];
  for (const { issue, index } of ordered) {
    if (applied.some((r) => issue.start < r.end && r.start < issue.end)) continue;
    if (state.text.slice(issue.start, issue.end) !== issue.original) continue;
    const card = listEl?.children[index] as HTMLElement | undefined;
    const input = card?.querySelector<HTMLInputElement>("input.issue-edit");
    const replacement = input ? input.value : issue.replacement;
    state.text =
      state.text.slice(0, issue.start) + replacement + state.text.slice(issue.end);
    applied.push({ start: issue.start, end: issue.end });
  }
  if (applied.length > 0) {
    const el = $("selectedText") as HTMLTextAreaElement | null;
    if (el) {
      el.value = state.text;
      try {
        el.setSelectionRange(state.text.length, state.text.length);
      } catch {
        /* ignore */
      }
    }
  }
  activeIssues = activeIssues.filter(
    (iss) => !applied.some((r) => iss.start < r.end && r.start < iss.end),
  );
  renderIssues();
  updateStatsUi();
  updateScoreUi();
  schedulePanelCheck(true);
}

/* ---------------- Auto-check pipeline ---------------- */

interface PanelCheckResponse {
  ok: boolean;
  issues?: Issue[];
  analyzedText?: string;
  error?: string;
  /** True when the result came from the offline fast-check (host/LLM unreachable). */
  offline?: boolean;
}

function schedulePanelCheck(force = false): void {
  if (!force && settings.autoCheck === false) return;
  checkDebouncer.schedule("panel", () => {
    void runPanelCheck();
  });
}

async function runPanelCheck(): Promise<void> {
  syncWorkingText();
  if (!state.text.trim()) {
    activeIssues = [];
    renderIssues();
    updateScoreUi();
    setCheckChip("Idle");
    return;
  }
  setCheckChip("Checking…");
  let res: PanelCheckResponse | null = null;
  try {
    res = (await chrome.runtime.sendMessage({
      type: "side-panel-check-text",
      text: state.text,
    })) as PanelCheckResponse | null;
  } catch (e: unknown) {
    setCheckChip("Check failed", String(e));
    return;
  }
  if (!res?.ok) {
    setCheckChip("Check failed", res?.error ?? "check failed");
    return;
  }
  const issues = Array.isArray(res.issues) ? res.issues : [];
  activeIssues = issues;
  renderIssues();
  updateStatsUi();
  updateScoreUi();
  const chipLabel = res.offline
    ? `${issues.length} suggestions · offline fast-check`
    : issues.length > 0
      ? `${issues.length} suggestions`
      : "No issues";
  if (res.analyzedText && res.analyzedText !== state.text) {
    // The SW clamps the analysis by UTF-8 bytes — offsets refer to the
    // analyzed prefix. Still render (the panel text is usually within
    // the cap) and note the cap in the chip tooltip.
    setCheckChip(
      chipLabel,
      `Checked the first ${res.analyzedText.length} characters — re-check to cover recent edits.`,
    );
  } else {
    setCheckChip(chipLabel);
  }
}

/* ---------------- Tone detection ---------------- */

interface ToneResponse {
  ok: boolean;
  tones?: Array<{ tone: string; score: number }>;
  error?: string;
}

async function runToneDetect(): Promise<void> {
  syncWorkingText();
  if (!state.text.trim()) return;
  const btn = $("detectToneBtn") as HTMLButtonElement | null;
  const list = $("toneList");
  const originalLabel = btn?.textContent ?? "Detect tone";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Detecting…";
  }
  let res: ToneResponse | null = null;
  try {
    res = (await chrome.runtime.sendMessage({
      type: "side-panel-detect-tone",
      text: state.text,
    })) as ToneResponse | null;
  } catch (e: unknown) {
    setErr(`Tone detection failed: ${String(e)}`);
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
  if (!res?.ok) {
    setErr(res?.error ?? "tone detection failed");
    return;
  }
  setErr(null);
  if (list) {
    list.textContent = "";
    for (const t of res.tones ?? []) {
      const li = document.createElement("li");
      li.className = "tone-chip";
      li.textContent = `${toneEmoji(t.tone)} ${t.tone}`;
      li.title = `${Math.round(t.score * 100)}%`;
      list.appendChild(li);
    }
  }
}

/* ---------------- Synonyms ---------------- */

const WORD_AT_CARET_RE = /[A-Za-z\u00C0-\u024F'’-]+/g;

interface SynonymsResponse {
  ok: boolean;
  synonyms?: string[];
  error?: string;
}

async function runSynonyms(): Promise<void> {
  const el = $("selectedText") as HTMLTextAreaElement | null;
  if (!el) return;
  syncWorkingText();
  const selStart = el.selectionStart ?? 0;
  const selEnd = el.selectionEnd ?? 0;
  let word = "";
  let start = 0;
  let end = 0;
  const selected = state.text.slice(selStart, selEnd).trim();
  if (selected) {
    word = selected;
    start = selStart;
    end = selEnd;
  } else {
    // No selection: take the word under/adjacent to the caret.
    WORD_AT_CARET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WORD_AT_CARET_RE.exec(state.text)) !== null) {
      if (m.index > selStart) break;
      if (selStart <= m.index + m[0].length) {
        word = m[0];
        start = m.index;
        end = m.index + m[0].length;
        break;
      }
    }
  }
  if (!word) {
    setErr("Place the cursor inside a word first.");
    return;
  }
  if (word.length > 80) {
    setErr("Selection too long — place the cursor inside a single word.");
    return;
  }
  const context = state.text.slice(
    Math.max(0, start - 80),
    Math.min(state.text.length, end + 80),
  );
  const btn = $("synonymsBtn") as HTMLButtonElement | null;
  const list = $("synonymList");
  const originalLabel = btn?.textContent ?? "Find synonyms for selected word";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Finding…";
  }
  let res: SynonymsResponse | null = null;
  try {
    res = (await chrome.runtime.sendMessage({
      type: "side-panel-synonyms",
      word,
      context,
    })) as SynonymsResponse | null;
  } catch (e: unknown) {
    setErr(`Synonyms failed: ${String(e)}`);
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
  if (!res?.ok) {
    setErr(res?.error ?? "synonyms lookup failed");
    return;
  }
  setErr(null);
  if (!list) return;
  list.textContent = "";
  for (const syn of res.synonyms ?? []) {
    const li = document.createElement("li");
    li.className = "tone-chip synonym-chip";
    li.textContent = syn;
    li.title = `Replace “${word}” with “${syn}”`;
    li.addEventListener("click", () => {
      // The word may have moved since the lookup — verify before splicing.
      if (state.text.slice(start, end) !== word) {
        setErr("The text changed — place the cursor in a word and try again.");
        return;
      }
      replaceWorkingText(start, end, syn);
      updateStatsUi();
      updateScoreUi();
      schedulePanelCheck(true);
    });
    list.appendChild(li);
  }
}

/* ---------------- Rewrite / tone ops (action menu) ---------------- */

async function runOp(op: RewriteOperation, customInstruction?: string): Promise<void> {
  syncWorkingText();
  if (!state.text.trim()) {
    setErr("Write some text above, or select text in the page first.");
    scrollToResult();
    return;
  }
  setErr(null);
  state.rewritten = "";
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
  state.lastOp = op;
  setText($("resultText") as HTMLElement, state.rewritten);
  // "continue" appends to the working text instead of replacing a page
  // editor range — make that visible on the button itself.
  setReplaceButtonMode(op === "continue");
  if (isAnalysis) {
    // Analysis results must never replace the user's text.
    setReplaceEnabled(false, "This is an analysis of your text — use Copy to take it with you.");
    setErr(null);
  } else {
    setReplaceEnabled(true);
  }
}

async function runTone(tone: ToneMode): Promise<void> {
  syncWorkingText();
  if (!state.text.trim()) {
    setErr("Write some text above, or select text in the page first.");
    scrollToResult();
    return;
  }
  setErr(null);
  state.rewritten = "";
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
  state.lastOp = undefined;
  setText($("resultText") as HTMLElement, state.rewritten);
  setReplaceButtonMode(false);
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
 * The action menu sits BELOW the working area, so after an action
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

function setReplaceButtonMode(append: boolean): void {
  const btn = $("replaceBtn");
  if (btn) btn.textContent = append ? "Append to text" : "Replace";
}

async function handleReplaceClick(): Promise<void> {
  syncWorkingText();
  syncResultText();
  // "Continue writing" has no page editor binding — the result appends
  // to the panel's own working text (with a space if needed).
  if (state.lastOp === "continue") {
    if (!state.rewritten) {
      setErr("Nothing to append yet. Run Continue writing first.");
      return;
    }
    const base = state.text;
    const glue = base && !/\s$/.test(base) ? " " : "";
    const next = base + glue + state.rewritten;
    const el = $("selectedText") as HTMLTextAreaElement | null;
    state.text = next;
    if (el) {
      el.value = next;
      try {
        el.setSelectionRange(next.length, next.length);
      } catch {
        /* ignore */
      }
    }
    setErr("Appended to your text.");
    updateStatsUi();
    updateScoreUi();
    schedulePanelCheck(true);
    return;
  }
  if (!state.rewritten) {
    setErr("Nothing to replace with. Run a rewrite first.");
    return;
  }
  if (state.editorId == null || typeof state.start !== "number" || typeof state.end !== "number") {
    setErr(
      "This text has no page editor bound. Use Copy to paste it where you need it, " +
      "or select text in the page and run the action again.",
    );
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
}

/* ---------------- Settings cache ---------------- */

async function refreshSettings(): Promise<void> {
  try {
    settings = await getSettings();
  } catch {
    // chrome.storage unavailable (tests / hardened contexts) — defaults.
    settings = { ...DEFAULT_SETTINGS };
  }
}

/* ---------------- Snippet expansion (Grammarly parity) ---------------- */

/** Snippets cache — loaded at init, refreshed live via storage.onChanged
 *  together with the settings cache. */
let snippetsCache: Snippet[] = [];

/** Programmatic value writes (our own expansion) must not re-enter the
 *  expander on the input event the next replace dispatches — panel
 *  textareas set .value directly which does NOT fire input, but page
 *  adapters do; keep the guard symmetric with content/index.ts. */
const suppressNextExpansion = new WeakMap<HTMLTextAreaElement, boolean>();

/** Instantly expand `prefix + shortcut` → snippet content in one of the
 *  panel's editable textareas. Mirrors tryExpandSnippet in the content
 *  script but reads/writes the textarea directly. */
function tryExpandTextareaSnippet(el: HTMLTextAreaElement): void {
  if (settings.enableSnippets === false) return;
  if (snippetsCache.length === 0) return;
  if (suppressNextExpansion.get(el) === true) {
    suppressNextExpansion.set(el, false);
    return;
  }
  const end = el.selectionStart ?? 0;
  if ((el.selectionEnd ?? 0) !== end) return;
  const before = el.value.slice(0, end);
  if (!before) return;
  const match = findSnippetMatch(before, snippetsCache, settings.snippetTriggerPrefix ?? ";");
  if (!match) return;
  const caret = match.start + match.snippet.content.length;
  el.value = el.value.slice(0, match.start) + match.snippet.content + el.value.slice(match.end);
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    /* ignore */
  }
  suppressNextExpansion.set(el, true);
}

/* ---------------- Wiring ---------------- */

function hookActions(): void {
  renderActionMenu();

  // Tabs: role=tab buttons; visibility flips the .hidden-tab class on
  // the sections registered in TAB_SECTION_IDS.
  (Object.keys(TAB_BUTTON_IDS) as TabId[]).forEach((t) => {
    $(TAB_BUTTON_IDS[t])?.addEventListener("click", () => activateTab(t));
  });

  // Keep state in sync with everything the user types/edits in the two
  // boxes (the working area is editable by design) and drive the local
  // auto-analysis pipeline.
  const selected = $("selectedText") as HTMLTextAreaElement | null;
  selected?.addEventListener("input", () => {
    // Snippet expansion rewrites the box BEFORE state sync so stats,
    // score and the pending check all see the expanded text.
    if (selected) tryExpandTextareaSnippet(selected);
    syncWorkingText();
    updateStatsUi();
    updateScoreUi();
    schedulePanelCheck();
    if (settings.autoToneDetect !== false) {
      if (state.text.trim().length >= 150) {
        toneDebouncer.schedule("tone", () => {
          void runToneDetect();
        });
      } else {
        toneDebouncer.cancel("tone");
      }
    }
  });
  ($("resultText") as HTMLTextAreaElement | null)?.addEventListener("input", (ev) => {
    const el = ev.currentTarget as HTMLTextAreaElement | null;
    if (el) tryExpandTextareaSnippet(el);
    syncResultText();
  });

  ($("checkNowBtn") as HTMLElement | null)?.addEventListener("click", () => {
    checkDebouncer.cancel("panel");
    void runPanelCheck();
  });
  ($("acceptAllBtn") as HTMLElement | null)?.addEventListener("click", () => {
    acceptAllIssues();
  });
  ($("detectToneBtn") as HTMLElement | null)?.addEventListener("click", () => {
    void runToneDetect();
  });
  ($("synonymsBtn") as HTMLElement | null)?.addEventListener("click", () => {
    void runSynonyms();
  });

  ($("runCustom") as HTMLElement | null)?.addEventListener("click", () => {
    const custom = ($("customInstruction") as HTMLInputElement | null)?.value.trim() ?? "";
    void runOp("custom", custom);
  });

  ($("replaceBtn") as HTMLElement | null)?.addEventListener("click", () => {
    void handleReplaceClick();
  });

  ($("copyBtn") as HTMLElement | null)?.addEventListener("click", async () => {
    syncResultText();
    // Copy prefers the (possibly edited) result; with no result yet,
    // fall back to the working text so panel-written drafts are copyable.
    const payload = state.rewritten || state.text;
    if (!payload) {
      setErr("Nothing to copy yet.");
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
    } catch {
      setErr("Clipboard not available.");
    }
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "side-panel-rewrite") {
    // The working area is editable — do NOT clobber text the user is
    // actively typing there. A fresh page selection still wins as soon
    // as the user clicks back into the box-less state (unfocused).
    const box = $("selectedText") as HTMLTextAreaElement | null;
    if (box && document.activeElement === box) return;
    state.text = (msg.text as string) ?? "";
    state.editorId = msg.editorId as string | undefined;
    state.tabId = msg.tabId as number | undefined;
    state.start = msg.start as number | undefined;
    state.end = msg.end as number | undefined;
    state.expectedHash = msg.expectedHash as string | undefined;
    setText($("selectedText") as HTMLElement, state.text);
    state.rewritten = "";
    state.lastOp = undefined;
    setReplaceButtonMode(false);
    setText($("resultText") as HTMLElement, "");
    setReplaceEnabled(false, "Run an action first");
    // New text invalidates the previous issue offsets — refresh the
    // local pipeline right away.
    activeIssues = [];
    renderIssues();
    setCheckChip("Idle");
    updateStatsUi();
    updateScoreUi();
    schedulePanelCheck();
  }
  if (msg.type === "side-panel-detect-tone-request") {
    // Context-menu "Detect tone": switch to Insights and run detection
    // on the provided selection (same focused-box guard as rewrites).
    const box = $("selectedText") as HTMLTextAreaElement | null;
    if (box && document.activeElement === box) return;
    state.text = (msg.text as string) ?? "";
    state.editorId = undefined;
    state.start = undefined;
    state.end = undefined;
    state.expectedHash = undefined;
    if (box) box.value = state.text;
    activateTab("insights");
    syncWorkingText();
    activeIssues = [];
    renderIssues();
    updateStatsUi();
    updateScoreUi();
    void runToneDetect();
  }
});

(async function init() {
  hookActions();
  activateTab("check");
  updateStatsUi();
  updateScoreUi();
  renderIssues();
  void refreshSettings();
  try {
    snippetsCache = await getSnippets();
  } catch {
    snippetsCache = [];
  }
  // Live-refresh the cached settings (debounce delay, auto switches).
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && changes.settings) void refreshSettings();
      if (area === "local" && changes.snippets) {
        void getSnippets()
          .then((list) => {
            snippetsCache = list;
          })
          .catch(() => undefined);
      }
    });
  } catch {
    /* chrome.storage not available in this context */
  }
  await getCurrentTabSelection();
})();
