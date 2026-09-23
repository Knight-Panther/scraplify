/**
 * IR metrics for Phase 8A's evaluation gate (change.md §12): Recall@20 and
 * NDCG@10 over a ranked list of opportunity ids, judged against a relevance
 * label per id. Pure functions — no model, no I/O — so they're testable
 * against known-by-hand examples before any real judgment data exists.
 */

/** 0 = not relevant, 1 = somewhat relevant, 2 = relevant, 3 = strong match. */
export type RelevanceGrade = 0 | 1 | 2 | 3;

/**
 * Fraction of relevant ids (grade > 0) that appear in the top K of `ranked`.
 * 0 relevant ids in `judgments` is defined as recall 1 (nothing to miss),
 * matching this project's other "vacuously true" guard conventions rather
 * than dividing by zero.
 */
export function recallAtK(
  ranked: readonly string[],
  judgments: ReadonlyMap<string, RelevanceGrade>,
  k: number,
): number {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`recallAtK: k must be a positive integer, got ${k}`);
  }
  const relevantIds = new Set(
    [...judgments.entries()].filter(([, grade]) => grade > 0).map(([id]) => id),
  );
  if (relevantIds.size === 0) return 1;

  const topK = new Set(ranked.slice(0, k));
  let hit = 0;
  for (const id of relevantIds) {
    if (topK.has(id)) hit += 1;
  }
  return hit / relevantIds.size;
}

/**
 * Normalized Discounted Cumulative Gain at K. Ids in `ranked` with no entry in
 * `judgments` are treated as grade 0 (unjudged is not relevant, not excluded
 * — excluding them would let an unlabelled result rank for free). Returns 1
 * when nothing in `judgments` has grade > 0 (nothing to gain, so a perfect
 * score is vacuously correct rather than an undefined 0/0).
 */
export function ndcgAtK(
  ranked: readonly string[],
  judgments: ReadonlyMap<string, RelevanceGrade>,
  k: number,
): number {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`ndcgAtK: k must be a positive integer, got ${k}`);
  }
  const gainAt = (rank: number, grade: RelevanceGrade): number =>
    (2 ** grade - 1) / Math.log2(rank + 1);

  const dcg = ranked
    .slice(0, k)
    .reduce((sum, id, i) => sum + gainAt(i + 1, judgments.get(id) ?? 0), 0);

  const idealGrades = [...judgments.values()].sort((a, b) => b - a).slice(0, k);
  if (idealGrades.every((grade) => grade === 0)) return 1;
  const idcg = idealGrades.reduce<number>((sum, grade, i) => sum + gainAt(i + 1, grade), 0);

  return dcg / idcg;
}
