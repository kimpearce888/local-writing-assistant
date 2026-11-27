/**
 * Offline fast-check — a pure, deterministic local rule engine.
 *
 * Purpose (v1.10.0):
 *  1. ZERO-latency issues: deterministic highlights appear the moment the
 *     user stops typing, before the LLM round trip finishes. When the model
 *     result arrives it is merged in without duplicating these spans.
 *  2. FULL functionality offline: when the native host or LM Studio is
 *     unreachable, the UI still shows real suggestions instead of an error.
 *
 * Design constraints (mirrors shared/snippets.ts):
 *  - NO chrome.* APIs, NO DOM, NO network. Pure text-in → Issue[] out.
 *  - HIGH PRECISION ONLY: every rule must be right (nearly) always.
 *    Context-dependent calls (its/it's, your/you're, then/than, affect/
 *    effect, …) are deliberately left to the model — a wrong local
 *    underline is worse than a missing one.
 *  - Offset invariant: for every issue, text.slice(start, end) === original.
 *  - Issues are sorted by start and non-overlapping (earlier/shorter wins),
 *    so downstream consumers can apply them back-to-front safely.
 *
 * Every rule respects the user's category toggles (spelling / grammar /
 * punctuation). The enableLocalChecks gate is applied by callers.
 */

import { Issue } from "./types";

export interface LocalCheckCategories {
  spelling: boolean;
  grammar: boolean;
  punctuation: boolean;
}

/* ------------------------------------------------------------------ */
/* Rule data                                                           */
/* ------------------------------------------------------------------ */

/**
 * Unambiguous misspellings only — each entry is wrong in every context.
 * (Homophone confusions and dialect variants are intentionally absent.)
 */
const MISSPELLINGS: Readonly<Record<string, string>> = {
  teh: "the",
  recieve: "receive",
  recieved: "received",
  recieving: "receiving",
  seperate: "separate",
  seperated: "separated",
  definately: "definitely",
  definatly: "definitely",
  occured: "occurred",
  occuring: "occurring",
  untill: "until",
  wich: "which",
  thier: "their",
  adress: "address",
  alot: "a lot",
  aswell: "as well",
  eachother: "each other",
  noone: "no one",
  infront: "in front",
  incase: "in case",
  becuase: "because",
  becasue: "because",
  wierd: "weird",
  freind: "friend",
  beleive: "believe",
  beleived: "believed",
  acheive: "achieve",
  acheived: "achieved",
  calender: "calendar",
  embarass: "embarrass",
  enviroment: "environment",
  existance: "existence",
  foriegn: "foreign",
  goverment: "government",
  garantee: "guarantee",
  guarentee: "guarantee",
  independant: "independent",
  knowlege: "knowledge",
  liason: "liaison",
  maintainance: "maintenance",
  neccessary: "necessary",
  noticable: "noticeable",
  occassion: "occasion",
  occassionally: "occasionally",
  occurance: "occurrence",
  paralell: "parallel",
  perseverence: "perseverance",
  posession: "possession",
  prefered: "preferred",
  publically: "publicly",
  questionaire: "questionnaire",
  recomend: "recommend",
  refered: "referred",
  relevent: "relevant",
  succesful: "successful",
  successfull: "successful",
  tommorow: "tomorrow",
  tommorrow: "tomorrow",
  truely: "truly",
  visable: "visible",
  writting: "writing",
  writen: "written",
  yeild: "yield",
  accross: "across",
  agressive: "aggressive",
  amoung: "among",
  apparant: "apparent",
  basicly: "basically",
  concious: "conscious",
  disapear: "disappear",
  dissapoint: "disappoint",
  excercise: "exercise",
  finaly: "finally",
  fourty: "forty",
  grammer: "grammar",
  happend: "happened",
  immediatly: "immediately",
  mispell: "misspell",
  oppurtunity: "opportunity",
  persue: "pursue",
  probaly: "probably",
  realy: "really",
  religous: "religious",
  sieze: "seize",
  similiar: "similar",
  speach: "speech",
  suprise: "surprise",
  suprised: "surprised",
  tounge: "tongue",
};

