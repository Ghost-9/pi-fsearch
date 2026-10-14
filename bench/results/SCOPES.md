# Multi-scope benchmark — ultra-search vs rg/find

Source: `bench/results/scopes-2026-10-14-degraded.json` · status: **degraded** · date: 2026-10-14

> **Degraded run.** The environment gate refused a final result for these reasons:
> `load1m 11.91 >= 1.5`
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
- **environment**: power=AC Power · load1m=11.91 · daemon pid=77206 · index_bytes=77763200

## Latency and equivalence

| scope | query | n | ultra p50 | ultra p95 | native p50 | native p95 | speedup (ratio CI) | Δms (CI) | equivalent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| small | small-path-exact | 30 | 0.94ms | 2.78ms | 6.47ms | 12.21ms | 6.89 [4.64, 9.66] | -5.53 [-7.74, -4.83] | yes (index-only 0, native-only 0) |
| small | small-path-glob | 30 | 0.91ms | 1.27ms | 2.98ms | 5.78ms | 3.26 [3.04, 3.67] | -2.06 [-2.28, -1.97] | yes (index-only 0, native-only 0) |
| small | small-grep | 30 | 1.30ms | 4.43ms | 7.21ms | 13.05ms | 5.55 [4.77, 6.21] | -5.91 [-6.67, -5.44] | yes (index-only 0, native-only 0) |
| monorepo | mono-path-exact | 30 | 0.59ms | 1.23ms | 6.36ms | 8.55ms | 10.71 [9.13, 13.03] | -5.76 [-6.06, -5.60] | yes (index-only 0, native-only 0) |
| monorepo | mono-path-glob | 30 | 0.97ms | 2.72ms | 6.40ms | 8.50ms | 6.62 [6.07, 7.21] | -5.43 [-5.74, -5.22] | yes (index-only 0, native-only 0) |
| monorepo | mono-grep | 30 | 23.03ms | 24.55ms | 28.52ms | 30.38ms | 1.24 [1.20, 1.27] | -5.49 [-6.29, -4.76] | yes (index-only 0, native-only 0) |
| home | home-path-exact | 30 | 0.66ms | 1.24ms | 13.96ms | 22.53ms | 21.04 [19.68, 27.55] | -13.29 [-13.75, -12.91] | yes (index-only 0, native-only 0) |
| home | home-path-glob | 30 | 1.23ms | 2.53ms | 18.05ms | 22.27ms | 14.65 [13.17, 15.85] | -16.82 [-17.81, -15.56] | yes (index-only 0, native-only 0) |
| home | home-grep | 30 | 52.11ms | 86.14ms | 51.62ms | 76.94ms | 0.99 [0.95, 1.02] | 0.49 [-1.19, 2.29] | yes (index-only 0, native-only 0) |

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

