/**
 * Options page. Loads and saves all ExtensionSettings, manages the
 * custom dictionary, site exclusions, diagnostics, and settings
 * backup/restore.
 */

import {
  DEFAULT_SETTINGS,
  ExtensionSettings,
} from "../shared/types";
import {
  addSiteExclusion,
  addWordToDictionary,
  clearDictionary,
  clearDiagnostics,
  getDiagnostics,
  getDictionary,
  getSettings,
  getSiteExclusions,
  removeSiteExclusion,
  removeWordFromDictionary,
  resetSettings,
  saveSettings,
  setDictionary,
} from "../shared/storage";

const $ = (id: string) => document.getElementById(id) as HTMLElement | null;

async function loadSettingsToUI(): Promise<void> {
  const s = await getSettings();
  setCheck("enabled", s.enabled);
  setCheck("autoCheck", s.autoCheck);
  setCheck("inlineSuggestions", s.inlineSuggestions);
  setCheck("checkSpelling", s.checkSpelling);
  setCheck("checkGrammar", s.checkGrammar);
  setCheck("checkPunctuation", s.checkPunctuation);
  setCheck("checkClarity", s.checkClarity);
  setCheck("checkWordChoice", s.checkWordChoice);
  setValue("tone", s.tone);
  setNumber("debounceMs", s.debounceMs);
  setNumber("contextLength", s.contextLength);
  setNumber("maxTextSize", s.maxTextSize);
  setNumber("maxConcurrent", s.maxConcurrent);
  setNumber("minConfidence", s.minConfidence);
  setValue("lmStudioUrl", s.lmStudioUrl);
  setNumber("temperature", s.temperature);
  setNumber("maxTokens", s.maxTokens);
  setNumber("requestTimeoutMs", s.requestTimeoutMs);
  await refreshModels(s.model);
  await refreshDictionary();
  await refreshExclusions();
}

function setCheck(id: string, val: boolean): void {
  const el = $(id) as HTMLInputElement | null;
  if (el) el.checked = val;
}
function setValue(id: string, val: string): void {
  const el = $(id) as HTMLInputElement | HTMLSelectElement | null;
  if (el) el.value = val;
}
function setNumber(id: string, val: number): void {
  const el = $(id) as HTMLInputElement | null;
  if (el) el.value = String(val);
}
function readNumber(id: string, fallback: number): number {
  const el = $(id) as HTMLInputElement | null;
  if (!el) return fallback;
  const n = Number(el.value);
  return Number.isFinite(n) ? n : fallback;
}
function readBool(id: string): boolean {
  const el = $(id) as HTMLInputElement | null;
  return el?.checked ?? false;
}
function readStr(id: string): string {
  const el = $(id) as HTMLInputElement | HTMLSelectElement | null;
  return el?.value ?? "";
}

async function gatherSettingsFromUI(): Promise<ExtensionSettings> {
  const current = await getSettings();
  const next: ExtensionSettings = {
    ...current,
    enabled: readBool("enabled"),
    autoCheck: readBool("autoCheck"),
    inlineSuggestions: readBool("inlineSuggestions"),
    checkSpelling: readBool("checkSpelling"),
    checkGrammar: readBool("checkGrammar"),
    checkPunctuation: readBool("checkPunctuation"),
    checkClarity: readBool("checkClarity"),
    checkWordChoice: readBool("checkWordChoice"),
    tone: readStr("tone") as ExtensionSettings["tone"],
    debounceMs: readNumber("debounceMs", DEFAULT_SETTINGS.debounceMs),
    contextLength: readNumber("contextLength", DEFAULT_SETTINGS.contextLength),
    maxTextSize: readNumber("maxTextSize", DEFAULT_SETTINGS.maxTextSize),
    maxConcurrent: readNumber("maxConcurrent", DEFAULT_SETTINGS.maxConcurrent),
    minConfidence: readNumber("minConfidence", DEFAULT_SETTINGS.minConfidence),
    lmStudioUrl: readStr("lmStudioUrl") || DEFAULT_SETTINGS.lmStudioUrl,
    model: readStr("model"),
    temperature: readNumber("temperature", DEFAULT_SETTINGS.temperature),
    maxTokens: readNumber("maxTokens", DEFAULT_SETTINGS.maxTokens),
    requestTimeoutMs: readNumber("requestTimeoutMs", DEFAULT_SETTINGS.requestTimeoutMs),
  };
  return next;
}

