/**
 * Tests for the offline fast-check rule engine (shared/local-check.ts).
 *
 * Contract under test:
 *  - Offset invariant: text.slice(start, end) === original for every issue.
 *  - HIGH PRECISION: every documented exception is honored (allowlisted
 *    doubled words, article sound exceptions, i.e., enumerations, URLs,
 *    thousand separators, Markdown line breaks…).
 *  - Category toggles gate the rule groups.
 *  - Output is sorted by start and non-overlapping.
 *  - mergeIssues() lets primary (model) issues win overlaps and fills
 *    gaps with secondary (local) issues.
 */

import { describe, expect, it } from "vitest";
import { localCheck, mergeIssues } from "../extension/src/shared/local-check";
import { Issue } from "../extension/src/shared/types";

const ALL = { spelling: true, grammar: true, punctuation: true };
const NONE = { spelling: false, grammar: false, punctuation: false };

function find(text: string, sub: string): Issue | undefined {
  return localCheck(text, ALL).find((i) => i.original === sub);
}

describe("offset invariant + shape", () => {
  const sample =
    "i think teh report is done,however  there is a apple on the desk . " +
    "You should of seen it!TEH end is near forreal,i swear. Visit http://example.com/a,b?q=1 for info.";

  it("every issue satisfies text.slice(start,end) === original", () => {
    const issues = localCheck(sample, ALL);
    expect(issues.length).toBeGreaterThan(3);
    for (const issue of issues) {
      expect(sample.slice(issue.start, issue.end)).toBe(issue.original);
    }
  });

  it("issues are sorted by start and non-overlapping", () => {
    const issues = localCheck(sample, ALL);
    for (let i = 1; i < issues.length; i++) {
      expect(issues[i].start).toBeGreaterThanOrEqual(issues[i - 1].end);
    }
  });

  it("issues carry ids, categories, explanations and confidence", () => {
    const issues = localCheck("teh cat", ALL);
    const issue = issues[0];
    expect(issue.id).toMatch(/^local-/);
    expect(issue.category).toBe("spelling");
    expect(issue.explanation).toContain("the");
    expect(issue.confidence).toBeGreaterThan(0);
    expect(issue.confidence).toBeLessThanOrEqual(1);
  });

  it("empty/whitespace text produces no issues and never crashes", () => {
    expect(localCheck("", ALL)).toEqual([]);
    expect(localCheck("   \n\t  ", ALL)).toEqual([]);
  });
});

describe("misspellings", () => {
  it.each([
    ["teh", "the"],
    ["recieve", "receive"],
    ["definately", "definitely"],
    ["seperate", "separate"],
    ["alot", "a lot"],
    ["aswell", "as well"],
    ["eachother", "each other"],
    ["noone", "no one"],
    ["untill", "until"],
    ["occured", "occurred"],
  ])("flags %s → %s", (wrong, right) => {
    const issue = find(`this is ${wrong} here`, wrong);
    expect(issue).toBeDefined();
    expect(issue!.replacement).toBe(right);
    expect(issue!.category).toBe("spelling");
  });

  it("preserves capitalization (Teh → The, TEH → THE)", () => {
    expect(find("Teh plan works", "Teh")!.replacement).toBe("The");
    expect(find("TEH plan works", "TEH")!.replacement).toBe("THE");
  });

  it("does not flag correct words or substrings inside words", () => {
    const issues = localCheck(
      "the reception achieved success, but overall the atmosphere remained",
      ALL,
    );
    expect(issues).toEqual([]);
  });
});

describe("doubled words", () => {
  it("flags an immediate repeat", () => {
    const issue = find("This is is a test", "is is");
    expect(issue).toBeDefined();
    expect(issue!.replacement).toBe("is");
    expect(issue!.category).toBe("grammar");
  });

  it("flags case-insensitive repeats (The the → The)", () => {
    const issue = find("The the answer came", "The the");
    expect(issue).toBeDefined();
    expect(issue!.replacement).toBe("The");
  });

  it("allowlists legitimate doubles", () => {
    expect(localCheck("I had had enough", ALL)).toEqual([]);
    expect(localCheck("She said that that house was sold", ALL)).toEqual([]);
  });

  it("does not flag repeats across a newline", () => {
    expect(localCheck("and\nand", ALL)).toEqual([]);
  });

  it("does not flag words merely containing the same letters", () => {
    expect(localCheck("the theory is the theater", ALL)).toEqual([]);
  });
});

describe("article agreement (a/an)", () => {
  it.each([
    ["a apple", "a", "an"],
    ["A elephant", "A", "An"],
    ["a idea", "a", "an"],
    ["a hour", "a", "an"],
  ])("flags %s", (text, article, replacement) => {
    const issue = find(`${text} on the table`, article);
    expect(issue).toBeDefined();
    expect(issue!.replacement).toBe(replacement);
    expect(issue!.category).toBe("grammar");
  });

  it("flags 'an' before consonant sounds", () => {
    const issue = find("an banana peel", "an");
    expect(issue).toBeDefined();
    expect(issue!.replacement).toBe("a");
  });

  it("keeps 'a' before consonant-sound vowels (university, one, European)", () => {
    expect(localCheck("a university degree", ALL)).toEqual([]);
    expect(localCheck("a one-time offer", ALL)).toEqual([]);
    expect(localCheck("a European tour", ALL)).toEqual([]);
    expect(localCheck("a useful tool", ALL)).toEqual([]);
    expect(localCheck("a unique design", ALL)).toEqual([]);
  });

  it("keeps 'an' before silent-h and x words", () => {
    expect(localCheck("an hour ago", ALL)).toEqual([]);
    expect(localCheck("an honest answer", ALL)).toEqual([]);
    expect(localCheck("an heir", ALL)).toEqual([]);
    expect(localCheck("an x-ray", ALL)).toEqual([]);
  });
});

