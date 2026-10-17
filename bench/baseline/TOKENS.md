# Token-output baseline — pi-ultrasearch (wave1/baseline)

Frozen: 2026-10-17T04:06:09.535Z · commit `42104cb73f6e5e5f107280b18b1dadd5718720d0` · Apple M1 Pro, Node v26.11.1

## Why this exists

Agent context is the scarce resource. This file freezes how many characters each UltraSearch tool
returns for a fixed 10-task set, so later waves can quantify output-size claims against it.

## Estimator and its limits

**Estimate:** `ceil(characters / 4)` — Characters/4 is the standard rough BPE estimate for English prose and source code. It is an ESTIMATE, not a tokenizer measurement: error is typically ±20%, worse for CJK, base64, minified JSON or long identifiers. Only deltas measured with the SAME estimator are meaningful; do not compare against counts from a different tokenizer.

Known limits:
- Timing strings inside tool text (e.g. 'in 2.63ms') are dynamic; run-to-run variation is <15 chars.
- The zero-hit path-search text may gain a dynamic diagnostic hint at runtime (not captured here).
- Formatter tokenCount itself uses ceil(chars/4); it is not an independent measurement.

## Frozen task set

| # | Tool | Scope | Params | Hits | Chars | Est. tokens | Formatter tokens | Raw JSON chars |
|---|------|-------|--------|-----:|------:|------------:|-----------------:|---------------:|
| t01 | ultrasearch_query | ~/.pi/agent/extensions/pi-ultrasearch | `{"query":"package.json","limit":30}` | 1 | 58 | 15 | — | 478 |
| t02 | ultrasearch_query | ~/.cache/pi-ultrasearch-bench/fixture-5k | `{"query":"module_01232.ts","limit":30}` | 1 | 67 | 17 | — | 492 |
| t03 | ultrasearch_query | ~/.pi/agent/extensions/pi-ultrasearch | `{"query":"zzz_absent_alpha_9c3f.ts","limit":30}` | 0 | 82 | 21 | — | 337 |
| t04 | ultrasearch_grep | ~/.pi/agent/extensions/pi-ultrasearch | `{"pattern":"FSearchClient","limit":30,"context":0,"mode":"literal"}` | 30 | 11199 | 2800 | 2786 | 16078 |
| t05 | ultrasearch_grep | ~/.cache/pi-ultrasearch-bench/fixture-5k | `{"pattern":"ULTRAMARKER_1232","limit":30,"context":0,"mode":"literal"}` | 1 | 127 | 32 | 19 | 637 |
| t06 | ultrasearch_grep | ~/.cache/pi-ultrasearch-bench/fixture-5k | `{"pattern":"zzz_absent_token_9c3f","limit":30,"context":0,"mode":"literal"}` | 0 | 48 | 12 | — | 444 |
| t07 | ultrasearch_multi_grep | ~/.pi/agent/extensions/pi-ultrasearch | `{"patterns":["recordAudit","formatGrepFiles"],"limit":30}` | 30 | 10743 | 2686 | 2673 | 25894 |
| t08 | ultrasearch_multi_grep | ~/.cache/pi-ultrasearch-bench/fixture-5k | `{"patterns":["ULTRAMARKER_1232","ULTRAMARKER_7"],"limit":30}` | 19 | 1415 | 354 | 341 | 6712 |
| t09 | ultrasearch_locate | (global) | `{"filename":"package.json","global":true,"limit":10}` | 10 | 509 | 128 | — | 1589 |
| t10 | ultrasearch_recent | ~/.pi/agent/extensions/pi-ultrasearch | `{"limit":15}` | 15 | 258 | 65 | — | 2440 |

**Totals:** 24,506 chars ≈ 6,130 estimated tokens across 10 tasks.

## How later waves must use this

1. Re-run `node bench/baseline/tokens.mjs` on the wave branch (never accept author-provided numbers).
2. Compare per-task `tool_text_chars` (and derived `estimated_tokens`) with the frozen JSON.
3. A token-reduction claim needs: same task set, same estimator, raw JSON committed, and the
   verifier's own re-measurement. Character deltas below noise (±15 chars from timing strings) are not evidence.
4. Cross-check with a real tokenizer if available; report the estimator's deviation, don't hide it.

Reproduce:

```bash
PI_ULTRASEARCH_TEST=1 node bench/baseline/tokens.mjs
```
