/**
 * Strict parser/validator for AI responses from the local model.
 *
 * The model is treated as completely untrusted. Malformed output is
 * rejected with INVALID_AI_RESPONSE rather than inserted into the page
 * (spec sections 17, 61, 62, 65).
 */

import { GrammarCheckResponse, Issue, IssueCategory } from "./types";
import { hashText } from "./text-utils";

const VALID_CATEGORIES: ReadonlySet<string> = new Set<IssueCategory>([
  "spelling",
  "grammar",
  "punctuation",
  "clarity",
  "word_choice",
  "style",
]);

/** Strip code fences if the model wrapped its JSON in ```json … ```. */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    const end = trimmed.lastIndexOf("```");
    if (end <= 3) return trimmed.replace(/^```[a-zA-Z]*\s*/, "").trim();
    return trimmed.slice(3, end).replace(/^[a-zA-Z]*\s*/, "").trim();
  }
  return trimmed;
}

/** Find the first '{' … last '}' substring (best-effort recovery). */
function extractJsonBlock(raw: string): string {
  const fenced = stripFences(raw);
  const first = fenced.indexOf("{");
  const last = fenced.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return fenced;
  return fenced.slice(first, last + 1);
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

function asFloat(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  return null;
}

/**
 * Parse and validate a grammar-check response.
 *
 * Throws { code: 'INVALID_AI_RESPONSE', detail: string } on any
 * structural problem. Issue offsets that don't match the supplied text
 * are silently dropped (with a console warn) — we don't fail the whole
 * response for one bad issue.
 */
export function parseGrammarResponse(
  raw: string,
  analyzedText: string,
): GrammarCheckResponse {
  const block = extractJsonBlock(raw);
  const parsed = safeParse(block);
  if (!isObject(parsed)) {
    throw { code: "INVALID_AI_RESPONSE", detail: "not an object" };
  }
  const issuesRaw = parsed.issues;
  if (!Array.isArray(issuesRaw)) {
    // Treat missing issues as zero issues — only fail if correctedText is also missing.
    if (!("correctedText" in parsed)) {
      throw { code: "INVALID_AI_RESPONSE", detail: "issues not array" };
    }
  }

  const issues: Issue[] = [];
  const seenIds = new Set<string>();
  const arr = Array.isArray(issuesRaw) ? issuesRaw : [];

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!isObject(item)) continue;
    const id = asString(item.id) ?? `issue-${i + 1}`;
    if (seenIds.has(id)) continue;
    const start = asInt(item.start);
    const end = asInt(item.end);
    const original = asString(item.original);
    const replacement = asString(item.replacement);
    const category = asString(item.category);
    const explanation = asString(item.explanation) ?? "";
    const confidence = asFloat(item.confidence);

    if (
      start === null ||
      end === null ||
      original === null ||
      replacement === null ||
      category === null
    ) {
      continue;
    }
    if (!VALID_CATEGORIES.has(category)) continue;
    if (start < 0 || end > analyzedText.length || start >= end) continue;
    const slice = analyzedText.slice(start, end);
    if (slice !== original) {
      // Offsets don't match the original text — drop this issue silently.
      continue;
    }
    if (confidence !== null && (confidence < 0 || confidence > 1)) continue;

    seenIds.add(id);
    issues.push({
      id,
      start,
      end,
      original,
      replacement,
      category: category as IssueCategory,
      explanation: explanation.slice(0, 200),
      confidence: confidence ?? 0.5,
    });
    if (issues.length >= 20) break;
  }

  return {
    issues,
    correctedText: asString(parsed.correctedText) ?? undefined,
    textHash: hashText(analyzedText),
  };
}

export interface RewriteResult {
  rewritten: string;
  explanation: string;
}

export function parseRewriteResponse(raw: string): RewriteResult {
  const block = extractJsonBlock(raw);
  const parsed = safeParse(block);
  if (!isObject(parsed)) {
    throw { code: "INVALID_AI_RESPONSE", detail: "not an object" };
  }
  const rewritten = asString(parsed.rewritten);
  if (rewritten === null || rewritten.length === 0) {
    throw { code: "INVALID_AI_RESPONSE", detail: "rewritten missing" };
  }
  const explanation = asString(parsed.explanation) ?? "";
  return { rewritten, explanation: explanation.slice(0, 240) };
}

/** Escape any string for safe insertion as text content of an HTMLElement. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