async function saveFromUI(): Promise<void> {
  const next = await gatherSettingsFromUI();
  await saveSettings(next);
}

async function refreshModels(selectedId?: string): Promise<void> {
  const select = $("model") as HTMLSelectElement | null;
  if (!select) return;
  const res = (await chrome.runtime.sendMessage({ type: "popup-get-models" })) as {
    ok: boolean;
    models?: string[];
    error?: string;
  } | null;
  select.innerHTML = "";
  if (!res?.ok || !res.models || res.models.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = res?.error ? `(refresh models: ${res.error})` : "(no models found)";
    select.appendChild(opt);
    return;
  }
  for (const m of res.models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    if (selectedId && m === selectedId) opt.selected = true;
    select.appendChild(opt);
  }
}

async function refreshDictionary(): Promise<void> {
  const list = $("dictList");
  if (!list) return;
  const words = await getDictionary();
  list.innerHTML = "";
  if (words.length === 0) {
    const li = document.createElement("li");
    li.textContent = "(empty)";
    li.style.color = "var(--muted)";
    list.appendChild(li);
    return;
  }
  for (const w of words) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = w;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      await removeWordFromDictionary(w);
      await refreshDictionary();
    });
    li.appendChild(span);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function refreshExclusions(): Promise<void> {
  const list = $("exclusionList");
  if (!list) return;
  const items = await getSiteExclusions();
  list.innerHTML = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.textContent = "(no exclusions)";
    li.style.color = "var(--muted)";
    list.appendChild(li);
    return;
  }
  for (const host of items) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = host;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      await removeSiteExclusion(host);
      await refreshExclusions();
    });
    li.appendChild(span);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function hookControls(): void {
  // Persist on any input change.
  document.querySelectorAll("input,select").forEach((el) => {
    el.addEventListener("change", saveFromUI);
  });
  ($("refreshModels") as HTMLElement).addEventListener("click", async () => {
    const s = await getSettings();
    await refreshModels(s.model);
  });
  ($("testConnection") as HTMLElement).addEventListener("click", async () => {
    const line = $("connStatus") as HTMLElement | null;
    if (line) {
      line.hidden = false;
      line.textContent = "Testing…";
    }
    const res = (await chrome.runtime.sendMessage({ type: "popup-test-connection" })) as {
      ok: boolean;
      data?: unknown;
      error?: string;
    } | null;
    if (line) {
      line.textContent = res?.ok ? "Connection OK." : `Failed: ${res?.error ?? "unknown"}`;
    }
  });
  ($("addWord") as HTMLElement).addEventListener("click", async () => {
    const word = ($("newWord") as HTMLInputElement).value.trim();
    if (!word) return;
    await addWordToDictionary(word);
    ($("newWord") as HTMLInputElement).value = "";
    await refreshDictionary();
  });
  ($("clearDict") as HTMLElement).addEventListener("click", async () => {
    await clearDictionary();
    await refreshDictionary();
  });
  ($("exportDict") as HTMLElement).addEventListener("click", async () => {
    const words = await getDictionary();
    downloadJson("dictionary.json", words);
  });
  ($("importDict") as HTMLElement).addEventListener("click", () => {
    pickFile(async (text) => {
      try {
        const arr = JSON.parse(text);
        if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
          await setDictionary(arr);
          await refreshDictionary();
        }
      } catch {
        // ignore
      }
    });
  });
  ($("addExclusion") as HTMLElement).addEventListener("click", async () => {
    const host = ($("newExclusion") as HTMLInputElement).value.trim().toLowerCase();
    if (!host) return;
    await addSiteExclusion(host);
    ($("newExclusion") as HTMLInputElement).value = "";
    await refreshExclusions();
  });
  ($("exportSettings") as HTMLElement).addEventListener("click", async () => {
    const s = await getSettings();
    downloadJson("settings.json", s);
  });
  ($("importSettings") as HTMLElement).addEventListener("click", () => {
    pickFile(async (text) => {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          alert("Import failed: file is not a JSON object.");
          return;
        }
        // Allow only known settings fields. Previously saveSettings did
        // {...current, ...obj} which would persist any extra fields the
        // user (or a malicious file) included — bad data hygiene.
        // We allowlist the known fields and discard the rest.
        const allowed: ReadonlyArray<keyof ExtensionSettings> = [
          "enabled", "autoCheck", "inlineSuggestions",
          "checkSpelling", "checkGrammar", "checkPunctuation",
          "checkClarity", "checkWordChoice",
          "tone", "debounceMs", "contextLength", "maxTextSize",
          "maxConcurrent", "minConfidence",
          "lmStudioUrl", "model", "temperature", "maxTokens",
          "requestTimeoutMs", "lmStudioToken", "storeHistoryLocally",
        ];
        const cleaned: Record<string, unknown> = {};
        for (const key of allowed) {
          if (key in parsed) {
            cleaned[key] = parsed[key];
          }
        }
        if (Object.keys(cleaned).length === 0) {
          alert("Import failed: no recognized settings fields in file.");
          return;
        }
        await saveSettings(cleaned as Partial<ExtensionSettings>);
        await loadSettingsToUI();
      } catch (e) {
        alert(`Import failed: ${(e as Error).message || "invalid JSON"}`);
      }
    });
  });
  ($("resetSettings") as HTMLElement).addEventListener("click", async () => {
    await resetSettings();
    await loadSettingsToUI();
  });
  ($("runDiag") as HTMLElement).addEventListener("click", async () => {
    await runDiagnostics();
  });
  ($("clearDiag") as HTMLElement).addEventListener("click", async () => {
    await clearDiagnostics();
    const out = $("diagOutput");
    if (out) out.textContent = "";
  });
}

