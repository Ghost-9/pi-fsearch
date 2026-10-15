# Wave-5 backlog closure — independent verification report

Verifier: independent session (`wave1/verify-final`). Commit under test: `97beeb140d…` (= `origin/main`).
Deliverable: `bench/verification/backlog-closure.json` (18 issue rows + 1 control row).
Raw evidence: `bench/verification/backlog/results/**`. Findings: `bench/verification/backlog/FINDINGS.md`.

**Verdict: 12 verified · 6 needs-work · 0 refuted.** Nothing verified here was verified from an
author summary; every row is a fresh run, a fresh derivation, or a mutation control.

## Method

1. **Isolation.** Every daemon-backed check starts its own daemon (`ULTRASEARCH_DIR`/`HOME`/
   `SCAN_ROOT` and socket in a scratch dir) over a verifier-built fixture. The live daemon is never
   queried. Fixtures: `.gitignore`d build dir, a watch scope, two roots aliasing one inode, a
   `git archive HEAD` copy.
2. **Removal tests.** Each functional guard is re-run in a scratch `git archive HEAD` copy with the
   pre-fix behaviour restored; a guard that stays green is reported dead. Nine source mutations plus
   four per-issue controls (#24, #29, #41, #49).
3. **Own artifacts.** The verifier's own serializer re-derived the #38 prompt-tax table; its own
   `compareSets` calls re-derived the #21 equivalence rows; its own probe measured the #24 event
   loop; the #50 real daemon reports the frozen version.
4. **Gate.** The shared host is not idle (load1 5.2–6.5 vs `< 1.5`), so the frozen gate is
   `provisional`. Functional/set comparisons are unaffected; the two measurement rows are marked
   `needs-work` for the gate reason instead of promoted.

## Closure matrix

| # | Verdict | Evidence (independent) | Method | n |
|--:|---|---|---|--:|
| 20 | **needs-work** | estimate labelled in `telemetry.ts`/`tui.ts`; TOKENS.md carries scope, method, paired delta and the heuristic-overstatement table; committed artifact `-degraded` | doc + artifact audit + shipped label test | 5 |
| 21 | **needs-work** | 5 scope artifacts carry n=30, median, p95 and BCa CIs per query; `compareSets` is discriminating (identical pass, missing/extra fail); committed artifacts `-degraded` | artifact audit + 4 constructed `compareSets` cases + golden re-run | 4 |
| 24 | **needs-work** | fallback path async (max loop gap 11 ms while stubbed `rg` slept 400 ms), cancellation kills the child, no leak; **`index.ts` still calls `execFileSync` on the tool path for a non-git cwd (773 ms block, 1 invocation)** | own event-loop probe + scratch mutation to `execFileSync` (472 ms block) | 3 |
| 25 | **verified** | limit 15 over 20 ignored + 25 visible → 15 hits, 0 ignored, `filteredCount` 10, `truncatedCount` 10, `truncated` true, `rawCount` 35; unfiltered control 40 hits; mock control limit 7 → filtered 10 / truncated 18 | real daemon + exact mock arithmetic | 3 |
| 27 | **verified** | baseline 1; first add 215 ms after write; same-path rewrite added 0 events; delete → exactly 1 remove; `stop()` → lanes 0, no live resources, process exits 0 | real WatchSession in a child process against a real daemon | 5 |
| 28 | **verified** | fan-out over two roots aliasing one inode → 3 unique hits, `duplicates` 1, the surviving row is the active root's alias, a physically-active file attributes `active: true` | real daemon + `multiRootSearch` | 4 |
| 29 | **verified** | regenerated declarations `50a467b0…` == committed golden; drift and recipe tests pass; a registry description mutation makes the drift test fail | own regeneration + scratch mutation | 4 |
| 30 | **verified** | real stdio MCP: default `tools/list` = 6 canonical; `--alias fsearch` → 12 and `fsearch_locate` callable; unconfigured `fsearch_*` rejected; all 5 client profiles list 6 and call their representative tool | real `bin/mcp-server.ts` sessions | 7 |
| 31 | **needs-work** | views split 2/1/3 and default `real`; real CLI `report --json` → `real`, 2 calls, 1 filtered synthetic; origin+harness stamped. **Nightly summary is not wired to CI or cron** | verifier-built log + real CLI + wiring audit | 6 |
| 37 | **verified** | `_meta` on MCP query/grep/multi_grep and `details` on the Pi query/grep all carry numeric `tokenCount`, `truncatedCount` and boolean `complete` | real daemon + real MCP + real Pi harness | 5 |
| 38 | **verified** | own serializer (`ceil(chars/4)`): MCP 1056→938 (−11.2 %), Pi 1012→667 (−34.1 %); matches the published table exactly; shipped script cross-check 1605 combined tokens | pre-trim tree via `git archive 3d1268d~1` | 4 |
| 40 | **verified** | default run writes nothing; opt-in writes mode 600 with the credential-shaped canary scrubbed; `=0` writes nothing; cap 10 keeps `query-2..query-11`; CLI `--suggest` returns 3; TUI reads the module | real CLI + module + temp HOME | 6 |
| 41 | **needs-work** | 1 `tool_execution_end` listener; 5 rapid edits → 1 prefetch of 1 path; read → 0; debounce removed → 5. **No edit→grep latency measurement published** (and no ungated latency claim) | real Pi harness + mock daemon + scratch mutation | 4 |
| 49 | **verified** | full assertion on the `git archive HEAD` scope and on the main worktree (2/2 pass, 0 skipped each); the pre-#49 cwd+limit-30 shape fails on the archive scope; control test discriminates | shipped test run from two indexed scopes + scratch mutation | 3 |
| 50 | **verified** | doc `1.0` (×2) == `PROTOCOL_VERSION` == real daemon `status.protocol_version`; 1.9 compatible / 2.0 not; mock 2.0 → `protocol_mismatch`; pre-#50 engine fails the shipped engine test | real daemon + mock + stale-engine build | 5 |
| 51 | **verified** | 8/8 harnesses registered on a fresh HOME; dry-run writes nothing; one timestamped backup; idempotent second write reports unchanged and adds no backup; printed revert restores bytes exactly; unparseable config refused (exit 1) and untouched | real CLI on temp HOMEs | 8 |
| 52 | **needs-work** | live handshake agrees (6 tools, `2025-06-18`) with the stored artifacts, but **`--check --require-fresh` exits 1: all 10 artifacts are from `397edb8`, HEAD is `97beeb1`** | shipped checker + own MCP handshake | 5 |
| 53 | **verified** | default/dry-run write nothing; `--write` injects both markers with 1 backup and the measured reason; second write byte-identical; `--remove --write` restores the original bytes; half-marker refused; create+delete on a fresh root | real CLI on temp roots | 6 |

Control row — **removal matrix (verified)**: 9/9 mutated guards fail when their feature is removed
(#25 #27 #28 #30 #31 #37 #40 #51 #53).

## Safe to close

`#25, #27, #28, #29, #30, #37, #38, #40, #49, #50, #51, #53`

Notes attached to closing: #51 carries a non-blocking fidelity nit (F19); #50 is verified on a
source-built engine (F22 shows the guard is live).

## Must stay open

| # | Why |
|--:|---|
| 20 | measurement needs a gate-clean artifact; committed runs are `-degraded` (F: gate) |
| 21 | same gate rule; artifacts are `-degraded`, so medians/CI may not be cited (F: gate) |
| 24 | `index.ts` still spawns `git` synchronously on the tool path for a non-git cwd (F18) |
| 31 | nightly summary not produced without a manual step (F16) |
| 41 | no edit→grep latency measurement published (F17) |
| 52 | smoke artifacts stale vs HEAD; `--require-fresh` fails (F15, F21) |

## Findings

F15 stale smoke artifacts (#52) · F16 unwired nightly (#31) · F17 missing prefetch latency
measurement (#41) · F18 `execFileSync` on the tool path (#24) · F19 `init --remove` trailing-newline
fidelity (#51) · F20 unlabelled TUI per-row savings (#20) · F21 smoke arm exercises the installed
shim (#52) · F22 #50 engine guard is live (positive) · F23 all functional guards are live
(positive) · F24 `npm test` excludes the engine (process). Full reproductions:
`bench/verification/backlog/FINDINGS.md`.

## Reproduction

```bash
cd <worktree>
PI_ULTRASEARCH_TEST=1 node bench/verification/backlog/run-all.mjs           # rebuilds the closure file
PI_ULTRASEARCH_TEST=1 node bench/verification/backlog/checks/daemon-suite.mjs   # #25 #27 #28 #37 #49 #50
PI_ULTRASEARCH_TEST=1 node bench/verification/backlog/checks/removal-matrix.mjs # guard non-vacuity
node bench/baseline/gate-check.mjs                                          # the gate every row records
```

Per-check raw JSON and hashes: `bench/verification/backlog/results/` and each row's
`evidence_hashes` in `bench/verification/backlog-closure.json`.
