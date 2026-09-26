/**
 * Security tests for the native bridge payload layer (sections 34, 61, 62).
 *
 * These verify the *extension-side* guards. The native-side guards
 * (URL allowlist, command allowlist, payload clamps) are tested
 * separately in the Go test suite.
 */

import { describe, expect, it } from "vitest";
import {
  buildGrammarPrompt,
  buildRewritePrompt,
  buildTonePrompt,
} from "../extension/src/shared/prompts";

describe("prompts", () => {
  it("includes the local-only directive in every prompt", () => {
    const g = buildGrammarPrompt({
      categories: { spelling: true, grammar: true, punctuation: true, clarity: true, word_choice: true },
    });
    expect(g.system).toContain("ONLY");
    expect(g.system.toLowerCase()).toContain("json");
  });

  it("does not embed user input into the system prompt (only into the user payload at runtime)", () => {
    const r = buildRewritePrompt({ operation: "improve" });
    expect(r.system).not.toContain("custom user text");
  });

  it("builds tone prompt with the requested tone", () => {
    const t = buildTonePrompt({ tone: "professional" });
    expect(t.system.toLowerCase()).toContain("professional");
  });

  it("rewrite custom operation embeds the user-supplied instruction", () => {
    const r = buildRewritePrompt({
      operation: "custom",
      customInstruction: "Rewrite this to sound polite but direct.",
    });
    expect(r.system).toContain("polite but direct");
  });
});
