# Wave 2 relevance — measured results (provisional)

Owner: `wave2/relevance`. Instrument: local scorer `bench/wave2/relevance/wave2-score.mjs`
(a copy of the wave-1 metric definitions plus the wave-2 lane extensions:
symbol assertions / not_expected, `searchSemanticIntent`, paired near). The verifier
owns the certified scorer extension; these are the author-side before/after artifacts.

**Environment (mandatory label).** Both runs are `provisional`: AC power ✓, no cargo/rustc ✓,
1-minute load failed the `< 1.5` gate (before 2.95, after 17.82 — siblings running). Raw JSON:

- `bench/results/wave2/relevance/wave2-wave2-before.json` — `origin/main` client + pre-change engine
  (`/tmp/us-engine-before`, sha256 recorded in meta)
- `bench/results/wave2/relevance/wave2-wave2-after.json` — this branch + rebuilt engine
- `bench/results/wave2/relevance/wave2-compare.json` — paired BCa CIs and Tier-L evaluation
- `bench/results/wave2/relevance/judgments-input.json` — frozen input copy
- `bench/results/wave2/relevance/wave2-sem-v10.json` — isolated semantic-lane run (warm caches)

## F10 correction (adopted)

The wave-1 "verified" FP 0.50 compared a judgments artifact with itself. Wave-1 FP is **0.25**
(R3 fixed by #36), reproduced here: the pre-change wave-2 baseline shows `false_positive_rate 0`
on the symbol lane and `1.00` on the semantic lane (SE11/SE12), with the wave-2 set's own FP at
0.333 overall. No wave-1 judgment row is quoted as verified in this report.

## Baseline reproduction (advisor probe → local BEFORE)

| lane | advisor probe | local BEFORE (n=12/10/4) |
| --- | --- | --- |
| symbol-ast | r@10 0.778, zero 0.222, FP 0 | r@10 0.778, zero 0.222, FP 0 |
| semantic-paraphrase | r@10 0.175, s@3 0.10, nDCG 0.064, FP 1.00 | r@10 0.175, s@3 0.033, nDCG 0.064, FP 1.00 |
| ranking-signal | r@10 0.80, nDCG 0.723, zero 0.20 | r@10 0.820, nDCG 0.832, zero 0.111 |
| control | 1.000 | 1.000 |

## Before / after (means; paired Δ with seeded BCa 95% CI, 10k)

| lane | n | before r@10 / nDCG / s@3 / zero / FP / p50-p95 ms | after r@10 / nDCG / s@3 / zero / FP / p50-p95 ms | ΔnDCG [BCa 95%] |
| --- | --- | --- | --- | --- |
| symbol-ast | 12 | 0.778 / 0.778 / 0.778 / 0.222 / 0 / 1–2 | **1.000 / 1.000 / 1.000 / 0 / 0 / 2–10** | +0.222 [0.000, 0.444] |
| semantic-paraphrase | 12 | 0.175 / 0.064 / 0.033 / 0 / 1.00 / 4–6 | **0.683 / 0.670 / 0.483 / 0 / 0 / 46–171** | **+0.606 [0.242, 0.781]** |
| ranking-signal | 10 | 0.820 / 0.832 / 0.802 / 0.111 / 0 / 1–1 | 0.833 / 0.837 / 0.802 / 0.111 / 0 / 1–3 | +0.006 [−0.047, 0.064] |
| control | 4 | 1.000 / 1.000 / 1.000 / 0 / — / 1–1 | 1.000 / 1.000 / 1.000 / 0 / — / 3–3 | 0.000 [0.000, 0.000] |

Tier-L (gate-aware view, known_fail/feature-gated rows excluded per `wave2-bars.json`):
zero-result 0.00 on answerable must-hit and FP 0.00 on negatives in **all four lanes**;
control perfect; symbol lane `not_expected_returned = 0` (the mock string is gone);
ranking-signal invariants hold (RS01 exact unchanged, RS02 14/14 at limit 20,
RS03/RS04 orders differ, same-folder peer rank 1, named file not demoted).

Tier-C: **semantic-lane improvement is supported** (Δ +0.606, CI excludes 0, ≥ +0.05, no lane
regressing > 0.02). The symbol-lane point delta is +0.222 but the CI lower bound is exactly
0.000 (7 of 9 paired queries unchanged, 2 flips of +1.0), so this scorer does **not** certify a
Tier-C mean shift for symbol; the categorical evidence (all 9 declarations rank 1, SY03/SY04
non-zero, mock string rejected) is the stronger claim there. Negative results recorded:
ranking-signal Δ +0.006 is a tie (the near fix moved order, not nDCG, and RS09 is unchanged).

## Latency budgets (corpus-relative)

| lane | budget p50/p95 | after, full run | after, isolated lane |
| --- | --- | --- | --- |
| symbol-ast | ≤5 / ≤25 ms | 2 / 10 ✓ | 2 / 6 ✓ |
| semantic-paraphrase | ≤25 / ≤75 ms | 46 / 171 ✗ (load 17.8) | 37 / 52 ✓ p95, ✗ p50 |
| ranking-signal | ≤3 / ≤15 ms | 1 / 3 ✓ | 1 / 1 ✓ |
| control | ≤5 / ≤20 ms | 3 / 3 ✓ | 1 / 1 ✓ |

The semantic p50 budget is not met (37–46 ms vs 25); candidate generation reads the scope
(`multiGrep` fan-out + up to 8 path searches) and scores ~90 files. No grep-p95 regression was
measured in this wave (that comparison stays with the wave-1 latency rows).

## Per-issue status

- **#26 engine symbol ranking — done.** Tree-sitter spans (`engine/src/symbols.rs`,
  TS/TSX/JS/Rust; Go/Swift keep the lexical confirmation), access-modifier/member declarations,
  string-literal rejection, `def` score in the response vector, `mode:"symbol"` served by the
  engine. Evidence: `test/engine/symbols.test.mjs`, SY01–SY09 all rank-1 declarations,
  SY03/SY04 no longer 0.
