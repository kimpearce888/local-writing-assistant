/**
 * Tests for the Grammarly-style score breakdown (shared/score.ts).
 */

import { describe, expect, it } from "vitest";
import { computeScoreBreakdown, scoreBand } from "../extension/src/shared/score";
import { Issue } from "../extension/src/shared/types";

function issue(partial: Partial<Issue>): Issue {
  return {
    id: partial.id ?? `i${Math.random()}`,
    start: partial.start ?? 0,
    end: partial.end ?? 1,
    original: partial.original ?? "a",
    replacement: partial.replacement ?? "",
    category: partial.category ?? "spelling",
    explanation: partial.explanation ?? "",
    confidence: partial.confidence ?? 0.9,
  };
}

describe("computeScoreBreakdown", () => {
  it("returns a perfect score for clean text", () => {
    const s = computeScoreBreakdown("Hello world. All good here!", []);
    expect(s.overall).toBe(100);
    expect(s.correctness).toBe(100);
    expect(s.clarity).toBe(100);
    expect(s.engagement).toBe(100);
    expect(s.delivery).toBe(100);
  });

  it("penalizes spelling/grammar/punctuation under correctness", () => {
    const text = Array.from({ length: 100 }, () => "word").join(" ");
    const s = computeScoreBreakdown(text, [
      issue({ category: "spelling" }),
      issue({ category: "grammar" }),
      issue({ category: "punctuation" }),
    ]);
    expect(s.correctness).toBeLessThan(100);
    expect(s.clarity).toBe(100);
    expect(s.engagement).toBe(100);
    expect(s.delivery).toBe(100);
  });

  it("routes clarity issues to clarity only", () => {
    const text = Array.from({ length: 100 }, () => "word").join(" ");
    const s = computeScoreBreakdown(text, [issue({ category: "clarity" })]);
    expect(s.correctness).toBe(100);
    expect(s.clarity).toBeLessThan(100);
  });

  it("routes word_choice to engagement and style to delivery", () => {
    const text = Array.from({ length: 100 }, () => "word").join(" ");
    const s = computeScoreBreakdown(text, [
      issue({ category: "word_choice" }),
      issue({ category: "style" }),
    ]);
    expect(s.engagement).toBeLessThan(100);
    expect(s.delivery).toBeLessThan(100);
    expect(s.correctness).toBe(100);
    expect(s.clarity).toBe(100);
  });

  it("scores longer documents more gently for the same issue count", () => {
    const short = Array.from({ length: 20 }, () => "word").join(" ");
    const long = Array.from({ length: 400 }, () => "word").join(" ");
    const issues = [issue({ category: "grammar" })];
    const sShort = computeScoreBreakdown(short, issues);
    const sLong = computeScoreBreakdown(long, issues);
    expect(sLong.overall).toBeGreaterThan(sShort.overall);
  });

  it("never drops below the 40 floor", () => {
    const text = "word ";
    const issues = Array.from({ length: 40 }, () => issue({ category: "grammar" }));
    const s = computeScoreBreakdown(text, issues);
    expect(s.correctness).toBeGreaterThanOrEqual(40);
    expect(s.overall).toBeGreaterThanOrEqual(40);
  });

  it("computes overall as the weighted mix of dimensions", () => {
    const text = Array.from({ length: 100 }, () => "word").join(" ");
    const s = computeScoreBreakdown(text, [issue({ category: "clarity" })]);
    // clarity penalty: 1 issue/100 words * weight 6 = 6 → clarity 94
    expect(s.clarity).toBe(94);
    // overall = 0.4*100 + 0.25*94 + 0.2*100 + 0.15*100 = 98.5 → 99 (round)
    expect(s.overall).toBe(99);
  });
});

describe("scoreBand", () => {
  it("maps scores to bands", () => {
    expect(scoreBand(95)).toBe("good");
    expect(scoreBand(90)).toBe("good");
    expect(scoreBand(80)).toBe("fair");
    expect(scoreBand(75)).toBe("fair");
    expect(scoreBand(50)).toBe("weak");
  });
});
