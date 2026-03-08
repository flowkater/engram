/**
 * Reciprocal Rank Fusion (RRF) — merges multiple ranked result lists.
 * score(d) = Σ 1 / (k + rank_i(d)) for each ranking i
 */

export interface RankedItem {
  id: string;
  [key: string]: unknown;
}

/**
 * Merge multiple ranked lists using RRF.
 * @param lists - Array of ranked result arrays (each sorted by relevance)
 * @param k - RRF constant (default 60)
 * @param limit - Maximum results to return
 * @returns Merged list of IDs sorted by RRF score (descending)
 */
export function rrfMerge(
  lists: RankedItem[][],
  k: number = 60,
  limit: number = 10
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank].id;
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
