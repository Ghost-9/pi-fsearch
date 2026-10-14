# Prompt-token A/B — measured output vs native tools (issue #20)

Generated 2026-10-14 · 30 paired observations · status: degraded

## Method (and what is an estimate)

- Token counts are **estimates** from `ceil(chars / 4)` — the same estimator `src/formatter.ts` uses. This is NOT a specific tokenizer's measurement. A sensitivity estimator `ceil(chars / 3.5)` is also recorded in the JSON.
- Treatment: the Pi tool formatting path (`index.ts` → `formatGrepFiles` / path listing). Control: the raw stdout of the equivalent `rg`/`find` command in the same workspace, i.e. what a bash tool call would put in context.
- Design: counterbalanced alternating A/B; median over mean; BCa bootstrap CI, 10k resamples, on paired deltas.
- The legacy TUI number `150 + 75 × hits` is kept as an **estimate** and compared against measured output below.

## Result

- ultra-search median: **15.0 estimated tokens** (p95 742.0)
- native median: **155.0 estimated tokens** (p95 2406.0)
- saved fraction (1 − ultra/native): **0.903 [0.903, 0.903]**
- paired delta (native − ultra): **140.0 [0.0, 140.0] estimated tokens**

| task | n | ultra (est. tokens) | native (est. tokens) | median savings |
| --- | --- | --- | --- | --- |
| find-file | 5 | 15.0 | 155.0 | 90.8% |
| find-definition | 5 | 274.0 | 275.0 | 0.1% |
| locate-config | 5 | 14.0 | 35.0 | 60.4% |
| grep-literal | 5 | 294.0 | 295.0 | 0.4% |
| find-config | 5 | 15.0 | 4.0 | -262.5% |
| grep-symbol | 5 | 742.0 | 2406.0 | 69.2% |

## Heuristic vs measurement

The `150 + 75 × hits` formula remains an estimate. On identical runs:

| task | hits used | heuristic saved (est.) | measured output saved (est.) | heuristic overstates |
| --- | --- | --- | --- | --- |
| find-file | 13 | n/a | 140 | n/a |
| find-definition | 9 | 825 | 1 | true |
| locate-config | 4 | n/a | 21 | n/a |
| grep-literal | 11 | 975 | 1 | true |
| find-config | 1 | n/a | -11 | n/a |
| grep-symbol | 102 | 7800 | 1664 | true |

Raw JSON: `bench/results/tokens-2026-10-14-degraded.json`
