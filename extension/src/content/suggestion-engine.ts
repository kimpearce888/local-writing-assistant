/**
 * Suggestion engine (section 76).
 *
 * Responsibilities:
 *  - extract relevant text from an editor (current + small context window)
 *  - send a grammar_check request to the native host
 *  - validate + normalize the response
 *  - tag every issue with the editor id + text hash + source substring
 *    (so we can detect stale suggestions later, section 16)
 *  - cancel obsolete requests when the editor's text changes (section 31)
 *  - dedupe requests by hash (section 30)
 *  - throttle concurrency (section 30)
 *
 * The engine NEVER touches the DOM of the editor. It only asks the
 * adapter for text/selection and reports back issues to the caller.
 */

import { EditorAdapter } from "./adapters/adapter";
import {
  GrammarCheckResponse,
  Issue,
  LIMITS,
  NativeResponse,
} from "../shared/types";
import { buildGrammarPrompt } from "../shared/prompts";
import { parseGrammarResponse } from "../shared/ai-validation";
import { hashText } from "../shared/text-utils";
import { getSettings, getDictionary, getIgnoredWords, ignoreSuggestionOnce } from "../shared/storage";

/**
 * Forward a native-messaging call from the content script to the
 * service worker. Content scripts cannot call chrome.runtime.connectNative
 * directly — only the service worker can. We use chrome.runtime.sendMessage
 * and wait for the SW to reply with the host response.
 */
async function sendNativeViaSW(
  command: string,
  payload: unknown,
  timeoutMs: number,
): Promise<NativeResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SW timeout")), timeoutMs);
    chrome.runtime.sendMessage(
      { type: "native-bridge-call", command, payload },
      (resp: NativeResponse | undefined) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else if (!resp) reject(new Error("SW returned no response"));
        else resolve(resp);
      },
    );
  });
}

export interface TaggedIssue extends Issue {
  /** Editor instance this issue came from. */
  editorId: string;
  /** Hash of the analyzed text. If the editor's text no longer matches,
   * the issue is stale and must be discarded (section 16). */
  textHash: string;
  /** Exact source substring the issue refers to (independent of `original`). */
  sourceSubstring: string;
}

export interface AnalyzeResult {
  editorId: string;
  textHash: string;
  issues: TaggedIssue[];
}

export interface SuggestionEngineCallbacks {
  onAnalyzeStart: (editorId: string) => void;
  onAnalyzeComplete: (result: AnalyzeResult) => void;
  onAnalyzeError: (editorId: string, code: string, message: string) => void;
}

interface InFlight {
  editorId: string;
  textHash: string;
  controller: AbortController;
}

export class SuggestionEngine {
  private cbs: SuggestionEngineCallbacks;
  private inFlight = new Map<string, InFlight>();
  private cache = new Map<string, AnalyzeResult>();
  private seq = 1;

  constructor(cbs: SuggestionEngineCallbacks) {
    this.cbs = cbs;
  }

