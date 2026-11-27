/**
 * Tests for validateSettings (shared/storage.ts).
 *
 * Settings arrive from untrusted sources (popup messages, imported JSON
 * files). validateSettings must drop unknown keys, coerce types, clamp
 * numeric ranges, and reject unknown tone values / invalid URLs.
 */

import { describe, expect, it } from "vitest";
import { validateSettings } from "../extension/src/shared/storage";
import { DEFAULT_SETTINGS } from "../extension/src/shared/types";

describe("validateSettings", () => {
  it("returns an empty object for non-object input", () => {
    expect(validateSettings(null)).toEqual({});
    expect(validateSettings([1, 2])).toEqual({});
    expect(validateSettings("nope")).toEqual({});
    expect(validateSettings(undefined)).toEqual({});
  });

  it("keeps known keys with valid values", () => {
    const out = validateSettings({ enabled: false, temperature: 0.7, model: "gpt-x" });
    expect(out).toEqual({ enabled: false, temperature: 0.7, model: "gpt-x" });
  });

  it("drops unknown keys entirely", () => {
    const out = validateSettings({ __proto__: {}, evil: "x", enabled: true });
    expect(out).toEqual({ enabled: true });
    expect("evil" in out).toBe(false);
    // Prototype-pollution style keys must never survive as own properties.
    const polluted = JSON.parse('{"__proto__":{"polluted":1},"enabled":true}');
    const safe = validateSettings(polluted);
    expect(Object.getOwnPropertyNames(safe)).toEqual(["enabled"]);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("coerces booleans strictly (strings are rejected)", () => {
    const out = validateSettings({ enabled: "yes" });
    expect(out).toEqual({ enabled: true }); // falls back to default true, key kept
    const out2 = validateSettings({ enabled: 0 });
    expect(out2).toEqual({ enabled: true });
    const out3 = validateSettings({ enabled: false });
    expect(out3).toEqual({ enabled: false });
  });

  it("clamps numeric fields to their ranges", () => {
    const out = validateSettings({
      maxTextSize: -999999,
      temperature: "abc",
      debounceMs: 99999,
      maxTokens: 0,
      minConfidence: 5,
      requestTimeoutMs: 1,
    });
    expect(out.maxTextSize).toBe(100);
    expect(out.temperature).toBe(DEFAULT_SETTINGS.temperature); // NaN → default
    expect(out.debounceMs).toBe(5000);
    expect(out.maxTokens).toBe(1);
    expect(out.minConfidence).toBe(1);
    expect(out.requestTimeoutMs).toBe(1000);
  });

  it("accepts numeric strings for numeric fields", () => {
    const out = validateSettings({ temperature: "0.5", debounceMs: "300" });
    expect(out.temperature).toBe(0.5);
    expect(out.debounceMs).toBe(300);
  });

  it("rejects unknown tone values and keeps known ones", () => {
    expect(validateSettings({ tone: "sassy" })).toEqual({});
    expect(validateSettings({ tone: "formal" })).toEqual({ tone: "formal" });
    expect(validateSettings({ tone: "diplomatic" })).toEqual({ tone: "diplomatic" });
  });

  it("rejects invalid lmStudioUrl values", () => {
    expect(validateSettings({ lmStudioUrl: "ftp://x" })).toEqual({});
    expect(validateSettings({ lmStudioUrl: "not a url" })).toEqual({});
    expect(validateSettings({ lmStudioUrl: "javascript:alert(1)" })).toEqual({});
    expect(validateSettings({ lmStudioUrl: "http://127.0.0.1:1234" })).toEqual({
      lmStudioUrl: "http://127.0.0.1:1234",
    });
    expect(validateSettings({ lmStudioUrl: "https://192.168.1.10:1234" })).toEqual({
      lmStudioUrl: "https://192.168.1.10:1234",
    });
  });

  it("truncates over-long model names", () => {
    const out = validateSettings({ model: "x".repeat(500) });
    expect((out.model as string).length).toBe(200);
  });

  it("coerces enableSnippets strictly (snippets lifecycle safety)", () => {
    expect(validateSettings({ enableSnippets: false })).toEqual({ enableSnippets: false });
    expect(validateSettings({ enableSnippets: "off" })).toEqual({ enableSnippets: true });
    // Disabling is a boolean gate only — data is never touched here.
  });

  it("sanitizes snippetTriggerPrefix (0-3 chars, whitespace stripped)", () => {
    expect(validateSettings({ snippetTriggerPrefix: ";" })).toEqual({ snippetTriggerPrefix: ";" });
    expect(validateSettings({ snippetTriggerPrefix: "@@" })).toEqual({ snippetTriggerPrefix: "@@" });
    expect(validateSettings({ snippetTriggerPrefix: "" })).toEqual({ snippetTriggerPrefix: "" });
    expect(validateSettings({ snippetTriggerPrefix: ";;;" })).toEqual({ snippetTriggerPrefix: ";;;" });
    // Over-long prefixes are sliced to 3 chars.
    expect(validateSettings({ snippetTriggerPrefix: ";;;;;" })).toEqual({ snippetTriggerPrefix: ";;;" });
    // Whitespace cannot survive — the prefix must be typeable as a tight run.
    expect(validateSettings({ snippetTriggerPrefix: "a b" })).toEqual({ snippetTriggerPrefix: "ab" });
    expect(validateSettings({ snippetTriggerPrefix: "   " })).toEqual({ snippetTriggerPrefix: "" });
    // Non-strings fall back to the default ";".
    expect(validateSettings({ snippetTriggerPrefix: 42 })).toEqual({ snippetTriggerPrefix: ";" });
  });
});
