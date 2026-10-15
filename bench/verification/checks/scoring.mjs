// bench/verification/checks/scoring.mjs — the wave-1/wave-2 relevance metric
// definitions, in one place so the scorer and its regression test cannot drift.
//
// Extracted verbatim from `bench/verification/checks/score-wave2.mjs` (which
// took them from `bench/baseline/judgments.mjs`). The only change is the
// `recall_at_limit` correction described below.
//
//   recall@k     rel = expected grade>=1; |rel in top-k| / |rel|
//   success@k    rel = expected grade>=2
//   nDCG@10      gains 2^grade-1, discount 1/log2(rank+1), IDCG over all grades
//   reformulation  top-1 grade < 2
//
// `recall_at_limit` asks "is the returned set complete for this query": it is
// the fraction of `rel` present anywhere in the returned list. It must be
// measured over the whole list. score-wave2.mjs computed it as
// `recallAt(retrieved.length, rel1)` where `recallAt` slices a `top` already
// truncated to `kMax` (=10), so it could never exceed 10/|rel| and reported
// `glob_set_completeness` 0.714 for a query that returned all 14 of 14 files.

/**
 * Build the scorer bound to a path-normaliser (the corpus root differs per
 * run, so `norm` cannot be a module global here).
 * @param {(p: string) => string} norm
 */
export function makeScoreQuery(norm) {
  return function scoreQuery(retrieved, expected, kMax = 10) {
    const grades = new Map(expected.map((e) => [norm(e.path), e.grade]));
    const top = retrieved.slice(0, kMax).map((p, i) => ({
      rank: i + 1,
      path: p,
      grade: grades.get(p) ?? 0,
    }));

    const rel1 = expected.filter((e) => e.grade >= 1).map((e) => norm(e.path));
    const rel2 = expected.filter((e) => e.grade >= 2).map((e) => norm(e.path));
    const set1 = new Set(rel1);
    const set2 = new Set(rel2);

    const recallAt = (k, relSet, set) => {
      if (relSet.length === 0) return null;
      return top.slice(0, k).filter((r) => set.has(r.path)).length / relSet.length;
    };
    /** Recall over the list as returned, for any k (here: k = everything). */
    const recallOver = (relSet, set) => {
      if (relSet.length === 0) return null;
      return retrieved.filter((p) => set.has(p)).length / relSet.length;
    };

    const firstRank = (minGrade) => {
      const r = top.find((x) => x.grade >= minGrade);
      return r ? r.rank : null;
    };

    const gain = (g) => Math.pow(2, g) - 1;
    const dcg = (list) => list.reduce((a, r, i) => a + gain(r.grade) / Math.log2(i + 2), 0);
    const idealList = [...expected.map((e) => e.grade)].sort((a, b) => b - a).map((g) => ({ grade: g }));
    const idcg = dcg(idealList);

    const r1 = firstRank(1);
    const r2 = firstRank(2);
    return {
      top10: top,
      recall_at_1: recallAt(1, rel1, set1),
      recall_at_3: recallAt(3, rel1, set1),
      recall_at_5: recallAt(5, rel1, set1),
      recall_at_10: recallAt(10, rel1, set1),
      success_recall_at_10: recallAt(10, rel2, set2),
      // `mrr_at_10` is the name the frozen wave-2 scorer reads; the wave-1
      // scorer's `_rel1`/`_rel2` variants are the same quantity spelled out.
      mrr_at_10: r1 ? 1 / r1 : 0,
      mrr_at_10_rel1: r1 ? 1 / r1 : 0,
      mrr_at_10_rel2: r2 ? 1 / r2 : 0,
      ndcg_at_10: idcg > 0 ? dcg(top) / idcg : null,
      top1_grade: top[0]?.grade ?? 0,
      reformulation_signal: (top[0]?.grade ?? 0) < 2,
      // The complete returned set, not the top-10 page.
      recall_at_limit: recallOver(rel1, set1),
      // The value the pre-correction scorer produced, kept so the drift stays
      // auditable from the artifact itself.
      recall_at_limit_kmax_clamped: recallAt(retrieved.length, rel1, set1),
    };
  };
}
