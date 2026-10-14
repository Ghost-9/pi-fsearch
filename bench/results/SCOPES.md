# Multi-scope benchmark — ultra-search vs rg/find

Source: `bench/results/scopes-2026-10-14-degraded.json` · status: **degraded** · date: 2026-10-14

> **Degraded run.** The environment gate refused a final result for these reasons:
> `load1m 8.90 >= 1.5`
> Numbers below are directional and must not be quoted as final.

## Method

- **design**: paired counterbalanced A/B (AB/BA alternating), warmup pairs excluded
- **statistic**: median
- **ci**: BCa bootstrap, 10000 resamples, alpha=0.05, on paired deltas
- **decisionFloor**: max(0.2 ms, 5% of native median)
- **pairs**: 30
- **warmupPairs**: 2
- **equivalence**: path sets normalized by realpath; index must not invent paths (extraRate<=indexOnly tolerance); missing paths allowed only within the per-query nativeOnly tolerance (content-index coverage is partial)
- **relevance**: wave1 judgment corpus (recall@k, MRR@10, nDCG@10, zero-result, false-positive, reformulation)
- **audit**: PI_ULTRASEARCH_TEST=1 + skipAudit: production audit log untouched
- **environment**: power=AC Power · load1m=8.897 · daemon pid=19684 · index_bytes=77630784

## Latency and equivalence

| scope | query | n | ultra p50 | ultra p95 | native p50 | native p95 | speedup (ratio CI) | Δms (CI) | equivalent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| small | small-path-exact | 30 | 0.72ms | 6.00ms | 4.97ms | 14.23ms | 6.88 [5.23, 8.73] | -4.24 [-6.78, -3.73] | yes (index-only 0, native-only 0) |
| small | small-path-glob | 30 | 0.83ms | 3.28ms | 3.73ms | 6.77ms | 4.49 [3.62, 5.17] | -2.90 [-3.32, -2.53] | yes (index-only 0, native-only 0) |
| small | small-grep | 30 | 1.10ms | 3.22ms | 7.91ms | 10.28ms | 7.21 [5.87, 7.71] | -6.81 [-7.14, -6.18] | yes (index-only 0, native-only 0) |
| monorepo | mono-path-exact | 30 | 0.58ms | 1.90ms | 6.16ms | 8.51ms | 10.63 [9.86, 13.42] | -5.58 [-5.90, -5.33] | yes (index-only 0, native-only 0) |
| monorepo | mono-path-glob | 30 | 0.84ms | 1.33ms | 5.90ms | 7.04ms | 7.06 [6.74, 7.41] | -5.07 [-5.21, -4.92] | yes (index-only 0, native-only 0) |
| monorepo | mono-grep | 30 | 23.11ms | 25.94ms | 29.05ms | 32.87ms | 1.26 [1.23, 1.31] | -5.95 [-7.19, -5.42] | yes (index-only 0, native-only 0) |
| home | home-path-exact | 30 | 1.06ms | 4.98ms | 32.81ms | 49.31ms | 30.82 [19.33, 40.27] | -31.75 [-35.27, -27.42] | yes (index-only 0, native-only 0) |
| home | home-path-glob | 30 | 2.55ms | 6.52ms | 32.07ms | 77.31ms | 12.57 [9.04, 17.25] | -29.52 [-37.83, -25.54] | yes (index-only 0, native-only 0) |
| home | home-grep | 30 | 82.47ms | 133.49ms | 73.36ms | 110.56ms | 0.89 [0.82, 0.95] | 9.11 [3.09, 15.40] | yes (index-only 0, native-only 0) |

Intentional divergence (declared `.gitignore` rules):
- small: `ignored/secret-small.txt` — ultra returned 0, raw find returned 1 → correctlyExcluded=true
- monorepo: `debug.log` — ultra returned 0, raw find returned 1 → correctlyExcluded=true
- home: `root-junk.tmp` — ultra returned 0, raw find returned 1 → correctlyExcluded=true
  - nested-rule probe (known gap): `Documents/projects/proj-001/tmp-junk.tmp` → ultra returned 1 (honoured=false)

## Relevance (wave1 judgment corpus)

- recall@1/3/5/10: 0.409 / 0.612 / 0.688 / 0.721
- MRR@10: 0.605 · nDCG@10: 0.607
- zero-result rate: 3.8% · false-positive rate: 50.0% · reformulation: 50.0%

| gate | value | threshold | pass |
| --- | --- | --- | --- |
| recall@10 == 1.00 on must-hit queries | 0.721 | 1 | FAIL |
| zero_result_rate == 0.00 on must-hit queries | 0.038 | 0 | FAIL |
| false_positive_rate == 0.00 on negative queries | 0.500 | 0 | FAIL |
| nDCG@10 >= 0.75 overall | 0.607 | 0.75 | FAIL |
| nDCG@10 >= 0.60 semantic lane | 0.087 | 0.6 | FAIL |
| reformulation_signal <= 0.20 overall | 0.500 | 0.2 | FAIL |

| baseline | value | baseline | Δ | beats |
| --- | --- | --- | --- | --- |
| recallAt10 | 0.721 | 0.674 | +0.047 | yes |
| ndcg10 | 0.607 | 0.705 | -0.098 | no |
| falsePositiveRate | 0.500 | 0.5 | +0.000 | yes |

| lane | queries | recall@10 | MRR@10 | nDCG@10 | zero-result | FP | reformulation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| path | 7 | 0.917 | 0.917 | 0.870 | 0.0% | 0.0% | 16.7% |
| grep-literal | 6 | 1.000 | 0.383 | 0.540 | 0.0% | 100.0% | 100.0% |
| grep-regex | 3 | 0.625 | 0.556 | 0.593 | 0.0% | 0.0% | 50.0% |
| symbol | 4 | 0.625 | 0.750 | 0.637 | 25.0% | 0.0% | 25.0% |
| semantic | 6 | 0.100 | 0.040 | 0.087 | 0.0% | 100.0% | 100.0% |
| ranking-frecency | 1 | 1.000 | 1.000 | 0.917 | 0.0% | 0.0% | 0.0% |
| ranking-proximity | 1 | 1.000 | 1.000 | 0.861 | 0.0% | 0.0% | 0.0% |
| ranking-boost-ab | 1 | 1.000 | 1.000 | 0.905 | 0.0% | 0.0% | 0.0% |
| ranking-symbol-intrafile | 1 | 1.000 | 1.000 | 1.000 | 0.0% | 0.0% | 0.0% |

