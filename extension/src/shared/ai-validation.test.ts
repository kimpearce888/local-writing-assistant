import { describe, expect, it } from "vitest";
import { parseRewriteResponse } from "./ai-validation";

describe("parseRewriteResponse", () => {
  it("parses a well-formed JSON object", () => {
    const out = parseRewriteResponse(
      '{"rewritten":"Fixed text.","explanation":"Punctuation."}',
    );
    expect(out.rewritten).toBe("Fixed text.");
    expect(out.explanation).toBe("Punctuation.");
  });

  it("parses JSON wrapped in a markdown fence", () => {
    const out = parseRewriteResponse(
      '```json\n{"rewritten":"A.","explanation":"b"}\n```',
    );
    expect(out.rewritten).toBe("A.");
  });

  it("falls back to plain text when a small model ignores the JSON format", () => {
    const out = parseRewriteResponse(
      'That sentence is grammatically correct: "This is fine."',
    );
    expect(out.rewritten).toBe(
      'That sentence is grammatically correct: "This is fine."',
    );
    expect(out.explanation).toBe("model returned plain text (no JSON)");
  });

  it("still rejects an empty response", () => {
    expect(() => parseRewriteResponse("   ")).toThrow();
  });

  it("rejects a JSON array (not an object)", () => {
    expect(() => parseRewriteResponse('[1,2]')).toThrow();
  });
});
