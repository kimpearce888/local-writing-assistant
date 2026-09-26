/**
 * Unit tests for the strict AI response parser/validator.
 *
 * Per spec section 65 / 61 / 62, we treat all model output as
 * completely untrusted. These tests confirm we reject malformed,
 * oversized, out-of-range, and HTML-injecting payloads.
 */

import { describe, expect, it } from "vitest";
import { escapeHtml, parseGrammarResponse, parseRewriteResponse } from "../extension/src/shared/ai-validation";

describe("parseGrammarResponse", () => {
  it("accepts a well-formed response", () => {
    const text = "She don't like it.";
    const raw = JSON.stringify({
      issues: [
        {
          id: "issue-1",
          start: 4,
          end: 9,
          original: "don't",
          replacement: "doesn't",
          category: "grammar",
          explanation: "Subject-verb agreement.",
          confidence: 0.9,
        },
      ],
      correctedText: "She doesn't like it.",
    });
    const result = parseGrammarResponse(raw, text);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].replacement).toBe("doesn't");
    expect(result.textHash).toBeTruthy();
  });

  it("rejects non-object output", () => {
    expect(() => parseGrammarResponse("not json", "hello")).toThrow();
    expect(() => parseGrammarResponse("[1,2,3]", "hello")).toThrow();
  });

  it("drops issues whose offsets don't match the original text", () => {
    const text = "Hello world.";
    const raw = JSON.stringify({
      issues: [
        {
          id: "issue-1",
          start: 0,
          end: 5,
          original: "WRONG", // doesn't match slice(0,5) which is "Hello"
          replacement: "Bye",
          category: "grammar",
          explanation: "x",
          confidence: 0.9,
        },
      ],
    });
    const result = parseGrammarResponse(raw, text);
    expect(result.issues).toHaveLength(0);
  });

  it("drops issues with unknown categories", () => {
    const text = "Hello world.";
    const raw = JSON.stringify({
      issues: [
        {
          id: "issue-1",
          start: 0,
          end: 5,
          original: "Hello",
          replacement: "Hi",
          category: "FAKE_CATEGORY",
          explanation: "x",
          confidence: 0.9,
        },
      ],
    });
    const result = parseGrammarResponse(raw, text);
    expect(result.issues).toHaveLength(0);
  });

  it("drops issues with confidence outside [0,1]", () => {
    const text = "Hello world.";
    const raw = JSON.stringify({
      issues: [
        {
          id: "issue-1",
          start: 0,
          end: 5,
          original: "Hello",
          replacement: "Hi",
          category: "style",
          explanation: "x",
          confidence: 1.5,
        },
      ],
    });
    const result = parseGrammarResponse(raw, text);
    expect(result.issues).toHaveLength(0);
  });

  it("strips code fences if the model wrapped its JSON", () => {
    const text = "Hello world.";
    const inner = JSON.stringify({
      issues: [],
      correctedText: "",
    });
    const raw = "```json\n" + inner + "\n```";
    const result = parseGrammarResponse(raw, text);
    expect(result.issues).toEqual([]);
  });

  it("caps the number of issues at 20", () => {
    const text = "a".repeat(20) + ".";
    const issues: unknown[] = [];
    for (let i = 0; i < 30; i++) {
      issues.push({
        id: `issue-${i}`,
        start: i,
        end: i + 1,
        original: "a",
        replacement: "b",
        category: "style",
        explanation: "x",
        confidence: 0.9,
      });
    }
    const raw = JSON.stringify({ issues });
    const result = parseGrammarResponse(raw, text);
    expect(result.issues.length).toBeLessThanOrEqual(20);
  });
});

describe("parseRewriteResponse", () => {
  it("accepts a well-formed rewrite response", () => {
    const raw = JSON.stringify({
      rewritten: "Hello there.",
      explanation: "Made friendlier.",
    });
    const r = parseRewriteResponse(raw);
    expect(r.rewritten).toBe("Hello there.");
    expect(r.explanation).toBe("Made friendlier.");
  });

  it("rejects a response missing 'rewritten'", () => {
    expect(() => parseRewriteResponse(JSON.stringify({ foo: "bar" }))).toThrow();
  });

  it("rejects non-object output", () => {
    expect(() => parseRewriteResponse("just text")).toThrow();
  });
});

describe("escapeHtml", () => {
  it("escapes script tags", () => {
    const escaped = escapeHtml("<script>alert(1)</script>");
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
  });

  it("escapes quotes and ampersands", () => {
    expect(escapeHtml(`a & "b" 'c'`)).toBe("a &amp; &quot;b&quot; &#39;c&#39;");
  });
});
