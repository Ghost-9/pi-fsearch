# 0009 — The low-score-run stop is opt-in and reported

**Choice.** `early_exit: true` (or an explicit `low_run: N`) makes `full`/
`selective` entry scans stop after `N` considered entries in a row that did not
improve the k-th best. A fired run answers `complete:false` with
`stopped_by:"low_run"`. Off by default: `LOW_RUN_DEFAULT` is 1<<20 when
`early_exit` is set, and no ordinary query pays the counter.

**Reason.** #35 asked for score-then-stop; the deferral was that a run of low
scores cannot *prove* the remaining entries are low on an unranked entry scan.
Making it opt-in and truthfully partial keeps the default top-k exact while a
cold whole-disk query gets a bounded tail. Equivalence is tested at the wire
(`test/engine/topk-equivalence.test.mjs`): out-of-reach runs and ample budgets
are output-identical to no bound; a fired run returns only genuine matches.

**Rejected.**
- On by default: it would silently change top-k on large scans and break the
  "ample budget ≡ no budget" guarantee.
- Applying it to `ranked`/`spread`: those already stop when no remaining source
  can beat the floor — an approximate stop there could only lose hits.
- Hiding the reason: a partial answer without `stopped_by` is indistinguishable
  from a truncated page.