/** Doubled words that are legitimate English and must never be flagged. */
const DOUBLED_WORD_ALLOWLIST: ReadonlySet<string> = new Set([
  "had had", // past perfect ("I had had enough")
  "that that", // "she said that that house was hers"
]);

/** Words that start with a vowel LETTER but a consonant SOUND → "a" stays. */
const A_BEFORE_EXCEPTION_RE = /^(?:one|once|uni|use[drs]?|usu|util|e[uv])/i;

/** Words that start with a consonant LETTER but a vowel SOUND → "an" stays. */
const AN_BEFORE_EXCEPTION_RE = /^(?:hour|honest|honou?r|heir)/i;

/** Modals that cannot be followed by "of" in any English construction. */
const MODAL_OF_RE =
  /\b(should|could|would|must|might)\s+of\b/gi;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Carry the original token's capitalization over to the replacement. */
function matchCase(original: string, replacement: string): string {
  if (
    original.length > 1 &&
    original === original.toUpperCase() &&
    original !== original.toLowerCase()
  ) {
    return replacement.toUpperCase();
  }
  if (original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * True when `index` sits inside something URL-like: scanning back to the
 * last whitespace, the segment contains "://" or starts with "www.".
 * Protects URL-ish segments (scheme + host, or www. hosts) that contain
 * commas from the comma rule.
 */
function insideUrlLikeSegment(text: string, index: number): boolean {
  const from = Math.max(0, text.lastIndexOf(" ", index));
  const fromNl = Math.max(0, text.lastIndexOf("\n", index));
  const segmentStart = Math.max(from, fromNl);
  const segment = text.slice(segmentStart, index + 1);
  return segment.includes("://") || /^\s*www\./i.test(segment);
}

/* ------------------------------------------------------------------ */
/* Rule passses (each returns raw candidate issues)                    */
/* ------------------------------------------------------------------ */

interface RawIssue {
  start: number;
  end: number;
  original: string;
  replacement: string;
  category: Issue["category"];
  explanation: string;
  confidence: number;
}

function checkMisspellings(text: string): RawIssue[] {
  const out: RawIssue[] = [];
  // Word-ish token scan; matches the lowercased key exactly.
  const tokenRe = /[A-Za-z][A-Za-z'’]*/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const token = m[0];
    const fix = MISSPELLINGS[token.toLowerCase()];
    if (!fix) continue;
    out.push({
      start: m.index,
      end: m.index + token.length,
      original: token,
      replacement: matchCase(token, fix),
      category: "spelling",
      explanation: `Misspelling — did you mean “${matchCase(token, fix)}”?`,
      confidence: 1,
    });
  }
  return out;
}

function checkDoubledWords(text: string): RawIssue[] {
  const out: RawIssue[] = [];
  // Same-line repeats only ([ \t], not \n): a line that happens to end
  // with "and" and a next line starting with "and" is usually legitimate.
  // The /i flag makes the \1 backreference case-insensitive so "The the"
  // is caught too.
  const re = /\b([A-Za-z][A-Za-z'’-]*)[ \t]+\1\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const second = m[0].slice(m[1].length).trim().toLowerCase();
    const pair = `${m[1].toLowerCase()} ${second}`;
    if (DOUBLED_WORD_ALLOWLIST.has(pair)) continue;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      original: m[0],
      replacement: m[1],
      category: "grammar",
      explanation: `Repeated word — “${m[1]}” twice in a row.`,
      confidence: 0.95,
    });
  }
  return out;
}

function checkArticles(text: string): RawIssue[] {
  const out: RawIssue[] = [];
  // "a" before a vowel-sound word → "an", unless the word starts with a
  // vowel letter but a consonant sound (university, one, European…).
  const aRe = /\ba(?=[ \t]+[aeiou])/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length);
    const nextWord = after.match(/^[ \t]+([A-Za-z][A-Za-z'’-]*)/);
    if (!nextWord) continue;
    if (A_BEFORE_EXCEPTION_RE.test(nextWord[1])) continue;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      original: m[0],
      replacement: matchCase(m[0], "an"),
      category: "grammar",
      explanation: `Article agreement — use “${matchCase(m[0], "an")}” before a vowel sound.`,
      confidence: 0.9,
    });
  }
  // "a" before a silent-h word → "an" (hour, honest, honour, heir).
  const aHRe = /\ba(?=[ \t]+(?:hour|honest|honou?r|heir))/gi;
  while ((m = aHRe.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      original: m[0],
      replacement: matchCase(m[0], "an"),
      category: "grammar",
      explanation: `Article agreement — the “h” is silent: use “${matchCase(m[0], "an")}”.`,
      confidence: 0.9,
    });
  }
  // "an" before a consonant-sound word → "a" (silent-h words keep "an").
  // "x" is excluded: "an x-ray" is right and "an xylophone" is contested.
  const anRe = /\ban(?=[ \t]+[bcdfgjklmnpqrstvwz])/gi;
  while ((m = anRe.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length);
    const nextWord = after.match(/^[ \t]+([A-Za-z][A-Za-z'’-]*)/);
    if (!nextWord) continue;
    if (AN_BEFORE_EXCEPTION_RE.test(nextWord[1])) continue;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      original: m[0],
      replacement: matchCase(m[0], "a"),
      category: "grammar",
      explanation: `Article agreement — use “${matchCase(m[0], "a")}” before a consonant sound.`,
      confidence: 0.9,
    });
  }
  return out;
}

