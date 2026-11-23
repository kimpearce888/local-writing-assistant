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
import {
  ANALYSIS_OPERATIONS,
  RewriteOperation,
  ToneMode,
} from "../extension/src/shared/types";

/** Every operation the side-panel menu can send to the host. */
const ALL_OPERATIONS: RewriteOperation[] = [
  "improve",
  "shorter",
  "clearer",
  "professional",
  "friendly",
  "formal",
  "simplify",
  "custom",
  "clean-up-notes",
  "descriptive",
  "detailed",
  "informative",
  "paraphrase",
  "summarize",
  "fix-mistakes",
  "fluent",
  "objective",
  "general-audience",
  "esl-audience",
  "expert-audience",
  "tldr",
  "bullets-to-prose",
  "main-point",
  "gaps",
  "improvement-ideas",
];

const ALL_TONES: ToneMode[] = [
  "neutral",
  "professional",
  "friendly",
  "formal",
  "casual",
  "concise",
  "confident",
  "anticipatory",
  "assertive",
  "compassionate",
  "constructive",
  "cooperative",
  "diplomatic",
  "empathetic",
  "inspirational",
  "exciting",
  "engaging",
  "persuasive",
  "direct",
];

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

  it("builds a valid prompt for every rewrite operation", () => {
    for (const op of ALL_OPERATIONS) {
      const { system } = buildRewritePrompt({ operation: op });
      expect(system, `op ${op}: must demand JSON`).toContain("JSON");
      expect(system, `op ${op}: must keep the local-only rules`).toContain("ONLY");
      expect(
        system,
        `op ${op}: must not contain an empty instruction slot`,
      ).not.toMatch(/\n\n\n/);
    }
  });

  it("analysis operations forbid rewriting the text", () => {
    for (const op of ALL_OPERATIONS) {
      const { system } = buildRewritePrompt({ operation: op });
      if (ANALYSIS_OPERATIONS.has(op)) {
        expect(system, `op ${op}: must mark the analysis request`).toContain(
          "This is an analysis request",
        );
      } else {
        expect(system, `op ${op}: must not mark an analysis request`).not.toContain(
          "This is an analysis request",
        );
      }
    }
  });

  it("builds a valid prompt for every tone mode", () => {
    for (const tone of ALL_TONES) {
      const { system } = buildTonePrompt({ tone });
      expect(system, `tone ${tone}: must demand JSON`).toContain("JSON");
      expect(
        system.toLowerCase(),
        `tone ${tone}: description must name the tone`,
      ).toContain(tone);
    }
  });
});
