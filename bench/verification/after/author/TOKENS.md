# Prompt-token A/B — measured output vs native tools (issue #20)

Generated 2026-10-15 · 30 paired observations · status: degraded

## Method (and what is an estimate)

- Token counts are **estimates** from `ceil(chars / 4)` — the same estimator `src/formatter.ts` uses. This is NOT a specific tokenizer's measurement. A sensitivity estimator `ceil(chars / 3.5)` is also recorded in the JSON.
- Treatment: the Pi tool formatting path (`index.ts` → `formatGrepFiles` / path listing). Control: the raw stdout of the equivalent `rg`/`find` command in the same workspace, i.e. what a bash tool call would put in context.
- Design: counterbalanced alternating A/B; median over mean; BCa bootstrap CI, 10k resamples, on paired deltas.
- The legacy TUI number `150 + 75 × hits` is kept as an **estimate** and compared against measured output below.

## Result

- ultra-search median: **23.0 estimated tokens** (p95 943.0)
- native median: **155.0 estimated tokens** (p95 2677.0)
- saved fraction (1 − ultra/native): **0.852 [0.852, 0.903]**
- paired delta (native − ultra): **132.0 [26.0, 132.0] estimated tokens**

| task | n | ultra (est. tokens) | native (est. tokens) | median savings |
| --- | --- | --- | --- | --- |
| find-file | 5 | 15.0 | 155.0 | 90.8% |
| find-definition | 5 | 760.0 | 1391.0 | 45.4% |
| locate-config | 5 | 23.0 | 49.0 | 52.8% |
| grep-literal | 5 | 460.0 | 860.0 | 46.6% |
| find-config | 5 | 15.0 | 4.0 | -262.5% |
| grep-symbol | 5 | 943.0 | 2677.0 | 64.8% |

## Heuristic vs measurement

The `150 + 75 × hits` formula remains an estimate. On identical runs:

| task | hits used | heuristic saved (est.) | measured output saved (est.) | heuristic overstates |
| --- | --- | --- | --- | --- |
| find-file | 13 | n/a | 140 | n/a |
| find-definition | 31 | 2475 | 631 | true |
| locate-config | 6 | n/a | 26 | n/a |
| grep-literal | 27 | 2175 | 400 | true |
| find-config | 1 | n/a | -11 | n/a |
| grep-symbol | 106 | 8100 | 1734 | true |

Raw JSON: `bench/results/tokens-2026-10-15-degraded.json`
