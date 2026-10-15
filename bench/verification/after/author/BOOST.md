# boost on/off A/B (wave1/measure)

- corpus: `/Users/batra/ultrasearch-waves/advisor` · judgment set: `/Users/batra/ultrasearch-verify/bench/judgments/wave1-judgments.json`
- pairs: 36 (counterbalanced) · CI: BCa, 10k resamples on paired ΔnDCG@10
- decision rule: keep boost only if CI excludes 0 and point delta >= +0.05 nDCG@10

| arm | median nDCG@10 | p95 |
| --- | --- | --- |
| boost:true | 0.000 | 0.000 |
| boost:false | 0.000 | 0.000 |

**ΔnDCG@10 (on − off): 0.000 [0.000, 0.000]** · CI excludes 0: false · keep boost: **false**

| query | obs | nDCG on | nDCG off | mean rank changes (top-5) |
| --- | --- | --- | --- | --- |
| P1 | 4 | 0.000 | 0.000 | 0.00 |
| P2 | 4 | 0.000 | 0.000 | 0.00 |
| P3 | 4 | 0.000 | 0.000 | 0.00 |
| P5 | 4 | 0.000 | 0.000 | 0.00 |
| P6 | 4 | 0.000 | 0.000 | 0.00 |
| P7 | 4 | 0.000 | 0.000 | 0.00 |
| K1 | 4 | 0.000 | 0.000 | 0.00 |
| K2 | 4 | 0.000 | 0.000 | 0.00 |
| K3 | 4 | 0.000 | 0.000 | 0.00 |

Raw JSON: `bench/results/boost-2026-10-15-degraded.json`
