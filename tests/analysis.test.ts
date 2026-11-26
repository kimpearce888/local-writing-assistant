/**
 * Tests for the local text-statistics engine (shared/analysis.ts).
 */

import { describe, expect, it } from "vitest";
import { computeTextStats, describeReadingEase } from "../extension/src/shared/analysis";

describe("computeTextStats", () => {
  it("returns a zeroed bundle for empty text", () => {
    const s = computeTextStats("");
    expect(s.words).toBe(0);
    expect(s.sentences).toBe(0);
    expect(s.paragraphs).toBe(0);
    expect(s.readingMinutes).toBe(0);
    expect(s.speakingMinutes).toBe(0);
    expect(s.fleschReadingEase).toBe(100);
    expect(s.fleschGrade).toBe(0);
    expect(s.readabilityLabel).toBe("Very easy");
  });

  it("counts words, sentences and paragraphs", () => {
    const s = computeTextStats(
      "Hello world. This is a second sentence!\n\nA new paragraph here?",
    );
    expect(s.words).toBe(11);
    expect(s.sentences).toBe(3);
    expect(s.paragraphs).toBe(2);
    expect(s.characters).toBe(62);
  });

  it("computes vocabulary richness", () => {
    const s = computeTextStats("cat cat cat dog");
    expect(s.words).toBe(4);
    expect(s.uniqueWords).toBe(2);
    expect(s.vocabularyRichness).toBe(0.5);
  });

  it("counts hyphenated and apostrophe words as single words", () => {
    const s = computeTextStats("well-known e-commerce user's guide");
    expect(s.words).toBe(4);
  });

  it("flags long sentences (>30 words)", () => {
    const long = Array.from({ length: 35 }, (_, i) => `w${i}`).join(" ") + ".";
    const short = "Short one here.";
    const s = computeTextStats(`${long} ${short}`);
    expect(s.longSentences).toBe(1);
    expect(s.sentences).toBe(2);
  });

  it("produces a readable Flesch score for simple prose", () => {
    const s = computeTextStats("The cat sat on the mat. It was warm.");
    // Very simple text must be on the easy end of the scale.
    expect(s.fleschReadingEase).toBeGreaterThan(70);
    expect(s.fleschGrade).toBeLessThan(6);
  });

  it("produces a difficult score for complex prose", () => {
    const s = computeTextStats(
      "Implementation considerations pertaining to the characterization of multifactorial determinants necessitate comprehensive evaluation of interdependent systemic variables.",
    );
    expect(s.fleschReadingEase).toBeLessThan(50);
    expect(s.readabilityLabel).toMatch(/difficult/i);
  });

  it("estimates reading/speaking time from word count", () => {
    // 238 words ≈ 1.0 reading minute, 150 words ≈ 1.0 speaking minute.
    const text = Array.from({ length: 238 }, () => "word").join(" ");
    const s = computeTextStats(text);
    expect(s.readingMinutes).toBe(1);
    expect(s.speakingMinutes).toBe(1.6); // 238/150 = 1.59
  });
});

describe("describeReadingEase", () => {
  it("maps Flesch bands to labels", () => {
    expect(describeReadingEase(95)).toBe("Very easy");
    expect(describeReadingEase(85)).toBe("Easy");
    expect(describeReadingEase(75)).toBe("Fairly easy");
    expect(describeReadingEase(65)).toBe("Plain English");
    expect(describeReadingEase(55)).toBe("Fairly difficult");
    expect(describeReadingEase(40)).toBe("Difficult");
    expect(describeReadingEase(10)).toBe("Very difficult");
  });
});
