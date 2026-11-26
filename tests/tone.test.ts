/**
 * Tests for tone detection: the local heuristic fallback and the strict
 * parser for the model's tone-detect response (shared/tone.ts +
 * shared/ai-validation.ts).
 */

import { describe, expect, it } from "vitest";
import { heuristicTone, toneEmoji, DETECTABLE_TONES } from "../extension/src/shared/tone";
import {
  parseToneDetectResponse,
  parseSynonymsResponse,
} from "../extension/src/shared/ai-validation";

describe("heuristicTone", () => {
  it("returns empty for empty text", () => {
    expect(heuristicTone("")).toEqual([]);
    expect(heuristicTone("   ")).toEqual([]);
  });

  it("detects excitement from repeated exclamation marks", () => {
    const tones = heuristicTone("This is amazing!! I can't wait!!");
    expect(tones.length).toBeGreaterThan(0);
    expect(tones.some((t) => t.tone === "excited")).toBe(true);
  });

  it("detects curiosity from questions", () => {
    const tones = heuristicTone("Have you ever wondered why the sky is blue?");
    expect(tones.some((t) => t.tone === "curious")).toBe(true);
  });

  it("detects formality from formal markers", () => {
    const tones = heuristicTone(
      "Pursuant to our discussion, we hereby confirm the arrangement. Sincerely, the board.",
    );
    expect(tones.some((t) => t.tone === "formal")).toBe(true);
  });

  it("detects informality from casual markers", () => {
    const tones = heuristicTone("hey guys, gonna be super awesome, yeah!");
    expect(tones.some((t) => t.tone === "informal")).toBe(true);
  });

  it("detects urgency", () => {
    const tones = heuristicTone("We need this ASAP — the deadline is critical. Send immediately.");
    expect(tones.some((t) => t.tone === "urgent")).toBe(true);
  });

  it("detects gratitude", () => {
    const tones = heuristicTone("Thank you so much for your help with this.");
    expect(tones.some((t) => t.tone === "grateful")).toBe(true);
  });

  it("falls back to neutral for plain text", () => {
    const tones = heuristicTone("The meeting is at three o'clock in the conference room.");
    expect(tones.length).toBeGreaterThan(0);
    expect(tones[0].tone).toBe("neutral");
  });

  it("returns at most 3 tones sorted by strength", () => {
    const tones = heuristicTone(
      "hey! gonna be awesome!! thank you ASAP sincerely okay? sure?",
    );
    expect(tones.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < tones.length; i++) {
      expect(tones[i - 1].score).toBeGreaterThanOrEqual(tones[i].score);
    }
  });
});

describe("tone vocabulary", () => {
  it("has unique tone names and emojis", () => {
    const names = DETECTABLE_TONES.map((t) => t.tone);
    expect(new Set(names).size).toBe(names.length);
    for (const t of DETECTABLE_TONES) {
      expect(t.emoji.length).toBeGreaterThan(0);
    }
  });

  it("toneEmoji falls back to a pencil", () => {
    expect(toneEmoji("confident")).not.toBe("📝");
    expect(toneEmoji("nonexistent-tone")).toBe("📝");
  });
});

describe("parseToneDetectResponse", () => {
  it("parses a valid tones array", () => {
    const out = parseToneDetectResponse(
      '{"tones":[{"tone":"confident","score":0.9},{"tone":"direct","score":0.5}]}',
    );
    expect(out).toEqual([
      { tone: "confident", score: 0.9 },
      { tone: "direct", score: 0.5 },
    ]);
  });

  it("sorts by score descending", () => {
    const out = parseToneDetectResponse(
      '{"tones":[{"tone":"direct","score":0.4},{"tone":"calm","score":0.8}]}',
    );
    expect(out[0].tone).toBe("calm");
    expect(out[1].tone).toBe("direct");
  });

  it("drops unknown tones and invalid scores", () => {
    const out = parseToneDetectResponse(
      '{"tones":[{"tone":"sassy","score":0.9},{"tone":"calm","score":5},{"tone":"calm","score":0.7}]}',
    );
    expect(out).toEqual([{ tone: "calm", score: 0.7 }]);
  });

  it("caps at 3 tones and dedupes", () => {
    const out = parseToneDetectResponse(
      '{"tones":[{"tone":"calm","score":0.9},{"tone":"calm","score":0.8},{"tone":"urgent","score":0.7},{"tone":"direct","score":0.6},{"tone":"blunt","score":0.5}]}',
    );
    expect(out.length).toBe(3);
  });

  it("handles code-fenced output", () => {
    const out = parseToneDetectResponse(
      '```json\n{"tones":[{"tone":"hopeful","score":0.6}]}\n```',
    );
    expect(out).toEqual([{ tone: "hopeful", score: 0.6 }]);
  });

  it("falls back to plain-text tone mentions", () => {
    const out = parseToneDetectResponse("The text reads as confident and direct overall.");
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((t) => t.tone === "confident")).toBe(true);
  });
});

describe("parseSynonymsResponse", () => {
  it("parses a valid synonyms array (original word excluded)", () => {
    const out = parseSynonymsResponse('{"synonyms":["big","large","huge"]}', "big");
    expect(out).toEqual(["large", "huge"]);
  });

  it("never includes the original word", () => {
    const out = parseSynonymsResponse('{"synonyms":["big","BIG","large"]}', "big");
    expect(out).toEqual(["large"]);
  });

  it("dedupes case-insensitively and trims", () => {
    const out = parseSynonymsResponse('{"synonyms":[" Large ","large","tiny"]}', "big");
    expect(out).toEqual(["Large", "tiny"]);
  });

  it("drops entries longer than 3 words or 60 chars", () => {
    const out = parseSynonymsResponse(
      '{"synonyms":["ok","this is way way too many words here yes","tiny"]}',
      "ok",
    );
    expect(out).toEqual(["tiny"]);
  });

  it("splits a comma-separated plain-text fallback", () => {
    const out = parseSynonymsResponse('large, huge, enormous', "big");
    expect(out).toEqual(["large", "huge", "enormous"]);
  });
});