function checkModalOf(text: string): RawIssue[] {
  const out: RawIssue[] = [];
  const re = new RegExp(MODAL_OF_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const modal = m[1];
    const fix = `${modal} have`;
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      original: m[0],
      replacement: matchCase(m[0], fix),
      category: "grammar",
      explanation: `“${modal} of” is not a verb form — write “${modal} have”.`,
      confidence: 1,
    });
  }
  return out;
}

/**
 * Headwords after which a lowercase roman numeral is a legitimate
 * enumeration ("part i", "chapter iv", "section ii") — never the pronoun.
 */
const ENUM_HEADWORDS: ReadonlySet<string> = new Set([
  "chapter", "part", "volume", "section", "act", "scene", "page",
  "paragraph", "appendix", "annex", "item", "tier", "phase", "level",
  "class", "type", "model", "version", "step", "rule", "article",
  "book", "line", "group", "stage", "round", "grade", "div",
]);

function checkLowercaseI(text: string): RawIssue[] {
  const out: RawIssue[] = [];
  // Standalone lowercase "i" (the pronoun). Lookarounds exclude tokens
  // that merely contain i; the explicit ".e" check protects "i.e.".
  const re = /(?<![A-Za-z0-9'’])i(?![A-Za-z0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tail = text.slice(m.index, m.index + 4);
    if (tail.startsWith("i.e")) continue;
    // "(i)" style parenthetical enumerations are never the pronoun.
    if (m.index > 0 && text[m.index - 1] === "(") continue;
    // "part i", "chapter iv" … — skip when the previous word is an
    // enumeration headword.
    const prefix = text.slice(Math.max(0, m.index - 40), m.index);
    const prevWord = prefix.match(/([A-Za-z-]+)[ \t]*$/);
    if (prevWord && ENUM_HEADWORDS.has(prevWord[1].toLowerCase())) continue;
    out.push({
      start: m.index,
      end: m.index + 1,
      original: "i",
      replacement: "I",
      category: "grammar",
      explanation: "The pronoun “I” is always capitalized.",
      confidence: 0.9,
    });
  }
  return out;
}

function checkPunctuationSpacing(text: string): RawIssue[] {
  const out: RawIssue[] = [];

  // Space directly before sentence punctuation (word/digit + spaces + [. , ; : ! ?] + whitespace/end).
  const beforePunct = /(?<=[A-Za-z0-9])[ \t]+([.,;:!?])(?=[\s]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = beforePunct.exec(text)) !== null) {
    // Decimal-like split ("3 . 14"): digit . digit with only spaces
    // between → the text is malformed, but "3." is NOT an improvement.
    // Leave it for the model instead of producing a half-fix.
    if (
      m[1] === "." &&
      /\d/.test(text[m.index - 1]) &&
      /^\s*\d/.test(text.slice(m.index + m[0].length))
    ) {
      continue;
    }
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      original: m[0],
      replacement: m[1],
      category: "punctuation",
      explanation: "Remove the space before punctuation.",
      confidence: 1,
    });
  }

  // Missing space after a comma between letters ("word,word"). Digit
  // neighbors are excluded so thousand separators never match.
  const commaNoSpace = /,(?=[A-Za-z])/g;
  while ((m = commaNoSpace.exec(text)) !== null) {
    const prev = m.index > 0 ? text[m.index - 1] : "";
    if (!/[A-Za-z0-9]/.test(prev)) continue;
    if (insideUrlLikeSegment(text, m.index)) continue;
    out.push({
      start: m.index,
      end: m.index + 1,
      original: ",",
      replacement: ", ",
      category: "punctuation",
      explanation: "Add a space after the comma.",
      confidence: 1,
    });
  }

  // Run of 2+ spaces between plain word characters — collapse to one.
  // Newlines are excluded on both sides so Markdown line-break spacing
  // ("two spaces<newline>") and indentation are never touched.
  const doubleSpace = /(?<=[A-Za-z0-9])[ \t]{2,}(?=[A-Za-z0-9])/g;
  while ((m = doubleSpace.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      original: m[0],
      replacement: " ",
      category: "punctuation",
      explanation: "Extra spaces between words.",
      confidence: 1,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Sort candidates by start (shorter first on ties) and drop overlaps. */
function dedupeOverlaps(raw: RawIssue[]): RawIssue[] {
  const sorted = [...raw].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: RawIssue[] = [];
  let lastEnd = -1;
  for (const issue of sorted) {
    if (issue.start < lastEnd) continue; // overlaps an already-kept issue
    out.push(issue);
    lastEnd = Math.max(lastEnd, issue.end);
  }
  return out;
}

let localSeq = 1;

/**
 * Run every enabled local rule over `text` and return precise, sorted,
 * non-overlapping issues. Pure function — no I/O, deterministic output
 * except issue ids (monotonic counter, unique per run).
 */
export function localCheck(
  text: string,
  categories: LocalCheckCategories,
): Issue[] {
  const raw: RawIssue[] = [];
  if (categories.spelling) raw.push(...checkMisspellings(text));
  if (categories.grammar) {
    raw.push(...checkDoubledWords(text));
    raw.push(...checkArticles(text));
    raw.push(...checkModalOf(text));
    raw.push(...checkLowercaseI(text));
  }
  if (categories.punctuation) raw.push(...checkPunctuationSpacing(text));

  const out: Issue[] = [];
  for (const r of dedupeOverlaps(raw)) {
    // Offset invariant — a rule bug must never corrupt the editor text.
    if (r.start < 0 || r.end > text.length || r.start >= r.end) continue;
    if (text.slice(r.start, r.end) !== r.original) continue;
    out.push({
      id: `local-${localSeq++}`,
      start: r.start,
      end: r.end,
      original: r.original,
      replacement: r.replacement,
      category: r.category,
      explanation: r.explanation,
      confidence: r.confidence,
    });
  }
  return out;
}

/**
 * Merge two issue lists by span: `primary` wins overlaps, secondary
 * issues that live inside/touch a primary span are dropped. The result
 * is sorted by start (apply-back-to-front order). Used to combine model
 * issues (primary) with offline fast-check issues (secondary) without
 * duplicate underlines on the same span.
 */
export function mergeIssues<T extends Issue>(primary: T[], secondary: T[]): T[] {
  const keptPrimary = dedupeOverlaps(
    primary.map((p) => ({
      start: p.start,
      end: p.end,
      original: p.original,
      replacement: p.replacement,
      category: p.category,
      explanation: p.explanation,
      confidence: p.confidence,
    })),
  );
  const ranges = keptPrimary.map((p) => ({ start: p.start, end: p.end }));
  const extra = secondary.filter(
    (s) => !ranges.some((r) => s.start < r.end && r.start < s.end),
  );
  return [...primary, ...extra].sort((a, b) => a.start - b.start);
}