async function runDiagnostics(): Promise<void> {
  const out = $("diagOutput");
  if (!out) return;
  const lines: string[] = [];
  lines.push("[..] Running diagnostics…");
  out.textContent = lines.join("\n");
  // Run connection test.
  const res = (await chrome.runtime.sendMessage({ type: "popup-test-connection" })) as {
    ok: boolean;
    data?: unknown;
    error?: string;
  } | null;
  if (res?.ok) {
    const data = res.data as {
      nativeHost?: boolean;
      lmStudioReachable?: boolean;
      modelsEndpointOk?: boolean;
      atLeastOneModel?: boolean;
      testRequestOk?: boolean;
      models?: Array<{ id: string }>;
      message?: string;
    };
    lines.push(`[${data.nativeHost ? "PASS" : "FAIL"}] Native host installed`);
    lines.push(`[${data.lmStudioReachable ? "PASS" : "FAIL"}] LM Studio reachable`);
    lines.push(`[${data.modelsEndpointOk ? "PASS" : "FAIL"}] /v1/models endpoint`);
    lines.push(`[${data.atLeastOneModel ? "PASS" : "FAIL"}] At least one model available`);
    lines.push(`[${data.testRequestOk ? "PASS" : "FAIL"}] Test request succeeded`);
    if (data.models && data.models.length > 0) {
      lines.push(`Models: ${data.models.slice(0, 5).map((m) => m.id).join(", ")}${data.models.length > 5 ? "…" : ""}`);
    }
    if (data.message) lines.push(`Note: ${data.message}`);
  } else {
    lines.push(`[FAIL] Connection test failed: ${res?.error ?? "unknown"}`);
  }
  // Pull local diagnostics log too.
  const diag = await getDiagnostics();
  if (diag.length > 0) {
    lines.push("");
    lines.push(`Recent diagnostics (${Math.min(diag.length, 20)} of ${diag.length}):`);
    for (const entry of diag.slice(-20)) {
      lines.push(
        `[${entry.level.toUpperCase()}] ${new Date(entry.ts).toISOString()} ${entry.code}: ${entry.message}`,
      );
    }
  }
  out.textContent = lines.join("\n");
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function pickFile(cb: (text: string) => void): void {
  const input = $("fileInput") as HTMLInputElement;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    cb(text);
    input.value = "";
  };
  input.click();
}

(async function init() {
  hookControls();
  await loadSettingsToUI();
  // Support deep-link to diagnostics section (#diagnostics).
  if (location.hash === "#diagnostics") {
    const card = $("diagnosticsCard");
    if (card) card.scrollIntoView();
    runDiagnostics();
  }
})();
