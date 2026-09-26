/**
 * Tests for the text utilities (hash, sentence splitting, context window).
 */

import { describe, expect, it } from "vitest";
import {
  contextWindow,
  hashText,
  normalizeText,
  splitSentences,
} from "../extension/src/shared/text-utils";

describe("hashText", () => {
  it("returns a deterministic string for the same input", () => {
    expect(hashText("hello")).toBe(hashText("hello"));
  });

  it("returns different strings for different inputs", () => {
    expect(hashText("hello")).not.toBe(hashText("hello!"));
  });

  it("is a non-empty string", () => {
    expect(hashText("anything").length).toBeGreaterThan(0);
  });
});

describe("splitSentences", () => {
  it("splits on periods and newlines", () => {
    const parts = splitSentences("Hello world. This is a test.\nThird sentence.");
    expect(parts.length).toBe(3);
  });

  it("handles empty input", () => {
    expect(splitSentences("")).toEqual([]);
  });

  it("handles trailing punctuation", () => {
    expect(splitSentences("Hi there!")).toEqual(["Hi there!"]);
  });
});

describe("contextWindow", () => {
  it("returns before/after slices around the offset", () => {
    const text = "abcdefghij";
    const { before, after } = contextWindow(text, 5, 4);
    // window of 4 centered on offset 5: start = 5-floor(4/2) = 3, end = 5+ceil(4/2) = 7
    // before = slice(3,5) = "de", after = slice(5,7) = "fg"
    expect(before).toBe("de");
    expect(after).toBe("fg");
  });

  it("clamps to text boundaries", () => {
    const text = "abc";
    const { before, after } = contextWindow(text, 0, 100);
    expect(before).toBe("");
    expect(after).toBe("abc");
  });
});

describe("normalizeText", () => {
  it("strips control characters but keeps newlines", () => {
    expect(normalizeText("a\u0007b\nc\u000Bd")).toBe("ab\ncd");
  });
});
