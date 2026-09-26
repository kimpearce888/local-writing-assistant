/**
 * @vitest-environment jsdom
 *
 * Sensitive-field detection tests (section 21).
 */

import { describe, expect, it } from "vitest";
import { isSensitiveField, isUnsupportedEditor } from "../extension/src/content/adapters/adapter";

function makeInput(attrs: Record<string, string>): HTMLInputElement {
  const el = document.createElement("input");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

describe("sensitive-field detection", () => {
  it("flags password fields", () => {
    expect(isSensitiveField(makeInput({ type: "password" }))).toBe(true);
  });

  it("flags hidden fields", () => {
    expect(isSensitiveField(makeInput({ type: "hidden" }))).toBe(true);
  });

  it("flags API-key-like names", () => {
    expect(isSensitiveField(makeInput({ type: "text", name: "api_key" }))).toBe(true);
    expect(isSensitiveField(makeInput({ type: "text", name: "access_token" }))).toBe(true);
    expect(isSensitiveField(makeInput({ type: "text", name: "client_secret" }))).toBe(true);
  });

  it("flags credit-card fields via autocomplete", () => {
    expect(isSensitiveField(makeInput({ type: "text", autocomplete: "cc-number" }))).toBe(true);
    expect(isSensitiveField(makeInput({ type: "text", autocomplete: "cc-csc" }))).toBe(true);
  });

  it("does not flag normal text fields", () => {
    expect(isSensitiveField(makeInput({ type: "text", name: "comment" }))).toBe(false);
    expect(isSensitiveField(makeInput({ type: "email", name: "email" }))).toBe(false);
  });

  it("does not flag placeholder unrelated text", () => {
    expect(isSensitiveField(makeInput({ type: "text", placeholder: "Search…" }))).toBe(false);
  });
});

describe("unsupported-editor detection", () => {
  it("flags elements inside Monaco containers", () => {
    document.body.innerHTML = `<div class="monaco-editor">
      <textarea data-foo="bar"></textarea>
    </div>`;
    const inner = document.querySelector("textarea") as HTMLElement;
    expect(inner).toBeTruthy();
    expect(isUnsupportedEditor(inner)).toBe(true);
    document.body.innerHTML = "";
  });

  it("flags elements inside CodeMirror containers", () => {
    document.body.innerHTML = `<div class="CodeMirror">
      <textarea></textarea>
    </div>`;
    const inner = document.querySelector("textarea") as HTMLElement;
    expect(isUnsupportedEditor(inner)).toBe(true);
    document.body.innerHTML = "";
  });

  it("does not flag a normal textarea", () => {
    document.body.innerHTML = `<textarea id="t"></textarea>`;
    const inner = document.querySelector("textarea") as HTMLElement;
    expect(isUnsupportedEditor(inner)).toBe(false);
    document.body.innerHTML = "";
  });
});