  /**
   * Kick off an analysis for `adapter`. Cancels any previous request for
   * the same editor.
   */
  async analyze(adapter: EditorAdapter): Promise<void> {
    const settings = await getSettings();
    if (!settings.enabled || !settings.autoCheck) return;
    // IMPORTANT: use raw editor text for hashing + offsets. We must NOT
    // normalize here, because the offsets returned by the LLM refer to
    // the same string we sent it. If we normalized for hashing but sent
    // raw (or vice versa) the slice() at apply time would land on the
    // wrong characters whenever the editor's text contains control chars.
    const text = adapter.getText();
    if (text.length === 0 || text.length > settings.maxTextSize) {
      if (text.length > settings.maxTextSize) {
        this.cbs.onAnalyzeError(
          adapter.getEditorIdentity(),
          "REQUEST_TOO_LARGE",
          "Text exceeds max size",
        );
      }
      return;
    }
    const hash = hashText(text + "|" + settings.tone + "|" + settings.model);

    // Cancel previous request for this editor.
    const existing = this.inFlight.get(adapter.getEditorIdentity());
    if (existing) {
      existing.controller.abort();
      this.inFlight.delete(adapter.getEditorIdentity());
    }

    // Dedupe via cache.
    const cached = this.cache.get(hash);
    if (cached) {
      this.cbs.onAnalyzeComplete(cached);
      return;
    }

    const controller = new AbortController();
    const requestId = `s${this.seq++}`;
    this.inFlight.set(adapter.getEditorIdentity(), {
      editorId: adapter.getEditorIdentity(),
      textHash: hash,
      controller,
    });
    this.cbs.onAnalyzeStart(adapter.getEditorIdentity());

    try {
      const result = await this._doAnalyze(adapter, text, hash, requestId, controller);
      if (controller.signal.aborted) return;
      this.cache.set(hash, result);
      // Cap cache size — keep last 64 entries.
      if (this.cache.size > 64) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
      }
      this.cbs.onAnalyzeComplete(result);
    } catch (e: unknown) {
      if (controller.signal.aborted) return;
      const err = e as { code?: string; message?: string };
      this.cbs.onAnalyzeError(
        adapter.getEditorIdentity(),
        err?.code ?? "NATIVE_HOST_UNAVAILABLE",
        err?.message ?? "unknown error",
      );
    } finally {
      // Only delete the in-flight entry if it still points at OUR
      // controller. If a newer analyze() has already swapped in a
      // different controller for this editor, deleting by key would
      // wrongly cancel the newer request's tracking entry.
      const current = this.inFlight.get(adapter.getEditorIdentity());
      if (current?.controller === controller) {
        this.inFlight.delete(adapter.getEditorIdentity());
      }
    }
  }

  /** Explicitly cancel any in-flight request for this editor. */
  cancel(editorId: string): void {
    const f = this.inFlight.get(editorId);
    if (f) {
      f.controller.abort();
      this.inFlight.delete(editorId);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async _doAnalyze(
    adapter: EditorAdapter,
    text: string,
    hash: string,
    requestId: string,
    controller: AbortController,
  ): Promise<AnalyzeResult> {
    const settings = await getSettings();
    const prompt = buildGrammarPrompt({
      categories: {
        spelling: settings.checkSpelling,
        grammar: settings.checkGrammar,
        punctuation: settings.checkPunctuation,
        clarity: settings.checkClarity,
        word_choice: settings.checkWordChoice,
      },
    });

    // Truncate to the native-host payload limit. We use the SAME text
    // for hashing, slicing, and the LLM payload so that offsets returned
    // by the model line up exactly with what we'll slice at apply time.
    // (Previously this code built a "focusText" of the first 6 sentences
    // joined with single spaces, which broke offsets whenever the
    // original text contained paragraph breaks — the slice would land on
    // the wrong characters and the apply step would falsely report
    // STALE_RESULT.)
    const analyzedText = text.length > LIMITS.maxAnalyzeTextBytes
      ? text.slice(0, LIMITS.maxAnalyzeTextBytes)
      : text;

    const resp: NativeResponse = await sendNativeViaSW(
      "grammar_check",
      {
        text: analyzedText,
        systemPrompt: prompt.system,
        model: settings.model,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        timeoutMs: settings.requestTimeoutMs,
      },
      settings.requestTimeoutMs + 5000,
    );

    if (controller.signal.aborted) throw { code: "ABORTED" };
    if (!resp.ok) {
      throw {
        code: resp.errorCode ?? "NATIVE_HOST_UNAVAILABLE",
        message: resp.error ?? "native host error",
      };
    }
    const data = resp.data as { raw?: string };
    if (!data || typeof data.raw !== "string") {
      throw { code: "INVALID_AI_RESPONSE", message: "missing raw output" };
    }

    // Filter against local dictionary / ignored words.
    const [dictionary, ignoredWords] = await Promise.all([
      getDictionary(),
      getIgnoredWords(),
    ]);

    let parsed: GrammarCheckResponse;
    try {
      parsed = parseGrammarResponse(data.raw, analyzedText);
    } catch (e: unknown) {
      const err = e as { code?: string; detail?: string };
      throw {
        code: err?.code ?? "INVALID_AI_RESPONSE",
        message: err?.detail ?? "malformed AI response",
      };
    }

    // Apply local filters (dictionary, ignored words, min confidence).
    const filtered: TaggedIssue[] = [];
    for (const issue of parsed.issues) {
      if (issue.confidence < settings.minConfidence) continue;
      const lower = issue.original.trim().toLowerCase();
      if (lower && dictionary.some((d) => d.toLowerCase() === lower)) continue;
      if (lower && ignoredWords.includes(lower)) continue;
      filtered.push({
        ...issue,
        editorId: adapter.getEditorIdentity(),
        textHash: hash,
        sourceSubstring: analyzedText.slice(issue.start, issue.end),
      });
    }

    return {
      editorId: adapter.getEditorIdentity(),
      textHash: hash,
      issues: filtered,
    };
  }

  /** Mark a suggestion as ignored-once (storage-capped). */
  async ignoreOnce(issue: TaggedIssue): Promise<void> {
    await ignoreSuggestionOnce(issue.original, issue.category);
  }
}
