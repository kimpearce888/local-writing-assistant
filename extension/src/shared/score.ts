/**
 * Grammarly-style performance scoring — Correctness / Clarity / Engagement
 * / Delivery, plus a weighted overall score.
 *
 * All scoring is LOCAL and deterministic: it derives from the issue list
 * the model produced, weighted by issue density per 100 words so a long
 * document with the same absolute issue count doesn't score worse than a
 * short one. Scores are clamped to [40, 100] — a full issue list should
 * feel like "needs work", not "zero".
 */

import { Issue, ScoreBreakdown } from "./types";
import { computeTextStats } from "./analysis";

/** Penalty weight per issue category (applied to per-100-words density). */
const WEIGHTS: Record<string, number> = {
  spelling: 4,
  grammar: 3.5,
  punctuation: 2,
  clarity: 6,
  word_choice: 5,
  style: 4,
};

/** Floor so scores read like Grammarly's (a disaster draft still shows a number). */
const FLOOR = 40;
const MAX_PENALTY = 100 - FLOOR;

function densityPenalty(count: number, words: number, weight: number): number {
  if (count <= 0) return 0;
  const per100 = count / Math.max(0.25, words / 100);
  return Math.min(MAX_PENALTY, Math.round(per100 * weight));
}

function scoreFrom(count: number, words: number, weight: number): number {
  return 100 - densityPenalty(count, words, weight);
}

/**
 * Compute the score breakdown for a text + its issues. `text` may be the
 * full editor text; `issues` must be the currently active issue list
 * (offsets are not used, only categories).
 */
export function computeScoreBreakdown(
  text: string,
  issues: readonly Issue[],
): ScoreBreakdown {
  const { words } = computeTextStats(text);
  const w = Math.max(1, words);
  const byCat: Record<string, number> = {};
  for (const issue of issues) {
    byCat[issue.category] = (byCat[issue.category] ?? 0) + 1;
  }
  const correctnessCount =
    (byCat.spelling ?? 0) + (byCat.grammar ?? 0) + (byCat.punctuation ?? 0);
  const correctness = scoreFrom(
    correctnessCount,
    w,
    ((byCat.spelling ?? 0) * WEIGHTS.spelling +
      (byCat.grammar ?? 0) * WEIGHTS.grammar +
      (byCat.punctuation ?? 0) * WEIGHTS.punctuation) /
      Math.max(1, correctnessCount),
  );
  const clarity = scoreFrom(byCat.clarity ?? 0, w, WEIGHTS.clarity);
  // Engagement = word choice / repetitive or bland wording.
  const engagement = scoreFrom(byCat.word_choice ?? 0, w, WEIGHTS.word_choice);
  // Delivery = formality/tone fit (style issues + hedging-heavy phrasing).
  const delivery = scoreFrom(byCat.style ?? 0, w, WEIGHTS.style);
  const overall = Math.round(
    0.4 * correctness + 0.25 * clarity + 0.2 * engagement + 0.15 * delivery,
  );
  return { overall, correctness, clarity, engagement, delivery };
}

/** Grammarly-like color band for a score (0–100). */
export function scoreBand(score: number): "good" | "fair" | "weak" {
  if (score >= 90) return "good";
  if (score >= 75) return "fair";
  return "weak";
}
