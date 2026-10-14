# ADVISOR — Wave 1 (`pi-ultrasearch`)

Baseline: `0a16e50` (v0.3.1). Authority: search-relevance + measurement. Scope: no source changes.
Read: `AUDIT-2026-10-14.md`, `OPTIMIZATIONS.md`, `ROADMAP.md`, `README.md`, issues #15–#44, `src/*.ts`,
`index.ts`, `test/bench.ts`, `test/benchmark-gate.test.ts`, engine `rerank`/`nearness`/`frecency::boost`,
`.github/workflows/ci.yml`, live daemon + launchd + MCP registries + machine state.
Artifacts: `bench/judgments/wave1-judgments.json` (30 queries, 6 lanes, 4 negatives).

---

## 0. Verdict

Core engine is real: warm ping p50 0.031 ms, path search 0.365–0.475 ms, grep 0.153–0.480 ms, 45×–78× vs `find`/`rg`.
Everything *around* it still over-claims: real-session `fsearch_query` p50 41 ms is **110× the quoted 0.37 ms**, and
0 of the 4 ranking mechanisms (frecency, proximity, symbol priority, semantic expansion) has a single local
measurement. Wave 1 will succeed or fail on one thing: whether the new numbers are *artifact-backed* and
*scope-labelled*. Three of the four seed workstreams can ship without that and reproduce the 2026-10-14 audit.

---

## 1. Plan critique

### 1.1 Blocking risks (must be resolved before merge)

| # | Risk | Evidence | Resolution |
|---|---|---|---|
| R1 | **Measurements taken today are invalid.** Machine is on battery at 29% (discharging) with load avg 3.28 on 10 cores and 3 fanned-out waves running `cargo build --release` (PIDs 81021/81978). | `pmset -g batt`, `uptime`, `ps` | No latency number produced this wave is quotable unless re-run on AC, load < 1.5, no concurrent builds. Harness must record and refuse otherwise. |
| R2 | **`boost: true` is on by default and unmeasured.** Every `search` re-ranks with frecency + git-history + mtime. | `src/client.ts:307` (`boost: options.boost ?? true`); engine `server.rs:597–609` | K3 A/B (boost on/off) on one index before any ranking claim ships. |
| R3 | **Two proximity implementations with incompatible scales.** Server `nearness` is +12/folder, −20 self; client `applyProximityRanking` is +100−10×distance. Both fire on the same request. | `server.rs:618`, `src/client.ts:637–657` | Pick one owner for proximity; K2 must measure which ordering actually wins. |
| R4 | **Rename touches 170 case-sensitive `fsearch` occurrences across 21 of 33 tracked files** (296 case-insensitive across 26) — the single widest diff of the wave, competing with B and C for the same files. | §4.1 | Rename lands as its own commit, first, with old tool names aliased for one release. |
| R5 | **No test enumerates registered tool names**, so a partial rename passes CI green. | `npm test` runs only `test/client.test.ts` | A: add a tool-catalog enumeration test (exact set equality). |
| R6 | **`GrepOptions.mode` has no `semantic`**; semantic mode is a separate path in `index.ts`. | `src/types.ts:95` vs `index.ts:11` | Type and wire surface must agree before semantic is claimable. |

### 1.2 Missing acceptance criteria

