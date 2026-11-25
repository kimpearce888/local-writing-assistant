/**
 * Tests for truncateToUtf8Bytes (shared/text-utils.ts).
 *
 * The native host clamps payloads by UTF-8 byte count; the extension must
 * measure in the same unit so returned offsets stay consistent.
 */

import { describe, expect, it } from "vitest";
import { truncateToUtf8Bytes } from "../extension/src/shared/text-utils";

describe("truncateToUtf8Bytes", () => {
  it("returns the input unchanged when it fits", () => {
    expect(truncateToUtf8Bytes("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  it("returns the input unchanged when exactly at the limit", () => {
    expect(truncateToUtf8Bytes("hello", 5)).toEqual({ text: "hello", truncated: false });
  });

  it("truncates ASCII by byte count", () => {
    const r = truncateToUtf8Bytes("abcdef", 4);
    expect(r.text).toBe("abcd");
    expect(r.truncated).toBe(true);
  });

  it("counts two-byte characters correctly", () => {
    // é is 2 bytes in UTF-8
    expect(truncateToUtf8Bytes("ééé", 4).text).toBe("éé");
    expect(truncateToUtf8Bytes("ééé", 4).truncated).toBe(true);
  });

  it("counts three-byte characters correctly", () => {
    // 中 is 3 bytes in UTF-8
    expect(truncateToUtf8Bytes("中中中", 7).text).toBe("中中");
  });

  it("never splits a surrogate pair", () => {
    // 😀 is one astral code point = 4 UTF-8 bytes = 2 UTF-16 units
    const r = truncateToUtf8Bytes("a😀b", 3); // 'a' + first half of 😀 doesn't fit
    expect(r.text).toBe("a");
    expect(r.truncated).toBe(true);
    const r2 = truncateToUtf8Bytes("a😀b", 5); // a + 😀 = 5 bytes
    expect(r2.text).toBe("a😀");
    // The cut is a valid UTF-16 boundary — re-encoding is lossless.
    expect(new TextEncoder().encode(r2.text).length).toBe(5);
  });

  it("produces text whose UTF-8 encoding never exceeds the limit", () => {
    const mixed = "ascii 中文 émojis 😀😀 and more text to truncate here";
    for (const limit of [0, 1, 2, 3, 4, 5, 7, 8, 11, 12, 20, 33, 50]) {
      const { text } = truncateToUtf8Bytes(mixed, limit);
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(limit);
    }
  });

  it("handles empty and zero-limit inputs", () => {
    expect(truncateToUtf8Bytes("", 10)).toEqual({ text: "", truncated: false });
    expect(truncateToUtf8Bytes("abc", 0)).toEqual({ text: "", truncated: true });
  });
});
