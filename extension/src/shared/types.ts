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
  | "improve"
  | "shorter"
  | "clearer"
  | "professional"
  | "friendly"
  | "formal"
  | "simplify"
  | "custom";

export type ToneMode =
  | "neutral"
  | "professional"
  | "friendly"
  | "formal"
  | "casual"
  | "concise"
  | "confident";

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
  // Performance
  debounceMs: number;
  contextLength: number;
  maxTextSize: number;
  maxConcurrent: number;
  minConfidence: number;
  // LM Studio
  lmStudioUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  requestTimeoutMs: number;
  // Optional LM Studio bearer token (only sent to 127.0.0.1).
  lmStudioToken?: string;
  // Privacy / data
  storeHistoryLocally: boolean;
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
  debounceMs: 700,
  contextLength: 600,
  maxTextSize: 4000,
  maxConcurrent: 2,
  minConfidence: 0.55,
  lmStudioUrl: "http://127.0.0.1:1234",
  model: "",
  temperature: 0.1,
  maxTokens: 1024,
  requestTimeoutMs: 30000,
  storeHistoryLocally: false,
};

/** Native messaging host name (must match manifest + registry). */
export const NATIVE_HOST_NAME = "com.localwritingassistant.host";

/** Limits shared between extension and native host. */
export const LIMITS = {
  maxRequestBytes: 1024 * 1024, // 1 MiB envelope cap on the extension side
  maxAnalyzeTextBytes: 8000,
  maxRewriteTextBytes: 8000,
  maxModelsListed: 200,
} as const;