- **A (rename/build/MCP):** no AC asserts the *new* tool names exist and the old ones still resolve; no AC that
  `npm pack` bins run (issue #43 has this, the rename does not); MCP parity AC (#30) says "each registered client
  can list and call" but all 4 registries point at the **live checkout** `~/.pi/agent/extensions/pi-ultrasearch/bin/mcp-server.ts`,
  not at a build — an AC must state which path is being tested.
- **B (harness/perf):** #21 says "medians, p95, n and CI bounds" without naming a CI method, an n, or a
  power/load precondition. No AC forbids mean-based headlines, which is how the original inflation happened.
  No AC for **output equivalence** on the ranking changes (K1–K4), only for the native-tool comparison.
- **C (engine/security):** #16 "p95 bounded by the configured budget" has no scope, n or load condition, and
  does not define `complete:false` behaviour for paginated/`limit`-bounded calls. #17 coverage AC has no
  statement about *existing* 0-hit answers becoming hits (a silent relevance change). #19 freshness hint AC has
  no threshold value. #23 has no AC on **DLP false-positive rate** — the regressions risk of applying the
  redactor to path output is scrubbing real code paths, not missing secrets.

### 1.3 Ordering and merge conflicts

Shared hot files, by expected overlap:

| File | A (rename) | B (harness/client) | C (engine/security) |
|---|---|---|---|
| `src/types.ts` | rename 13 `FSearch*` | add `budget`/meta fields | add containment/coverage fields |
| `src/client.ts` | rename 49 | lanes, async fallback, limit ordering | containment, budget plumbing |
| `index.ts` | rename 19 tool regs | metadata on results | security errors |
| `src/telemetry.ts` | rename 34 | real/synthetic split, token A/B | — |
| `package.json` | name/bin/keywords | scripts | — |

**Merge-hostile order is the only safe one: A first, alone, rename-only commit → B and C rebase.** A's diff
touches every file; if B or C lands first, A must resolve conflicts in files it is mechanically rewriting, which
is where renames silently drop a call site. Secondary: `src/telemetry.ts` is A+B only — B can start there
immediately without waiting. C's engine work is in a separate worktree (`wave1/engine`, `3e83825`) and should
stay there; the TS side of C is the only overlap.

### 1.4 Drop list if time is short (in order)

1. **Semantic mode claims** — `src/semantic.ts` ORs up to 8 tokens and reports `confidence = min(1.0, 0.5 + files×0.05)`,
   so **any 10-file result scores confidence 1.0**. Keep the code, remove the claim, label experimental.
2. **AST/tree-sitter symbol index (#26)** — L effort, no harness, and S3 already proves the current gap.
3. **Linux packaging/CI matrix (#32)**, **`ults watch` (#27)**, **multi-root dedupe (#28)**, **query history (#40)**.
4. **Compaction pause (#34)** — `fsearch_compact` is already a manual 600 ms op; churn is real but not user-facing this wave.

Keep all of: A, E1–E3 (harness + equivalence), C's `budget_ms`/early-exit (F3–F5 security: 5 lines each, high trust value).

---

## 2. Relevance evaluation design

### 2.1 Judgment set — `bench/judgments/wave1-judgments.json`

Corpus: this repo frozen at `0a16e50` — 33 files, 4,949 lines. Markdown docs are deliberate distractors
(they quote the same identifiers as source, which is exactly how real agents get misled).

Lanes: **path 7** (4 head / 2 torso / 1 negative) · **grep-literal 6** (3/2/1) · **grep-regex 3** (1/1/1 adversarial)
· **symbol 4** · **semantic 6** · **ranking probes 4** (frecency, proximity, boost A/B, symbol intra-file).
26 must-hit, 4 negatives, 0 duplicate ids.

Graded rubric (per file): **3** = the answer, stop searching · **2** = also answers (test, second call site) ·
**1** = mentions it in passing · **0** = irrelevant. Grading is per *file* for path/grep/semantic, and per *line
order within a file* for the symbol lane (that is the only symbol claim the implementation can support today).

Two probes are deliberately known-fail and must stay red until fixed:
- **S3** `applyProximityRanking`: the declaration is `public applyProximityRanking(`, which `SYMBOL_REGEX`
  (`src/formatter.ts:13`) cannot match — its alternation covers `pub|async|export|default|func|fn|function|class|struct|interface|type|trait|enum|def|protocol|actor|extension` but not `public|private|static|readonly`.
- **M6** `kubernetes helm chart values for a redis cluster`: the 8-token OR must not surface hits via the generic
  `config`/`cache` concepts.

### 2.2 Metrics and gates

| Metric | Definition | Gate |
|---|---|---|
| recall@k (k=1,3,5,10) | share of grade-3 files in top-k | @10 = 1.00 on all 26 must-hit |
| MRR@10 | mean reciprocal rank of first grade-3 | report; no absolute gate |
| nDCG@10 | gains 3/2/1, discount log2(rank+1) | ≥ 0.75 overall, ≥ 0.60 semantic lane |
| zero-result rate | must-hit queries returning 0 hits | = 0.00 (any 0-hit is a bug, not noise) |
| false-positive rate | negatives returning > 0 | = 0.00 (abstention gate) |
| reformulation signal | share of queries whose top-1 grade < 2 — the machine proxy for "the agent would re-query" | ≤ 0.20 overall, ≤ 0.35 per lane |
| reformulation (session) | consecutive same-session queries with Jaccard ≥ 0.6 within 30 s, from the audit log | ≤ 0.15 |

Pair R3 `(a+)+$` with an **error-class** assertion, never a latency number: the current path sends the pattern
straight to the engine and the reading is meaningless. Recording 4,000 ms for a rejected pattern is how a
non-result becomes a performance claim.

### 2.3 Ranking claims: the scoring contract

A ranking mechanism may ship only if, **on one frozen index, one machine state, in a paired per-query test**:
point ΔnDCG@10 ≥ +0.05 **and** the CI on the paired delta excludes 0 **and** no lane regresses by > 0.02.

| Claim | Where it lives | Current evidence | Required evidence |
|---|---|---|---|
| frecency lifts the file you touched | `frecency.rs` (upstream: "72% → 84%" on Linux history replay) | **upstream only, not local** | K1 before/after an `{op:open}`; Δrank of README.md |
| `boost:true` (frecency + git history + mtime) | `server.rs:603`, default on | none | K3 boost on/off, per-round medians, paired delta |
| `near:` proximity | `server.rs:618` (+12/folder, −20 self) and `client.ts:651` (max +100) | upstream "84% → 89%" | K2; plus a resolution of the double-rerank (−20 vs +100 conflict) |
| symbol = "definitions first" | `formatter.ts:64–70` sorts **within a file only** | none | K4 (intra-file line order) + S3 (fixed) before any file-level claim |
| semantic expansion | `semantic.ts` 8 tokens, confidence saturating at 10 files | none | M-lane nDCG@10 ≥ 0.60 and M6 FP = 0 |

Reject the phrase "definitions first" for `mode: symbol` until S3's top-1 is grade 3: today the ranking is
intra-file line ordering by a regex that misses every access-modified declaration.

---

## 3. Measurement protocol review

### 3.1 Defects in the current harness (all concrete, all fixable)

| Defect | Evidence | Consequence |
|---|---|---|
| **p95 is the max.** `sorted[Math.floor(10×0.95)]` = `sorted[9]` of 10 | `test/bench.ts:60` | Every headline "p95" from `bench.ts` is a single observation. This is the direct mechanism of the 0.09 ms → 13.4 ms real-session gap (149×). |
| **Sequential A-block then B-block**, not alternating | `benchmark-gate.test.ts:103–156` (four tests, each blocking n=50) | Thermal/power drift and daemon compaction land on one arm. |
| **No CI, no n rationale.** n=50 per arm, order-statistic p95, no uncertainty | `benchmark-gate.test.ts:95–97` | 50 samples give a p95 that depends on ~3 points. |
| **No failure accounting.** `assert.equal(res.ok, true)` only | gate tests | A fast error is not a fast search; the pattern is already in the codebase's history. |
| **Mean reported alongside p50** | `test/bench.ts:62` | On a skewed tail the mean is not the contract statistic. |
| **No power/load/AC precondition anywhere** | `bench.ts`, gate, `test/empirical-10-tests.ts` | Today's environment (battery 29%, load 3.28, concurrent cargo builds) would silently pass. |
| **Micro numbers presented without the session row** | README §Measured performance | The audit's headline inflation: 0.15 ms micro vs 41 ms p50 real. |

### 3.2 Required protocol

- **n:** micro-benchmarks n ≥ 200 per arm (sub-ms calls are cheap); A/B comparisons **30 paired rounds**,
  each round contributing one median per arm. Report the median of per-round medians — not the mean of samples.
- **CI method:** BCa bootstrap, 10,000 resamples, on the **paired per-round median deltas**. Do not use a
  t-interval on raw samples or on means. Report the CI, not just the point estimate.
- **Ordering:** counterbalanced, not plain ABAB. Plain alternation leaves A always first within a round, so any
  linear drift inside a round favours B. Use ABBA on odd rounds (or a seeded random order per round).
- **Decision rule:** a win requires (a) non-overlapping per-arm CIs **or** a paired delta CI excluding 0, **and**
  (b) a minimum meaningful effect: ≥ 5% or ≥ 0.2 ms, whichever is larger. A statistically significant 0.003 ms
  delta is reported as "no measurable difference".
- **Warm/cold separation, defined and never mixed:** *process-warm* = ≥ 3 prior calls on the same client;
  *daemon-warm* = the daemon has been up ≥ 60 s with no `compact` in the last 30 s; *cold* = first call after
  `{op:"save"}` compaction or daemon restart. macOS cannot drop the page cache without sudo, so cold is defined
  by daemon state, not by filesystem state — state that explicitly in the artifact.
- **Failure accounting:** count non-`ok` responses and empty results per arm; abort the run if either is > 0 on a
  must-hit query. Record the count in the JSON.
- **Output equivalence:** compare **result path sets and matched line sets**, not counts. Tolerance ≤ 1% set
  divergence at equal `k`, and zero missing grade-3 files in the top-3 versus the full-scan baseline.
- **Every claim carries a context tuple:** `{commit, scope, n, warm|cold, power, load, date, artifact path}`.
  A number without a tuple is not quotable.

### 3.3 Machine controls

Required before a run, asserted by the harness and recorded in the artifact:
AC power (`pmset -g batt` not `discharging`); 1-minute load average < 1.5 of 10 cores; no `cargo`/`tsc`/`rg`
process outside the harness; daemon PID recorded; `index_bytes`/`content_docs` recorded (drift check — it moved
121,501,312 → 124,179,008 bytes, +2.2%, during this session). Today's run environment fails all three; that is
recorded here so the wave does not quote its own numbers.

### 3.4 Anti-inflation rule (the specific historical failure)

The 2026-10-14 audit found **0.15 ms (micro) vs 13.4 ms (real session)** for the same tool and **0.37 ms vs
41 ms** p50 for path search. Rule: **every published latency claim states the micro p50 and the real-session p50
side by side, from the same commit**; if they differ by > 10×, both numbers appear in the claim. Session numbers
come from the non-synthetic rows of `~/.pi/agent/cache/pi-ultrasearch/audit.jsonl` with n, p50, p95, max, and
fallback rate. Also ban "up to", best-of-N, and any single-run figure in README/CHANGELOG/ROADMAP.

---

## 4. Rename risk assessment

### 4.1 Complete inventory (case-sensitive: 170 occurrences across 21 of 33 tracked files; 296 case-insensitive across 26)

**Must rename (product/LLM-visible or internal identifier):**

| Literal | Count | Files | Risk |
|---|---|---|---|
| `fsearch_query` | 39 | `index.ts`, `src/{mcp,codemode,types,telemetry}.ts`, tests, docs | **LLM-visible tool name** — breaking |
| `fsearch_grep` | 30 | same | breaking |
| `fsearch_multi_grep` | 21 | same | breaking |
| `fsearch_locate` | 14 | same | breaking |
| `fsearch_recent` | 13 | same | breaking |
| `fsearch_metrics` | 8 | same | breaking |
| `FSearch*` (`FSearchClient` 55) | 135 | all `src/`, `index.ts`, tests, `bin/` | internal, mechanical, low risk |
| `fsearch-mcp` (bin alias) | 1 | `package.json:18` | packaging only |
| `fsearch` in `keywords` | 1 | `package.json` | packaging only |

**Must remain (external contract):**

| Literal | Count | Why it cannot be renamed in Wave 1 |
|---|---|---|
| `fsearch.sock` | 4 | **Owned by the resident daemon** (`~/Library/Application Support/FSearch/fsearch.sock`, verified `srwxr-xr-x`). Renaming it client-side disconnects the client → 100% native-fallback rate, which is the exact failure mode the audit measured at 29%. |
| `Application Support/FSearch/` | 3 | Daemon state dir: `index.bin` 124 MB, `content/`, `daemon.log`, `socket.lock`. The daemon will not find a renamed dir. |
| `~/.local/share/fsearch/fsearch.sock` (Linux) | 1 | Same, cross-platform. |
| `~/.cache/fsearch` + `~/.local/bin/fsearch` | in `src/client.ts:155–157` | Upstream engine checkout and the 4.5 MB upstream binary (`~/.local/bin/fsearch`, Oct 13). Candidate list — keep as last-resort for users on the old daemon. |
| `com.pi.ultrasearch`, `/Applications/UltraSearch.app` | launchd + app | Already renamed; do not touch twice. Renaming the label orphans the running LaunchAgent (`KeepAlive`). |
| `pi-fsearch` (legacy audit dir) | 1 (`src/telemetry.ts:30`) | Read-fallback for historical rows; deleting it loses pre-0.3.1 telemetry. |
| `noahdunnagan/fsearch` (MIT, © Noah Dunnagan) | 2 (`README.md:183,192`) | **License obligation.** Note: `LICENSE` is 679 lines of AGPL-3.0 with **zero MIT text** — the README claims the notice "is preserved when redistributing the engine binary", but it is not in the repo. This is a compliance gap to *add to*, never rename away. |
| README/CHANGELOG historical references | 20+ | Archive; rewriting history is not a rename. |

### 4.2 Migration + rollback checklist

1. **Do not write to `/Users/batra/.pi/agent/extensions/pi-ultrasearch` during Wave 1.** It is a real checkout at
   `0a16e50` on `main` (not a symlink), and it is what the running session loaded. Worktree edits are inert there
   — that is the safety property, and it is lost the moment someone "updates" it.
2. Land the rename as **one commit**, identifiers and tool names only, rebuilding no daemon artifacts.
3. Keep **old tool names as aliases** for one release: register both `fsearch_*` and `ultrasearch_*`, log which is
   used. Removal is a later commit with usage data.
4. Run the 4 MCP registries (`~/.gemini/antigravity/mcp_config.json`, `~/.gemini/config/mcp_config.json`,
   Claude Desktop, VS Code) unchanged, because they point at the live checkout. If `bin` entries move to
   `dist/*.js` (issue #43), the build must exist **before** the config patch, in the same commit.
5. **No socket or state-dir move in this wave.** If it ever happens: two-phase (client tries new then old;
   daemon binds both), one release apart, with the old socket removed only after the release boundary.
6. Rollback = `git revert <rename-commit>`; the daemon is untouched, so no restart, no re-index, no data loss.
   The only irreversible action available is a socket/state move — which is why it is prohibited here.

### 4.3 What would break the running parent session

| Action | Effect |
|---|---|
| Renaming tool names **in the live checkout** without restart | In-flight `fsearch_*` calls fail as unknown tools; pi caches the tool catalog at session start. |
| A module-load throw in `index.ts` (e.g. `./src/client.ts` → `./src/ultrasearch.ts` with one import missed) | Pi disables the extension for the session: all 7 tools vanish **silently** — no error surfaces to the agent. |
| Renaming the extension **directory** | Pi never finds it; same silent loss. (`pi-fsearch → pi-ultrasearch` is already a dangling symlink in that directory.) |
| Changing parameter names or `outputSchema` without keeping aliases | Agents' memorized calls fail; `path_filter`, `global`, `near`, `mode` are the high-traffic ones. |
| Writing build output into the live checkout while the session is live | Module-graph corruption for the running host. |

---

## 5. Top-10 prioritized recommendations

| # | Recommendation | Impact | Effort | Evidence to accept |
|---|---|---|---|---|
| 1 | **Claims ledger**: every number in README/CHANGELOG/ROADMAP resolves to a committed artifact path + context tuple; ban "up to"/best-of/single-run. | Kills the 273× inflated-claim class (0.15 ms vs 41 ms) | S | grep of all numbers → each has `{commit,n,scope,warm/cold,artifact}`; 0 orphans |
| 2 | **Run the 30-query judgment set on `0a16e50` before any ranking change.** Ship K1–K4 as measurements, not features. | Makes `boost:true` (on in every call) defensible or disables it | S | `npm run bench:relevance` JSON: recall@10, nDCG@10, FP rate, reformulation signal |
| 3 | **Rename lands first, alone; old tool names aliased one release; add a tool-catalog enumeration test.** | Removes the widest merge conflict (21/33 files) and the silent partial-rename class | M | test asserts exact registered-tool set; CI green; 0 `fsearch_` tool names in `index.ts` |
| 4 | **Fix the three harness defects**: `bench.ts:60` p95-from-max, sequential A/B blocks, zero failure accounting. | Removes the mechanism that produced every inflated p95 to date | S | diff + rerun; per-round medians and pair count in the JSON |
| 5 | **n ≥ 200 micro / 30 paired counterbalanced rounds, BCa bootstrap CI on paired deltas, 5%-or-0.2 ms minimum effect.** | A "win" becomes a decision, not a coincidence | M | committed JSON with 10k-resample CI; identical conclusion on a rerun |
| 6 | **Machine-state precondition asserted and recorded** (AC power, load < 1.5, no foreign compilers, daemon PID, `index_bytes`). | Today's environment invalidates every number measured in it | S | harness refuses to write an artifact when the precondition fails |
| 7 | **Budget/early-exit ACs get numbers**: #16 needs scope, n, load, and `complete:false` semantics under `limit`; #35 needs top-k equivalence. | Converts "p95 bounded" into a testable statement | S | issue text + harness JSON; bound holds at n=30 rounds, load < 1.5 |
| 8 | **Security: fix PEM regex `[[\s\S]*?` → `([\s\S]*?)`, then measure DLP false-positive rate before applying to path output.** | 5-char fix for a real masking hole; the FP measurement prevents scrubber collateral | S | multi-line PEM fixture fully redacted; 0 real code lines scrubbed on the 33-file corpus |
| 9 | **Gate `boost:true` behind K3.** Keep it if the paired ΔnDCG CI excludes 0; otherwise default it off. | Every search currently pays an unmeasured rank change | M | K3 A/B JSON; per-query rank diffs published |
| 10 | **Demote symbol/semantic claims, keep the code.** "Definitions first" → "intra-file line priority"; semantic → experimental until M-lane nDCG@10 ≥ 0.60. | Removes 2 of 4 unsupported ranking claims at ~zero code cost | S | README wording diff; S3 red until fixed; M6 FP = 0 |

**Blocking risk to flag upward:** R1 (invalid measurement environment) and R4/R3 (rename-first ordering and the
double proximity rerank) are the only items that can make Wave 1 *look* green while reproducing the audit.
