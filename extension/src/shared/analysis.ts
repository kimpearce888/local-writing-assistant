/**
 * Local text statistics (Grammarly-parity "stats" panel).
 *
 * Everything here is deterministic, dependency-free JavaScript — no LLM
 * round trip, no network. The side panel, popup, and floating widget all
 * read from this module so a user always sees words / readability / time
 * estimates even when LM Studio is offline.
 */

import { TextStats } from "./types";

/** Average silent-reading speed (~238 wpm research median) and speaking
 *  pace (~150 wpm presentation pace). */
const READING_WPM = 238;
const SPEAKING_WPM = 150;

/** Match words: letters, digits, apostrophes-in-words, and hyphenated compounds. */
const WORD_RE = /[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF]+(?:['\u2019-][A-Za-z\u00C0-\u024F]+)*/g;

/**
 * Very small English-oriented syllable estimator. Counts vowel groups and
 * subtracts a silent trailing "e". Good enough for a Flesch score that
 * tracks the published grade curves for everyday prose; for CJK and other
 * non-Latin scripts it falls back to one syllable per word.
 */
function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 1;
  if (w.length <= 3) return 1;
  let s = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
    .replace(/^y/, "");
  const groups = s.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Standard Flesch Reading Ease labels (Flesch 1948 scale). */
export function describeReadingEase(score: number): string {
  if (score >= 90) return "Very easy";
  if (score >= 80) return "Easy";
  if (score >= 70) return "Fairly easy";
  if (score >= 60) return "Plain English";
  if (score >= 50) return "Fairly difficult";
  if (score >= 30) return "Difficult";
  return "Very difficult";
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function minutes(words: number, wpm: number): number {
  if (words <= 0) return 0;
  return round1(words / wpm);
}

/**
 * Compute the full statistics bundle for a piece of text. Safe on empty
 * strings (returns a zeroed bundle with a neutral readability label).
 */
export function computeTextStats(text: string): TextStats {
  const characters = text.length;
  const trimmed = text.trim();
  const words = trimmed.match(WORD_RE) ?? [];
  const wordCount = words.length;
  const paragraphs = trimmed
    .split(/\n{2,}|\r\n\r\n/)
    .map((p) => p.trim())
    .filter(Boolean).length;

  // Sentence split mirrors shared/text-utils.splitSentences but counts
  // in one pass here (we need per-sentence word counts too).
  const sentenceTexts = trimmed
    .replace(/\r\n/g, "\n")
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const sentences = sentenceTexts.length;
  const sentenceWordCounts = sentenceTexts.map(
    (s) => (s.match(WORD_RE) ?? []).length,
  );
  const longSentences = sentenceWordCounts.filter((c) => c > 30).length;

  const unique = new Set(words.map((w) => w.toLowerCase()));
  const syllables = words.reduce((acc, w) => acc + countSyllables(w), 0);

  const asl = sentences > 0 ? wordCount / sentences : 0; // avg sentence length
  const asw = wordCount > 0 ? syllables / wordCount : 0; // avg syllables/word
  const fleschReadingEase =
    wordCount > 0 && sentences > 0
      ? Math.max(0, Math.min(100, round1(206.835 - 1.015 * asl - 84.6 * asw)))
      : 100;
  const fleschGrade =
    wordCount > 0 && sentences > 0
      ? Math.max(0, round1(0.39 * asl + 11.8 * asw - 15.59))
      : 0;

  const uniqueWords = unique.size;
  return {
    characters,
    words: wordCount,
    sentences,
    paragraphs,
    uniqueWords,
    vocabularyRichness: wordCount > 0 ? round1(uniqueWords / wordCount) : 0,
    avgWordsPerSentence: round1(asl),
    longSentences,
    readingMinutes: minutes(wordCount, READING_WPM),
    speakingMinutes: minutes(wordCount, SPEAKING_WPM),
    fleschReadingEase,
    fleschGrade,
    readabilityLabel: describeReadingEase(fleschReadingEase),
  };
}
