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
import { hashText, truncateToUtf8Bytes } from "../shared/text-utils";
import { Semaphore } from "../shared/concurrency";
import { localCheck, mergeIssues } from "../shared/local-check";
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
  /** "ai" = model result (cacheable); "local" = offline fast-check fallback. */
  source: "ai" | "local";
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
  /** Honors the maxConcurrent setting (1–8): at most N analyses hit the
   *  native host at once; the rest queue FIFO. */
  private limiter = new Semaphore(2);

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
    // Keep the concurrency limiter in sync with the user's setting.
    this.limiter.setLimit(settings.maxConcurrent);
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

    // Dedupe via cache. A cached result carries the editorId of the
    // editor that produced it — re-tag the result (and every issue) to
    // the REQUESTING adapter before handing it on, otherwise two editors
    // with identical text would both render the first editor's issues and
    // a Replace click in editor B could mutate editor A's text.
    // The cache stores AI-ONLY issues; fresh local fast-check issues are
    // merged in at hand-off time so dictionary/setting changes apply even
    // when the model result is cached.
    const cached = this.cache.get(hash);
    if (cached) {
      const [dictionary, ignoredWords] = await Promise.all([
        getDictionary(),
        getIgnoredWords(),
      ]);
      const local = this.buildLocalIssues(
        text,
        settings,
        dictionary,
        ignoredWords,
        hash,
        adapter.getEditorIdentity(),
      );
      this.cbs.onAnalyzeComplete(
        this.retagResult(
          { ...cached, issues: mergeIssues(cached.issues, local), source: "ai" },
          adapter,
        ),
      );
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
      const outcome = await this.limiter.run(() =>
        this._doAnalyze(adapter, text, hash, requestId, controller),
      );
      if (controller.signal.aborted) return;
      // Only AI results are cached. Local-only fallbacks must not poison
      // the cache — otherwise a temporary outage would keep serving "no
      // model result" for identical text even after LM Studio returns.
      if (outcome.aiOnly) {
        this.cache.set(hash, outcome.aiOnly);
        // Cap cache size — keep last 64 entries.
        if (this.cache.size > 64) {
          const firstKey = this.cache.keys().next().value;
          if (firstKey) this.cache.delete(firstKey);
        }
      }
      this.cbs.onAnalyzeComplete(this.retagResult(outcome.merged, adapter));
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

  /** Clone a result with every editorId re-tagged to the requesting adapter. */
  private retagResult(result: AnalyzeResult, adapter: EditorAdapter): AnalyzeResult {
    const editorId = adapter.getEditorIdentity();
    return {
      ...result,
      editorId,
      issues: result.issues.map((issue) => ({ ...issue, editorId })),
    };
  }

  /**
   * Offline fast-check issues for this text, already filtered by the
   * same gates as model issues (category toggles, enableLocalChecks,
   * min confidence, custom dictionary, ignored words). Offsets refer to
   * the FULL editor text — the truncation below only clamps the model
   * payload, and local rules are cheap enough to run on everything.
   */
  private buildLocalIssues(
    text: string,
    settings: { enableLocalChecks: boolean; checkSpelling: boolean; checkGrammar: boolean; checkPunctuation: boolean; minConfidence: number },
    dictionary: string[],
    ignoredWords: string[],
    hash: string,
    editorId: string,
  ): TaggedIssue[] {
    if (!settings.enableLocalChecks) return [];
    const raw = localCheck(text, {
      spelling: settings.checkSpelling,
      grammar: settings.checkGrammar,
      punctuation: settings.checkPunctuation,
    });
    const out: TaggedIssue[] = [];
    for (const issue of raw) {
      if (issue.confidence < settings.minConfidence) continue;
      const lower = issue.original.trim().toLowerCase();
      if (lower && dictionary.some((d) => d.toLowerCase() === lower)) continue;
      if (lower && ignoredWords.includes(lower)) continue;
      out.push({
        ...issue,
        editorId,
        textHash: hash,
        sourceSubstring: text.slice(issue.start, issue.end),
      });
    }
    return out;
  }

  private async _doAnalyze(
    adapter: EditorAdapter,
    text: string,
    hash: string,
    requestId: string,
    controller: AbortController,
  ): Promise<{ merged: AnalyzeResult; aiOnly: AnalyzeResult | null }> {
    const settings = await getSettings();
    const prompt = buildGrammarPrompt({
      categories: {
        spelling: settings.checkSpelling,
        grammar: settings.checkGrammar,
        punctuation: settings.checkPunctuation,
        clarity: settings.checkClarity,
        word_choice: settings.checkWordChoice,
      },
      // Grammarly-parity goals: dialect / audience / formality / domain
      // shape every inline suggestion (US vs UK spelling, jargon tolerance,
      // formality strictness, domain style).
      goals: {
        dialect: settings.dialect,
        audience: settings.audience,
        formality: settings.formality,
        domain: settings.domain,
      },
    });

    // Truncate to the native-host payload limit. The host clamps by
    // UTF-8 BYTES, so the extension must measure the same unit — using
    // UTF-16 char counts silently desynced the two sides for non-ASCII
    // (CJK/emoji) text and corrupted every returned offset. We use the
    // SAME text for hashing, slicing, and the LLM payload so that offsets
    // returned by the model line up exactly with what we'll slice at
    // apply time.
    const analyzedText = truncateToUtf8Bytes(text, LIMITS.maxAnalyzeTextBytes).text;

    // Local fast-check issues — computed BEFORE the model round trip so
    // they are available both for merging and as the offline fallback.
    const [dictionary, ignoredWords] = await Promise.all([
      getDictionary(),
      getIgnoredWords(),
    ]);
    const localIssues = this.buildLocalIssues(
      text,
      settings,
      dictionary,
      ignoredWords,
      hash,
      adapter.getEditorIdentity(),
    );

    let resp: NativeResponse;
    try {
      resp = await sendNativeViaSW(
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
    } catch (e: unknown) {
      // Host/bridge failure: fall back to local fast-check issues when we
      // have any, so the user still gets real suggestions offline.
      if (localIssues.length > 0 && !controller.signal.aborted) {
        return {
          merged: {
            editorId: adapter.getEditorIdentity(),
            textHash: hash,
            issues: localIssues,
            source: "local",
          },
          aiOnly: null,
        };
      }
      throw e;
    }

    if (controller.signal.aborted) throw { code: "ABORTED" };
    if (!resp.ok) {
      // Same fallback path when the host answered with an error
      // (LM Studio offline, no model, timeout, …).
      if (localIssues.length > 0) {
        return {
          merged: {
            editorId: adapter.getEditorIdentity(),
            textHash: hash,
            issues: localIssues,
            source: "local",
          },
          aiOnly: null,
        };
      }
      throw {
        code: resp.errorCode ?? "NATIVE_HOST_UNAVAILABLE",
        message: resp.error ?? "native host error",
      };
    }
    const data = resp.data as { raw?: string };
    if (!data || typeof data.raw !== "string") {
      throw { code: "INVALID_AI_RESPONSE", message: "missing raw output" };
    }

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

    // Apply local filters (min confidence, dictionary, ignored words).
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

    // Model issues win overlaps (they are context-aware); local issues
    // fill every span the model missed. Sorted by start for the UI.
    return {
      merged: {
        editorId: adapter.getEditorIdentity(),
        textHash: hash,
        issues: mergeIssues(filtered, localIssues),
        source: "ai",
      },
      aiOnly: {
        editorId: adapter.getEditorIdentity(),
        textHash: hash,
        issues: filtered,
        source: "ai",
      },
    };
  }

  /** Mark a suggestion as ignored-once (storage-capped). */
  async ignoreOnce(issue: TaggedIssue): Promise<void> {
    await ignoreSuggestionOnce(issue.original, issue.category);
  }
}
