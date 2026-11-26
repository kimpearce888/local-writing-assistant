/**
 * Shared TypeScript types used across extension and (mirrored) native host.
 *
 * Keep this file free of any runtime code so it can be imported from
 * both the content script and the service worker without side effects.
 */

/** Native-messaging command names. */
export type NativeCommand =
  | "ping"
  | "get_config"
  | "get_models"
  | "check_connection"
  | "grammar_check"
  | "rewrite";

/** Error codes surfaced to the UI. */
export type ErrorCode =
  | "EXTENSION_NOT_READY"
  | "NATIVE_HOST_UNAVAILABLE"
  | "LM_STUDIO_OFFLINE"
  | "LM_STUDIO_NO_MODEL"
  | "LM_STUDIO_TIMEOUT"
  | "MODEL_ERROR"
  | "INVALID_AI_RESPONSE"
  | "EDITOR_UNSUPPORTED"
  | "STALE_RESULT"
  | "REQUEST_TOO_LARGE"
  | "PERMISSION_ERROR"
  | "INSTALLATION_ERROR";

/** A single issue returned by the grammar checker. */
export interface Issue {
  /** Stable id unique within a single analysis response. */
  id: string;
  /** Start offset (inclusive) within the analyzed text. */
  start: number;
  /** End offset (exclusive) within the analyzed text. */
  end: number;
  /** Exact original substring being flagged. */
  original: string;
  /** Proposed replacement (may be empty for "delete" suggestions). */
  replacement: string;
  category: IssueCategory;
  /** Short human-readable explanation shown in the popup. */
  explanation: string;
  /** Confidence 0.0–1.0. */
  confidence: number;
}

export type IssueCategory =
  | "spelling"
  | "grammar"
  | "punctuation"
  | "clarity"
  | "word_choice"
  | "style";

/** Response shape returned by the `grammar_check` native command. */
export interface GrammarCheckResponse {
  issues: Issue[];
  /** Optional full corrected text the model proposed (used for sanity only). */
  correctedText?: string;
  /** Hash of the analyzed text (for stale-result detection). */
  textHash: string;
}

/** Rewrite operation labels used in the UI and sent to the native host. */
export type RewriteOperation =
  // Core rewrite actions
  | "improve"
  | "continue"
  | "shorter"
  | "clearer"
  | "professional"
  | "friendly"
  | "formal"
  | "simplify"
  | "custom"
  // Rewrite menu (added in v1.6)
  | "clean-up-notes"
  | "descriptive"
  | "detailed"
  | "informative"
  | "paraphrase"
  | "summarize"
  | "fix-mistakes"
  | "fluent"
  | "objective"
  | "general-audience"
  | "esl-audience"
  | "expert-audience"
  // Write menu
  | "tldr"
  | "bullets-to-prose"
  // Evaluate menu — analysis only, never replaces the selection
  | "main-point"
  | "gaps"
  | "improvement-ideas";

/**
 * Operations that return an *analysis* of the text instead of a rewrite.
 * The side panel disables Replace for these results.
 */
export const ANALYSIS_OPERATIONS: ReadonlySet<RewriteOperation> = new Set([
  "main-point",
  "gaps",
  "improvement-ideas",
]);

export type ToneMode =
  | "neutral"
  | "professional"
  | "friendly"
  | "formal"
  | "casual"
  | "concise"
  | "confident"
  // Adjust-tone menu (added in v1.6)
  | "anticipatory"
  | "assertive"
  | "compassionate"
  | "constructive"
  | "cooperative"
  | "diplomatic"
  | "empathetic"
  | "inspirational"
  | "exciting"
  | "engaging"
  | "persuasive"
  | "direct";

/** Request envelope sent to the native host. */
export interface NativeRequest {
  command: NativeCommand;
  /** Caller-supplied id; the host echoes it back. */
  requestId?: string;
  payload?: unknown;
}

/** Response envelope returned from the native host. */
export interface NativeResponse {
  ok: boolean;
  requestId?: string;
  /** User-facing error code, present when ok === false. */
  errorCode?: ErrorCode;
  /** Short error message (already localized by the host? no — English here). */
  error?: string;
  /** Structured payload (varies per command). */
  data?: unknown;
}

export interface LMStudioModel {
  id: string;
  /** Optional friendly label. */
  object?: string;
  owned_by?: string;
}

export interface ConnectionCheckResult {
  nativeHost: boolean;
  lmStudioReachable: boolean;
  modelsEndpointOk: boolean;
  atLeastOneModel: boolean;
  testRequestOk: boolean;
  models: LMStudioModel[];
  /** Diagnostic message when something fails. */
  message?: string;
}

