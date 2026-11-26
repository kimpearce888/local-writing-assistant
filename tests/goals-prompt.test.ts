/**
 * Tests for the Writing-goals prompt block (Grammarly parity) and the new
 * tone-detect / synonyms / continue prompt builders.
 */

import { describe, expect, it } from "vitest";
import {
  buildGoalsBlock,
  buildGrammarPrompt,
  buildSynonymsPrompt,
  buildToneDetectPrompt,
  buildRewritePrompt,
} from "../extension/src/shared/prompts";
import { DEFAULT_GOALS } from "../extension/src/shared/types";

describe("buildGoalsBlock", () => {
  it("returns empty string when goals are omitted", () => {
    expect(buildGoalsBlock(undefined)).toBe("");
  });

  it("renders all four goal dimensions", () => {
    const block = buildGoalsBlock({
      dialect: "uk",
      audience: "expert",
      formality: "formal",
      domain: "academic",
    });
    expect(block).toContain("UK English");
    expect(block).toContain("Audience: expert");
    expect(block).toContain("Formality: formal");
    expect(block).toContain("Domain: academic");
  });

  it("renders defaults for the default goal set", () => {
    const block = buildGoalsBlock(DEFAULT_GOALS);
    expect(block).toContain("US English");
    expect(block).toContain("Audience: general");
    expect(block).toContain("Formality: neutral");
    expect(block).toContain("Domain: general");
  });
});

describe("buildGrammarPrompt with goals", () => {
  it("embeds the goals block into the system prompt", () => {
    const p = buildGrammarPrompt({
      categories: { spelling: true, grammar: true, punctuation: true, clarity: true, word_choice: true },
      goals: { dialect: "au", audience: "knowledgeable", formality: "informal", domain: "email" },
    });
    expect(p.system).toContain("Australian English");
    expect(p.system).toContain("Audience: knowledgeable");
    expect(p.system).toContain("Enabled categories: spelling, grammar, punctuation, clarity, word_choice");
    expect(p.system).toContain('"issues"');
  });

  it("omits the goals block when goals are not supplied", () => {
    const p = buildGrammarPrompt({
      categories: { spelling: true, grammar: true, punctuation: true, clarity: true, word_choice: true },
    });
    expect(p.system).not.toContain("Writing goals");
  });
});

describe("new prompt builders", () => {
  it("buildToneDetectPrompt lists the tone vocabulary and JSON shape", () => {
    const p = buildToneDetectPrompt();
    expect(p.system).toContain("TONE DETECTOR");
    expect(p.system).toContain("confident");
    expect(p.system).toContain('"tones"');
  });

  it("buildSynonymsPrompt includes word context and the synonyms shape", () => {
    const p = buildSynonymsPrompt({ word: "quick", context: "a quick brown fox" });
    expect(p.system).toContain("thesaurus");
    expect(p.system).toContain("a quick brown fox");
    expect(p.system).toContain('"synonyms"');
  });

  it("buildSynonymsPrompt omits context when not provided", () => {
    const p = buildSynonymsPrompt({ word: "quick" });
    expect(p.system).not.toContain("<context>");
  });

  it("continue op instructs continuation without repeating the text", () => {
    const p = buildRewritePrompt({ operation: "continue" });
    expect(p.system).toContain("Continue writing");
    expect(p.system).toMatch(/output ONLY the continuation/i);
    expect(p.system).toContain('"rewritten"');
  });
});
