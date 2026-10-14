# Optimization backlog — features, performance, quality

Compiled 2026-10-14 from the repository audit (`AUDIT-2026-10-14.md`) and live measurements. Every item states the
problem, the evidence, the proposed change, and the expected impact. Effort is S (<0.5 day), M (0.5–2 days),
L (>2 days). Items marked **DONE** shipped in v0.3.1.

Measurement baseline used throughout (this machine, live daemon):
- warm path search p50 0.37–0.48 ms, p95 ~1.1 ms (small repo)
- warm trigram grep p50 0.15–0.48 ms, p95 ~0.8 ms
- warm ping p50 0.031 ms
- real-session `ultrasearch_query` p50 41 ms, p95 1.95 s, max 4.0 s
- native fallback on 29% of real calls (before the 0.3.1 fallback upgrade)
- daemon: 3.73 M path entries, 611 k dirs, 129 k content docs (3.5% coverage), 121.5 MB index + 134 MB content

---

## A. Engine & daemon

| # | Problem | Evidence | Change | Impact | Effort |
|---|---|---|---|---|---|
| A1 | Cold/global queries cause multi-second tails | 1,721 ms / 1,952 ms / 4,007 ms rows for a whole-disk query | Add `budget_ms` to `op: search`; return partial results with `complete:false` when the budget expires | Bounded worst-case; agent gets *something* instead of waiting | M |
| A2 | Content coverage is 3.5% and undocumented | `content_docs 129,295` vs `entries 3,732,605` | Configurable include rules (extensions, size caps, dirs), documented policy, warm-up indexing on daemon start | Predictable grep coverage; fewer 0-hit surprises | L |
| A3 | FSEvents drops force replays; freshness is invisible | `daemon.log`: repeated `FSEvents dropped events before we read them` | Surface `staleness_ms` / `last_event_id` in `op: status`; warn the client when a replay is in flight | Agent can decide to re-run or trust results | M |
| A4 | Compaction churns the index (4.53 M → 3.67 M entries) | daemon log compaction lines; `ultrasearch_compact` ~600 ms | Track segment/overlay pressure; pause compaction during active query bursts; expose compaction metrics | Fewer latency spikes; visible index health | M |
| A5 | Single socket = head-of-line blocking | `src/client.ts` uses one `net.Socket` for all requests | Connection pool (2–4 lanes) or request multiplexing with per-request deadlines | Parallel agent calls stop queuing behind a large grep | M |
| A6 | Whole-disk path search has no ranking budget guard | `limit` truncates results but work continues | Score-then-stop with early termination for low-score matches | Lower p95 on global queries | M |

## B. Client & extension

| # | Problem | Evidence | Change | Impact | Effort |
|---|---|---|---|---|---|
| B1 | Fallback used `grep -rn` and `find -maxdepth 6` | 29% of real calls; `find` 21–35 ms vs `rg` 12 ms | **DONE**: prefer `rg` (grep fallback), remove max-depth cap | Fallback ~2× faster and finds deep files | S |
| B2 | Audit rows were written twice (client + tool wrapper) | duplicate audit pairs (`*taste*` 39.7/40.8 ms) | **DONE**: single-layer recording with `auditTool` | Trustworthy percentiles and token stats | S |
| B3 | Benchmark gate wrote into production telemetry | 101/139 rows were synthetic | **DONE**: `PI_ULTRASEARCH_TEST=1` isolation | Metrics reflect real usage | S |
| B4 | `.gitignore` evaluation was dead code | `loadIgnoreRules()` never called | **DONE**: applied to query/grep/multi-grep with 60 s per-scope cache | Honest "outside repo" ignore support | S |
| B5 | `context: 1` was requested then discarded | `index.ts` never passed `showContext` | **DONE**: optional `context` + `tag_symbols` params; default 0 | ~30% smaller grep payloads by default | S |
| B6 | Semantic expansion module was unreachable | `src/semantic.ts` imported by no production path | **DONE**: `mode: "semantic"` in Pi + MCP | Natural-language → code tokens in one call | S |
| B7 | Recursive learner had no production writers | `recordMistake()` only in tests | **DONE**: empty-result, path-mismatch, DLP, CLI-bypass writers | The learner actually learns from sessions | S |
| B8 | Auto-compaction supervisor never started | `startAutoCompaction()` uncalled | **DONE**: wired into interactive TUI lifecycle | Long sessions keep index healthy | S |
| B9 | Async fallback | fallback still uses `execFileSync` | Convert fallback to async `spawn` with cancellation | No event-loop stalls on fallback | M |
| B10 | Result-limit accounting | `limit` applies before/after ignore filtering inconsistently | Filter first, then apply limit; report `truncated` counts | Predictable result counts | S |
| B11 | Regex-mode input validation | user regex can crash or match nothing silently | Validate/compile regex client-side; return actionable errors | Fewer dead-end queries | S |
| B12 | Duplicate paths across linked worktrees | same filename appears from multiple siblings | Deduplicate by realpath + prefer active worktree | Cleaner result sets | M |

## C. Token & context efficiency