- **#42 explain ranking — done (rendering only).** `explainReasonTags()` in `src/formatter.ts`
  renders `[exact] [glob] [git:*] [proximity] [frecency] [symbol] [match:N] [score:N]` from the
  engine's returned vector; `ultrasearch_query` has an `explain` param (default true); grep tags
  `[def:*]` from the engine verdict. `test/ranking-guard.test.ts` pins honesty of the mapping.
- **No third reranker — done.** `rankSymbolFiles` (client) removed; guard test asserts no client
  path sorts daemon rows and the formatter preserves engine order.
- **Semantic lane — substantially improved, one Tier-C metric short.** Abstains on SE11/SE12
  (FP 1.00 → 0.00), mapped s@3 0.667 (≥0.60 target), nDCG 0.670 (≥0.5; stretch 0.7),
  MRR 0.714 (≥0.55). Paraphrase s@3 is **0.30 vs the 0.40 target** (SE10 remains weak).
- **FP / zero-result — done.** SE11/SE12 abstain; R3 already rejected by #36; SY03/SY04 fixed;
  the only zero in the set is RS09 (known_fail, excluded).
- **Near proximity — done.** `engine/src/server.rs::nearness` drops the −20 self-penalty
  (file +10, folder +12, −3 per folder, clamped): RS03 named file rank 1, RS04 peer rank 1.
- **Exact-word conjunct (RS09) — deferred.** Documented in `docs/wave2/engine-ranking-request.md`;
  non-gating for Tier-L, blocking only for a first-try multi-word path claim.

## Deferrals / blockers

1. **Semantic paraphrase success@3 (0.30 vs 0.40)** and semantic p50 (37–46 ms vs 25 ms) are the
   two Tier-C misses. SE10 (whole-disk partial results) ranks the explaining doc at #6 and
   `engine/src/query.rs` outside the top 10.
2. **Exact-word conjunct** (above).
3. Both artifacts are `provisional` (load gate). The verifier's gated re-run on a frozen daemon
   is required before any of these numbers are cited as final.
4. Symbol Tier-C CI lower bound is 0.000 at n=9 paired queries; the categorical declaration
   result is the honest form of that claim.