/** English dialect goal (Grammarly-parity: US/UK/CA/AU). */
export type Dialect = "us" | "uk" | "ca" | "au";

/** Audience goal — tunes how much jargon the checker tolerates. */
export type Audience = "general" | "knowledgeable" | "expert";

/** Formality goal — tunes how strict tone/style suggestions are. */
export type GoalFormality = "informal" | "neutral" | "formal";

/** Domain goal — tunes style strictness per document type. */
export type Domain = "general" | "academic" | "business" | "email" | "casual" | "creative";

/** Goals the user sets once and that shape every check + rewrite. */
export interface WritingGoals {
  dialect: Dialect;
  audience: Audience;
  formality: GoalFormality;
  domain: Domain;
}

export const DEFAULT_GOALS: WritingGoals = {
  dialect: "us",
  audience: "general",
  formality: "neutral",
  domain: "general",
};

/** Persisted settings stored in chrome.storage.local. */
export interface ExtensionSettings {
  enabled: boolean;
  autoCheck: boolean;
  inlineSuggestions: boolean;
  checkSpelling: boolean;
  checkGrammar: boolean;
  checkPunctuation: boolean;
  checkClarity: boolean;
  checkWordChoice: boolean;
  tone: ToneMode;
  // Writing goals (Grammarly parity)
  dialect: Dialect;
  audience: Audience;
  formality: GoalFormality;
  domain: Domain;
  // UX surface
  showFloatingWidget: boolean;
  hoverSuggestions: boolean;
  doubleClickSynonyms: boolean;
  autoToneDetect: boolean;
  // Performance
  debounceMs: number;
  maxTextSize: number;
  maxConcurrent: number;
  minConfidence: number;
  // LM Studio
  lmStudioUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  requestTimeoutMs: number;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  autoCheck: true,
  inlineSuggestions: true,
  checkSpelling: true,
  checkGrammar: true,
  checkPunctuation: true,
  checkClarity: true,
  checkWordChoice: true,
  tone: "neutral",
  dialect: "us",
  audience: "general",
  formality: "neutral",
  domain: "general",
  showFloatingWidget: true,
  hoverSuggestions: true,
  doubleClickSynonyms: true,
  autoToneDetect: true,
  debounceMs: 700,
  maxTextSize: 4000,
  maxConcurrent: 2,
  minConfidence: 0.55,
  lmStudioUrl: "http://127.0.0.1:1234",
  model: "",
  temperature: 0.1,
  maxTokens: 1024,
  requestTimeoutMs: 30000,
};

/** Native messaging host name (must match manifest + registry). */
export const NATIVE_HOST_NAME = "com.localwritingassistant.host";

/** Limits shared between extension and native host. */
export const LIMITS = {
  /** 1 MiB envelope cap enforced by the service worker before sendNative. */
  maxRequestBytes: 1024 * 1024,
  /** UTF-8 byte cap for analyzed/rewritten text — MUST match the host clamp. */
  maxAnalyzeTextBytes: 8000,
  maxRewriteTextBytes: 8000,
  maxModelsListed: 200,
} as const;

/* ---------------- Writing insights (scores, stats, tone) ---------------- */

/**
 * Deterministic, locally computed text statistics — no LLM round trip.
 * Mirrors the stats Grammarly shows (word count, readability, …) plus a
 * few extras (speaking time, vocabulary richness).
 */
export interface TextStats {
  characters: number;
  words: number;
  sentences: number;
  paragraphs: number;
  uniqueWords: number;
  /** uniqueWords / words (0–1). */
  vocabularyRichness: number;
  avgWordsPerSentence: number;
  /** Sentences longer than 30 words. */
  longSentences: number;
  readingMinutes: number;
  speakingMinutes: number;
  /** Flesch Reading Ease, 0–100. */
  fleschReadingEase: number;
  /** Flesch–Kincaid grade level. */
  fleschGrade: number;
  /** Human label derived from fleschReadingEase. */
  readabilityLabel: string;
}

/** One scored dimension of the Grammarly-style performance dashboard. */
export interface DimensionScore {
  correctness: number;
  clarity: number;
  engagement: number;
  delivery: number;
}

/** Full local score breakdown including the weighted overall score. */
export interface ScoreBreakdown extends DimensionScore {
  overall: number;
}

/** A detected tone with its 0–1 strength. */
export interface ToneReading {
  tone: string;
  score: number;
}

/** Everything the side panel / popup / widget need to display about a
 *  piece of text, bundled as one serializable object. */
export interface WritingInsights {
  editorId: string;
  stats: TextStats;
  score: ScoreBreakdown;
  /** Detected tones (may be empty if never analyzed). */
  tones: ToneReading[];
  /** Number of active issues (for badges). */
  issueCount: number;
  ts: number;
}