describe("modal + of", () => {
  it.each(["should", "could", "would", "must", "might"])(
    "flags '%s of' → '%s have'",
    (modal) => {
      const issue = find(`I ${modal} of done it`, `${modal} of`);
      expect(issue).toBeDefined();
      expect(issue!.replacement).toBe(`${modal} have`);
    },
  );
  it("preserves capitalization", () => {
    const issue = find("You Should of known", "Should of");
    expect(issue!.replacement).toBe("Should have");
  });

  it("never touches legitimate 'of' phrases", () => {
    expect(localCheck("that kind of thing", ALL)).toEqual([]);
    expect(localCheck("of course", ALL)).toEqual([]);
    expect(localCheck("out of the woods", ALL)).toEqual([]);
  });
});

describe("lowercase pronoun i", () => {
  it("flags a standalone lowercase i", () => {
    const issue = find("and i said no", "i");
    expect(issue).toBeDefined();
    expect(issue!.replacement).toBe("I");
    expect(issue!.category).toBe("grammar");
  });

  it("flags a sentence-initial lowercase i", () => {
    expect(find("i think so", "i")).toBeDefined();
  });

  it("protects i.e.", () => {
    expect(localCheck("see the docs, i.e. the manual", ALL)).toEqual([]);
  });

  it("protects enumerations (part i, (i))", () => {
    expect(localCheck("see part i for details", ALL)).toEqual([]);
    expect(localCheck("in section ii, and (i) above", ALL)).toEqual([]);
  });

  it("leaves capital I and tokens containing i alone", () => {
    expect(localCheck("I think it is fine", ALL)).toEqual([]);
    expect(localCheck("it is in the middle", ALL)).toEqual([]);
  });
});

describe("punctuation spacing", () => {
  it("removes a space before sentence punctuation", () => {
    const issue = find("Done . We ship", " .");
    expect(issue).toBeDefined();
    expect(issue!.replacement).toBe(".");
  });

  it("adds a space after a comma between letters", () => {
    const issue = find("cats,dogs and birds", ",");
    expect(issue).toBeDefined();
    expect(issue!.replacement).toBe(", ");
  });

  it("collapses runs of spaces between words", () => {
    const issue = find("too   many spaces", "   ");
    expect(issue).toBeDefined();
    expect(issue!.replacement).toBe(" ");
  });

  it("never breaks decimals, thousands, URLs, or versions", () => {
    expect(localCheck("pi is 3.14 not 3 . 1 4", ALL)).toEqual([]);
    expect(localCheck("1,000 people", ALL)).toEqual([]);
    expect(localCheck("see http://example.com/a,b?q=1 today", ALL)).toEqual([]);
    expect(localCheck("see www.example.com/x,y for details", ALL)).toEqual([]);
    expect(localCheck("released v1,2 last week", ALL)).toEqual([]);
  });

  it("does not touch Markdown double-space line breaks or indentation", () => {
    expect(localCheck("first line  \nsecond line", ALL)).toEqual([]);
    expect(localCheck("    indented code here", ALL)).toEqual([]);
  });
});

describe("category toggles", () => {
  const text = "teh cats,dogs and a apple on  the desk . i saw it";

  it("spelling toggle gates misspellings only", () => {
    const issues = localCheck(text, { ...NONE, spelling: true });
    expect(issues.every((i) => i.category === "spelling")).toBe(true);
    expect(issues.some((i) => i.original === "teh")).toBe(true);
  });

  it("grammar toggle gates grammar rules only", () => {
    const issues = localCheck(text, { ...NONE, grammar: true });
    expect(issues.every((i) => i.category === "grammar")).toBe(true);
    expect(issues.some((i) => i.original === "a")).toBe(true);
    expect(issues.some((i) => i.original === "i")).toBe(true);
  });

  it("punctuation toggle gates punctuation rules only", () => {
    const issues = localCheck(text, { ...NONE, punctuation: true });
    expect(issues.every((i) => i.category === "punctuation")).toBe(true);
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it("no toggles → no issues", () => {
    expect(localCheck(text, NONE)).toEqual([]);
  });
});

describe("mergeIssues", () => {
  const mk = (start: number, end: number, id: string): Issue => ({
    id,
    start,
    end,
    original: `s${start}`,
    replacement: "x",
    category: "grammar",
    explanation: "test",
    confidence: 1,
  });

  it("primary wins overlaps, secondary fills the gaps", () => {
    const primary = [mk(0, 5, "p1")];
    const secondary = [mk(3, 8, "s1"), mk(10, 14, "s2")];
    const merged = mergeIssues(primary, secondary);
    expect(merged.map((i) => i.id)).toEqual(["p1", "s2"]);
  });

  it("result is sorted by start", () => {
    const merged = mergeIssues([mk(10, 12, "p")], [mk(0, 3, "s")]);
    expect(merged.map((i) => i.start)).toEqual([0, 10]);
  });

  it("handles empty inputs", () => {
    expect(mergeIssues([], [])).toEqual([]);
    expect(mergeIssues([], [mk(0, 2, "s")]).map((i) => i.id)).toEqual(["s"]);
    expect(mergeIssues([mk(0, 2, "p")], []).map((i) => i.id)).toEqual(["p"]);
  });
});
