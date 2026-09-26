/**
 * Stale-suggestion protection tests (sections 16, 31, 60).
 *
 * Simulates the race condition:
 *   1. user types text A
 *   2. AI request begins
 *   3. user edits text → A becomes B
 *   4. AI response for A returns
 *
 * The tagged issue carries textHash(A). The current text is B, so
 * hashText(B) !== textHash(A), and the issue MUST be rejected.
 */

import { describe, expect, it } from "vitest";
import { hashText } from "../extension/src/shared/text-utils";

describe("stale-suggestion protection", () => {
  it("detects when text has changed since analysis", () => {
    const original = "I am going to the store.";
    const edited = "I am going to the grocery store.";
    const issueHash = hashText(original);
    const currentHash = hashText(edited);
    expect(issueHash).not.toBe(currentHash);
  });

  it("detects when text is unchanged", () => {
    const text = "She doesn't like it.";
    expect(hashText(text)).toBe(hashText(text));
  });

  it("includes settings + model in the cache key so changing the model invalidates old results", () => {
    const text = "Hello.";
    const hashWithModelA = hashText(text + "|neutral|model-a");
    const hashWithModelB = hashText(text + "|neutral|model-b");
    expect(hashWithModelA).not.toBe(hashWithModelB);
  });
});
