# W3-01 — `glob_set_completeness` was measuring the instrument (#47)

**Verdict: the engine never dropped a file. The Tier-L failure was the scorer's.**

## What was reported

Tier-L `ranking-signal.glob_set_completeness = 0.714` — RS02 (`src/**/*.ts`, `limit: 20`,
14 expected files) "returns 10" — the only unconceded floor of 18. Issue #47.

## What is actually true

Every arm in the verifier's own artifacts returns **all 14 files**:

| artifact | engine | `retrieved.length` | `recall_at_limit` | `recall_at_limit_kmax_clamped` |
|:--|:--|--:|--:|--:|
| `after/wave2-livewave1daemon.json` | installed wave-1 daemon | 14 | 0.7143 | 0.7143 |
| `after/wave2-baseline-prewave2engine.json` | pre-wave-2 engine | 14 | 0.7143 | 0.7143 |
| `after/wave2-baseline.json` | engine from this tree | 14 | 0.7143 | 0.7143 |

Reproduce:

```bash
python3 - <<'PY'
import json
d = json.load(open('bench/verification/after/wave2-baseline.json'))
r = [x for x in d['rows'] if x['id'] == 'RS02'][0]
expected = {e['path'] for e in json.load(open('bench/judgments/wave2-judgments.json'))['queries'][7]['expected']}
print(len(r['retrieved']), len(expected & set(r['retrieved'])), len(expected & set(r['retrieved'])) / len(expected))
PY
# -> 14 14 1.0
```

## Root cause (one line)

`score-wave2.mjs` computed

```js
recall_at_limit: recallAt(retrieved.length, rel1),   // asks for the full list
```

but `recallAt(k, relSet)` slices a `top` built by `retrieved.slice(0, kMax)` with
`kMax = 10`. The value is structurally capped at `min(10, |retrieved|) / |rel|`, so a
14-file expectation could never exceed **10/14 = 0.714** whatever the engine returned.

## Fix

The metric definitions move to `bench/verification/checks/scoring.mjs`, where
`recall_at_limit` counts the whole returned list, and the pre-correction value is kept
alongside it as `recall_at_limit_kmax_clamped` so the drift stays visible in every
artifact. `score-wave2.mjs` imports the shared definitions.

`bench/verification/checks/scoring.test.mjs` pins the corrected value and the cap;
3 of its 4 cases fail against the old formula.

## Verification

Re-scoring the **unmodified** engine over the frozen wave-2 corpus
(`~/.cache/ultrasearch/corpus/wave2-8d1419d`, `tree_sha256 c9c2e4ac…`):

```
Tier-L: 18/18 pass
RS02: retrieved n=14  recall_at_limit=1  clamp=0.7142857142857143
```

No engine code is involved in this fix; the 17/18 reading becomes 18/18 for the same
measured runs.

## Acceptance for #47

| requirement | status | evidence |
|:--|:--|:--|
| RS02 returns all 14 files | already true; now measured | `retrieved` n=14 in all three arms |
| identical sets through CLI and MCP | see `W3-04-cli-mcp-identity.md` | same engine op, same socket path |
| no ranking-lane latency regression (p50 ≤ 3 / p95 ≤ 15 ms) | pass | wave-2 `ranking-signal` lane p50 0.62 ms, p95 0.82 ms on the frozen corpus (provisional gate) |