| # | Problem | Evidence | Change | Impact | Effort |
|---|---|---|---|---|---|
| C1 | "Tokens saved" is a formula, not a measurement | `150 + 75 × hits` in `telemetry.ts` | Build an A/B harness that counts prompt tokens for identical tasks with/without the extension | Real, defensible savings numbers | M |
| C2 | No per-call output budget visibility | `max_tokens` optional and unused by default | Report `tokenCount`/`truncatedCount` in every grep result (already computed) and surface it in metadata | Agents can self-tune | S |
| C3 | Tool descriptions are long | `ultrasearch_query` description ≈ 90 words | Measure prompt cost (harness exists in the skill set); trim to essentials; move details to docs | Lower per-turn prompt tax | S |
| C4 | MCP exposes 12 tool names (6×2 aliases) | `tools/list` returns `ultrasearch_*` + `ultrasearch_*` | Make alias exposure configurable; default to one prefix per client | Smaller MCP tool surface | S |
| C5 | Compact vs verbose not measured | format claim "~30–50% reduction" | Add equivalence check + token comparison to the harness (C1) | Prove the format claim | S |

## D. Features

| # | Feature | Why | Impact | Effort |
|---|---|---|---|---|
| D1 | AST/symbol index (tree-sitter) | `mode: "symbol"` is regex-shaped today | Real definitions-first results for Go/Swift/TS/Rust | L |
| D2 | `ults watch` / file-change queries | Agents poll for changes | Event-driven workflows | M |
| D3 | Multi-root workspaces | T3 worktrees + monorepos | One query across roots, per-root attribution | M |
| D4 | Query history + suggestions | Repeat queries are common | Faster iteration; learner input | S |
| D5 | Code Mode pipeline recipes | Multi-step discovery is the main use case | One sandbox turn: search → grep → read | S |
| D6 | Prefetch hints after edits | Edit → grep latency matters | Warm the new file's trigrams on `tool_execution_end` | M |
| D7 | Cross-platform daemon packaging | Linux users fall back to `rg` | Same speed everywhere | L |
| D8 | Result explanations | Agents need to trust ranking | Include match reason (exact/glob/git/proximity) in output | S |

## E. Benchmark & evaluation discipline

| # | Problem | Evidence | Change | Impact | Effort |
|---|---|---|---|---|---|
| E1 | Gate tested a ~25-file repo | issue #15 claimed 1 M+ files | Fixture generator: small repo, monorepo, home-scale, whole-disk; committed JSON results | Claims backed by reproducible numbers | M |
| E2 | Single-shot percentiles | earlier numbers from one run | Median + confidence interval over ≥20 alternating A/B runs (see the "verify a performance win" skill) | Statistically defensible | S |
| E3 | No output-equivalence check | speed could hide wrong results | Compare result sets against `rg`/`find` baselines on the fixtures | Correctness gate alongside latency | M |
| E4 | No real-session dashboard | telemetry mixed with synthetic data | Split audit views: real vs synthetic; nightly summary | Detect regressions from actual usage | M |
| E5 | No CI matrix | macOS-only workflow | Linux job for client/unit tests; daemon job on a self-hosted runner | Cross-platform confidence | M |

## F. Security

| # | Problem | Evidence | Change | Impact | Effort |
|---|---|---|---|---|---|
| F1 | PEM regex is malformed | `[[\s\S]*?` in `src/sanitize.ts` | Fix to `([\s\S]*?)`; add multi-line key tests | Correct private-key masking | S |
| F2 | DLP not applied to path results | `ultrasearch_query` returns raw paths | Scrub query output with the same redactor | No credential-shaped paths in prompts | S |
| F3 | Containment only on grep `path_filter` | `ultrasearch_query` accepts arbitrary scope | Apply `isPathSafe` to all scopes before dispatch | Boundary guarantees match the docs | S |
| F4 | Fail-closed blocklists missing | issue #13 objective | Configurable deny-list of dirs/files, enforced before results return | Enterprise policy support | M |
| F5 | DLP counter was test-only | TUI "masked" count | Real interception count from production paths (0.3.1 feeds the learner) | Honest security telemetry | S |

## G. Documentation & release process

| # | Problem | Evidence | Change | Impact | Effort |
|---|---|---|---|---|---|
| G1 | Version drift: package 0.3.0, README 0.2.2, CHANGELOG 0.2.2 | repo state before 0.3.1 | **DONE**: version reconciliation + 0.3.0/0.3.1 changelog entries | One source of truth | S |
| G2 | No tags or releases | `gh release list` empty | Tag `v0.3.1`; publish release notes from CHANGELOG | Traceable releases | S |
| G3 | Roadmap claimed milestones that were not delivered | milestones 4–6 | **DONE**: roadmap rewritten with audit reality check | Trustworthy planning | S |
| G4 | Issue closure criterion was "code exists" | #12/#14/#15 closed while unreachable | Acceptance criteria on every issue; reopen incomplete ones with audit evidence; milestone objects created | Issues mean something again | S |
| G5 | Upstream MIT notice not tracked | rebranded daemon binary | Keep attribution in README; document binary provenance | License compliance | S |
| G6 | No architecture decision log | decisions scattered in chat | `docs/decisions/` with one file per decision (format: choice, reason, rejected alternatives) | Future sessions stop re-deriving | S |

---

## Suggested sequencing

1. **v0.4.0** — B9, A1, A2, A5, C1, E1–E3, F1–F3, G2 (performance + trust).
2. **v0.5.0** — D1, D5, B12, C4, A3, A4, E4 (features + interop polish).
3. **v1.0.0** — D7, E5, documented SLAs, cross-platform packaging.
