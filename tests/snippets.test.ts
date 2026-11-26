/**
 * Unit tests for the snippets (text expansion) module — the pure
 * matcher, shortcut normalization, and input sanitization that
 * storage + content script + side panel all rely on.
 */

import { describe, expect, it } from "vitest";
import {
  SNIPPET_LIMITS,
  Snippet,
  findSnippetMatch,
  makeSnippetId,
  normalizeShortcut,
  sanitizeSnippetInput,
} from "../extension/src/shared/snippets";

function snip(shortcut: string, content = `EXPANDED-${shortcut}`, label = ""): Snippet {
  return { id: `id-${shortcut}`, shortcut, content, label, createdAt: 0 };
}

describe("normalizeShortcut", () => {
  it("trims, lowercases, and strips all whitespace", () => {
    expect(normalizeShortcut("  SIG ")).toBe("sig");
    expect(normalizeShortcut("my\t key")).toBe("mykey");
  });

  it("rejects non-strings and empty results", () => {
    expect(normalizeShortcut(42)).toBe("");
    expect(normalizeShortcut(null)).toBe("");
    expect(normalizeShortcut("   ")).toBe("");
  });

  it("caps length to the limit", () => {
    const long = "a".repeat(50);
    expect(normalizeShortcut(long).length).toBe(SNIPPET_LIMITS.maxShortcutLen);
  });
});

describe("sanitizeSnippetInput", () => {
  it("accepts a valid pair and normalizes the shortcut", () => {
    const out = sanitizeSnippetInput({ shortcut: " Sig ", content: "Best regards,\nKim" });
    expect(out).not.toBeNull();
    expect(out?.shortcut).toBe("sig");
    expect(out?.content).toBe("Best regards,\nKim");
    expect(out?.label).toBe("");
  });

  it("rejects empty shortcut, non-string content, and blank content", () => {
    expect(sanitizeSnippetInput({ shortcut: "", content: "x" })).toBeNull();
    expect(sanitizeSnippetInput({ shortcut: "sig", content: 123 })).toBeNull();
    expect(sanitizeSnippetInput({ shortcut: "sig", content: "   " })).toBeNull();
  });

  it("trims the label and caps content length", () => {
    const out = sanitizeSnippetInput({
      shortcut: "sig",
      content: "x".repeat(SNIPPET_LIMITS.maxContentLen + 500),
      label: "  my label  ",
    });
    expect(out?.content.length).toBe(SNIPPET_LIMITS.maxContentLen);
    expect(out?.label).toBe("my label");
  });
});

describe("findSnippetMatch", () => {
  const snippets = [snip("sig", "SIGNATURE"), snip("sig2", "SIGNATURE-TWO"), snip("addr", "ADDRESS")];

  it("matches the full trigger run at the end of the text", () => {
    const m = findSnippetMatch("hello ;sig", snippets, ";");
    expect(m).not.toBeNull();
    expect(m?.snippet.content).toBe("SIGNATURE");
    expect(m?.start).toBe(6);
    expect(m?.end).toBe(10);
  });

  it("is case-insensitive on the typed shortcut", () => {
    expect(findSnippetMatch("hello ;SIG", snippets, ";")?.snippet.content).toBe("SIGNATURE");
    expect(findSnippetMatch("hello ;SiG", snippets, ";")?.snippet.content).toBe("SIGNATURE");
  });

  it("never matches mid-word (word boundary before the prefix)", () => {
    expect(findSnippetMatch("abc;sig", snippets, ";")).toBeNull();
    expect(findSnippetMatch("abc;addr", snippets, ";")).toBeNull();
  });

  it("matches after whitespace, punctuation, and at text start", () => {
    expect(findSnippetMatch("abc ;sig", snippets, ";")).not.toBeNull();
    expect(findSnippetMatch("abc(;addr", snippets, ";")).not.toBeNull();
    expect(findSnippetMatch(";sig", snippets, ";")).not.toBeNull();
  });

  it("prefers the longest shortcut when several match", () => {
    expect(findSnippetMatch("hello ;sig2", snippets, ";")?.snippet.content).toBe("SIGNATURE-TWO");
  });

  it("supports an empty trigger prefix with boundary on the shortcut itself", () => {
    const s = [snip("br", "Best regards")];
    // Mid-word: the character before the run is a letter — never expands.
    expect(findSnippetMatch("abrabr", s, "")).toBeNull();
    // After whitespace / punctuation / at text start — expands.
    expect(findSnippetMatch("thanks br", s, "")?.snippet.content).toBe("Best regards");
    expect(findSnippetMatch("(br", s, "")?.snippet.content).toBe("Best regards");
    expect(findSnippetMatch("br", s, "")?.snippet.content).toBe("Best regards");
    // The run must be the actual tail of the text.
    expect(findSnippetMatch("abrabr ", s, "")).toBeNull();
    expect(findSnippetMatch("br)", s, "")).toBeNull();
  });

  it("returns null for empty text, empty list, or no match", () => {
    expect(findSnippetMatch("", snippets, ";")).toBeNull();
    expect(findSnippetMatch("hello ;sig", [], ";")).toBeNull();
    expect(findSnippetMatch("hello ;nope", snippets, ";")).toBeNull();
    // A prefix alone never matches.
    expect(findSnippetMatch("hello ;", snippets, ";")).toBeNull();
  });

  it("handles multi-character prefixes", () => {
    expect(findSnippetMatch("hello @@sig", snippets, "@@")?.snippet.content).toBe("SIGNATURE");
    expect(findSnippetMatch("hello @@sig", snippets, ";")).toBeNull();
  });

  it("treats non-string prefix defensively", () => {
    expect(findSnippetMatch("hello ;sig", snippets, undefined as unknown as string)?.snippet.content).toBe(
      "SIGNATURE",
    );
  });
});

describe("makeSnippetId", () => {
  it("produces unique, prefixed ids", () => {
    const a = makeSnippetId();
    const b = makeSnippetId();
    expect(a).not.toBe(b);
    expect(a.startsWith("snip-")).toBe(true);
  });
});
