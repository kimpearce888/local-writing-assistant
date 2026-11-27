/**
 * Regression tests for real-model offset reconciliation (v1.10.1).
 *
 * Found during the human-like E2E session against a REAL model: the
 * model returns structurally valid issues whose start/end drift by a
 * few characters (or repeat words across the text), and the old strict
 * `slice !== original` check silently dropped every one of them — no
 * inline highlights ever appeared with real AI, while the deterministic
 * test mock (with perfect offsets) masked the problem completely.
 */

import { describe, it, expect } from "vitest";
import { parseGrammarResponse, reconcileIssue } from "../extension/src/shared/ai-validation";

const TEXT = "She don't like it.";

describe("reconcileIssue", () => {
  it("keeps exact offsets untouched", () => {
    expect(reconcileIssue(TEXT, 4, 9, "don't")).toEqual({ start: 4, end: 9 });
  });

  it("relocates a drifted issue near the claimed offsets", () => {
    // Model claims 0-9 ("She don't") but flags only "don't".
    expect(reconcileIssue(TEXT, 0, 9, "don't")).toEqual({ start: 4, end: 9 });
  });

  it("relocates a case-insensitive match when casing drifted", () => {
    expect(reconcileIssue(TEXT, 0, 9, "Don't")).toEqual({ start: 4, end: 9 });
  });

  it("returns null when the substring genuinely does not occur", () => {
    expect(reconcileIssue(TEXT, 0, 4, "zebra")).toBeNull();
  });

  it("returns null for an empty original", () => {
    expect(reconcileIssue(TEXT, 0, 4, "")).toBeNull();
  });

  it("picks the occurrence nearest the claimed start", () => {
    const t = "a don't b don't c don't";
    // Occurrences at 2, 10, 18 — claimed range points nearest the second.
    expect(reconcileIssue(t, 9, 14, "don't")).toEqual({ start: 10, end: 15 });
  });
});

describe("parseGrammarResponse with drifted model offsets", () => {
  it("survives a realistic real-model response whose offsets include surrounding whitespace", () => {
    const raw = JSON.stringify({
      issues: [
        {
          id: "issue-1",
          start: 0,
          end: 9,
          original: "She don't",
          replacement: "She doesn't",
          category: "grammar",
          explanation: "Subject-verb agreement.",
          confidence: 0.9,
        },
      ],
      correctedText: "She doesn't like it.",
    });
    const res = parseGrammarResponse(raw, TEXT);
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0].start).toBe(0);
    expect(res.issues[0].end).toBe(9);
  });

  it("recovers an issue whose offsets point at the wrong place entirely", () => {
    const raw = JSON.stringify({
      issues: [
        {
          id: "i1",
          start: 2,
          end: 5,
          original: "don't",
          replacement: "doesn't",
          category: "grammar",
          explanation: "agreement",
          confidence: 0.95,
        },
      ],
    });
    const res = parseGrammarResponse(raw, TEXT);
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0].start).toBe(4);
    expect(res.issues[0].end).toBe(9);
    expect(TEXT.slice(res.issues[0].start, res.issues[0].end)).toBe("don't");
  });

  it("still drops issues whose text does not exist in the analyzed text", () => {
    const raw = JSON.stringify({
      issues: [
        {
          id: "i1",
          start: 0,
          end: 5,
          original: "wombat",
          replacement: "wolves",
          category: "grammar",
          explanation: "x",
          confidence: 0.9,
        },
      ],
    });
    const res = parseGrammarResponse(raw, TEXT);
    expect(res.issues).toHaveLength(0);
  });
});
