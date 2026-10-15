# W3-02 — the grep page was path order; now it is content (#48, ranking)

**Change:** `engine/src/content.rs` — `page_key`, `class_rank`, and the prose tier in
`doc_rank`. Decision and rejected alternatives: [0014](../decisions/0014-grep-page-ranking.md).

## What was wrong

`verify_from` reads candidates in `(your-files tier, mtime, segment, doc)` order and stops
at `limit` files. On the frozen wave-1 corpus every mtime ties (a `git archive`), so the
order degenerates to **path-alphabetical** and the page is filled from `AUDIT-…md`,
`CHANGELOG.md`, … before `src/`. Wrapped files (`test/`) are peeled by `.gitignore`.

Measured before (engine `7029579839b3ca44`), frozen wave-1 set, corpus
`~/.cache/ultrasearch/corpus/wave1-0a16e50`:

| id | query | rank 1 | expected rank 1 |
|:--|:--|:--|:--|
| G1 | `estimateTokensSaved` (literal) | `AUDIT-2026-10-14.md` (grade 1) | `src/telemetry.ts` (grade 3) |
| G4 | `fsearch.sock` (literal) | `CHANGELOG.md` (grade 0) | `src/client.ts` (grade 3) |
| R2 | `(startAutoCompaction\|recordMistake\|loadIgnoreRules)` (regex) | `AUDIT-2026-10-14.md` (grade 1) | `src/compactor.ts` (grade 3) |

`reformulation` per lane: `grep-literal` **0.40**, `grep-regex` **0.50**, bound **≤ 0.35**.

## What the fix does

`page_key` stable-sorts the page the search already read:

```
(has a definition line ? 0 : 1, Reverse(number of matches), class_rank)
```

`class_rank` is `0` for anything you would edit and `1` for prose (`.md`, `.markdown`,
`.rst`, `.txt`, `.adoc`, `.asciidoc`, `.org`, `.tex`; `README`, `CHANGELOG`, `CONTRIBUTING`,
`NOTICE`, `LICENSE`, `AUTHORS`, `COPYING`). `doc_rank` gains the same tier so prose also
stops spending the page before a source file is read. Symbol mode keeps `rank: false`: its
candidate plan is already "exactly the docs that define it", and the wave-2 symbol bar pins
that order.

`Hit::def` is computed for literal/regex greps so the ranker can use it, bounded to matches
inside the shown 400-byte line prefix and short-circuited once a line is known to define
something. It is **not** added to the answer: the `def` field stays opt-in via `defs: true`.

## Measured effect (frozen wave-1 set, paired per row, BCa 10 000, seed 20261015)

| metric | before | after | Δ | 95% CI | n | moved |
|:--|--:|--:|--:|:--|--:|:--|
| reformulation (all must-hit rows) | 0.1538 | 0.0385 | −0.1154 | **[−0.3462, −0.0385]** | 26 | G1, G4, R2 |
| `grep-literal` reformulation | 0.4000 | **0.0000** | −0.4000 | n=5, point condition (bound ≤ 0.35) | 5 | G1, G4 |
| `grep-regex` reformulation | 0.5000 | **0.0000** | −0.5000 | n=2, point condition (bound ≤ 0.35) | 2 | R2 |
| nDCG@10 | 0.8629 | 0.9121 | +0.0492 | **[0.0112, 0.1345]** | 26 | G1, G4, R2 |
| `grep-regex` recall@10 | 0.8333 | **1.0000** | +0.1667 | n=2 | 2 | R2 |
| recall@10 (all) | 0.7833 | 0.7962 | +0.0128 | [0.0000, 0.0385] — **includes 0, not claimed** | 26 | R2 |
| success_recall@10 | 0.9423 | 0.9615 | +0.0192 | [0.0000, 0.0577] — includes 0 | 26 | R2 |
| zero-result rate | 0.0000 | 0.0000 | 0 | — | 26 | none |
| false-positive rate | 0.0000 | 0.0000 | 0 | — | 26 | none |

nDCG@10 is a real move (CI excludes 0) but its point delta is **+0.0492**, just under the
wave-1 Tier-C threshold of +0.05, so it is reported as sub-threshold.

## What did not move

- Every **path-lane** row (P1–P8, K1–K3): identical sets and orders.
- Every **symbol** row (S1–S4, K4): identical.
- Every **semantic** row on the wave-1 set.
- The **whole wave-2 set except one row** (below).

## The one wave-2 row that moved

`SE09` (`which files decide what gets ignored while searching a project`): its **returned
set is identical**, but `mcp.ts` and `sanitize.ts` swapped ranks 5 and 6, so nDCG@10 fell
0.3888 → 0.3690 (−0.0198). The lane moves 0.67023 → 0.66825 (**−0.0020**, inside the 0.02
lane tolerance). It is an ordering effect from the candidate tier changing which page
reaches the semantic scorer, not a set effect; it is recorded rather than explained further.

## Cost — no extra work

`work-probe.mjs` records what the daemon did (`candidates`, `read`, result counts), which is
invariant under host load:

| scope | rows | identical `read` | identical `candidates` | identical result counts |
|:--|--:|:--|:--|:--|
| frozen wave-1 corpus (33 files) | 30 | 30/30 | 30/30 | 30/30 |
| mixed worktree (1 126 entries, 320 content docs) | 3 probes | rank reads **fewer**: 83→80, 39→36, 33→33 | same | same |

Ranking-lane latency budget (p50 ≤ 3 / p95 ≤ 15 ms corpus-relative): wave-2
`ranking-signal` lane **p50 0.62 ms, p95 0.82 ms**; control **p50 0.37 / p95 1.05 ms**.

## Verification

- `test/engine/grep-ranking.test.mjs` — 4 cases; the definition-tier, class-tier and
  candidate-tier cases **fail when the corresponding tier is removed** (verified by
  rebuilding with `rank: false` and with the `doc_rank` tier deleted).
- Wave-2 re-score: **Tier-L 18/18**, `RS02` complete.
- The pre-existing `test/client.test.ts` "grep with trigram index" failure over this
  worktree is fixed by the change in an isolated daemon: base engine → 23 files, no
  `src/client.ts`; tree engine → 23 files, `src/client.ts` present. It still fails in
  `npm test` because that test talks to the **live installed daemon**, whose content index
  does not cover this worktree (`source: "scan"`).
