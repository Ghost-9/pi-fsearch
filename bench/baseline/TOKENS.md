# Token-output baseline — pi-ultrasearch (wave1/baseline)

Frozen: 2026-10-14T20:36:02.439Z · commit `0a16e5055002c2d80feed47afecc2e0416afd1a2` · Apple M1 Pro, Node v26.11.1

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
| t01 | fsearch_query | ~/ultrasearch-waves/baseline | `{"query":"package.json","limit":30}` | 4 | 268 | 67 | — | 670 |
| t02 | fsearch_query | ~/.cache/pi-ultrasearch-bench/fixture-5k | `{"query":"module_01232.ts","limit":30}` | 1 | 67 | 17 | — | 211 |
| t03 | fsearch_query | ~/ultrasearch-waves/baseline | `{"query":"zzz_absent_alpha_9c3f.ts","limit":30}` | 0 | 82 | 21 | — | 78 |
| t04 | fsearch_grep | ~/ultrasearch-waves/baseline | `{"pattern":"FSearchClient","limit":30,"context":0,"mode":"literal"}` | 27 | 6883 | 1721 | 1707 | 11200 |
| t05 | fsearch_grep | ~/.cache/pi-ultrasearch-bench/fixture-5k | `{"pattern":"ULTRAMARKER_1232","limit":30,"context":0,"mode":"literal"}` | 1 | 127 | 32 | 19 | 346 |
| t06 | fsearch_grep | ~/.cache/pi-ultrasearch-bench/fixture-5k | `{"pattern":"zzz_absent_token_9c3f","limit":30,"context":0,"mode":"literal"}` | 0 | 48 | 12 | — | 156 |
| t07 | fsearch_multi_grep | ~/ultrasearch-waves/baseline | `{"patterns":["recordAudit","formatGrepFiles"],"limit":30}` | 19 | 5314 | 1329 | 1316 | 14636 |
| t08 | fsearch_multi_grep | ~/.cache/pi-ultrasearch-bench/fixture-5k | `{"patterns":["ULTRAMARKER_1232","ULTRAMARKER_7"],"limit":30}` | 16 | 1199 | 300 | 287 | 5377 |
| t09 | fsearch_locate | (global) | `{"filename":"package.json","global":true,"limit":10}` | 10 | 511 | 128 | — | 1243 |
| t10 | fsearch_recent | ~/ultrasearch-waves/baseline | `{"limit":15}` | 15 | 225 | 57 | — | 1871 |

**Totals:** 14,724 chars ≈ 3,684 estimated tokens across 10 tasks.

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
