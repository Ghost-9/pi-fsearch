# Changelog

All notable changes to `pi-fsearch` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.1] - 2026-10-13

### Changed
- **Zero Typo Tolerance Enforced**: Completely eliminated all fuzzy typo forgiveness across `fsearch_query` and fallback search. Plain query terms are transformed into strict exact match mode (`Mode::Exact`), guaranteeing zero false positives and deterministic resolution.

### Added
- **Full Hybrid Observability System**:
  - Persistent JSONL append-only audit logger in `~/.pi/agent/cache/pi-fsearch/audit.jsonl`.
  - **Toolchain Shadow Detector** (`src/observer.ts`): Intercepts `bash` and `powershell` execution to flag CLI search bypasses (`find`, `rg`) where `fsearch` would be 12–45× faster.
  - **Diagnostic Analyzer**: Provides actionable corrective guidance on 0-hit queries (detects whether exact matches exist under different directories or advises on exact matching).
  - **Profiler Tool & Slash Command**: Registered `fsearch_metrics` tool and `/fsearch` slash command (`metrics`, `audit`, `reset`, `status`) to observe p50/p90/p95 latency and anti-patterns.

---

## [0.2.0] - 2026-10-13

### Fixed
- **Extension Tool Registration**: Fixed `pi.defineTool is not a function` runtime error by migrating to `pi.registerTool(...)` API with unified loader fallback across Pi Agent runtimes.
- **Git Worktree Isolation (#5)**: Added `resolveWorktreeRoot` using `git rev-parse --show-toplevel` to prevent search results from leaking across sibling Git worktrees.
- **Resilience Watchdog & Fail-Open Fallback (#7)**: Implemented auto-reconnecting socket watchdog with exponential backoff and seamless fallback to native `ripgrep`/`find` on daemon disconnection.

### Added
- **QuickJS WASM Code Mode Declarations (#6)**: Exported `renderFSearchDeclarations()` and `getFSearchCodemodeTools()` in `src/codemode.ts` for zero-shot single-turn agent workflows in `@earendil-works/pi-codemode`.
- **Git Status Query Filters (#8)**: Native support for `git:modified`, `git:staged`, and `git:untracked` query filters directly in `fsearch_query`.
- **Frecency Lifecycle Tracking (#9)**: Automated hook into `tool_execution_end` tracking file operations (`read`, `edit`, `write`, `view_file`) and forwarding touches to daemon `{"op": "open"}`.
- **Proximity Re-Ranking (#10)**: Directory-distance scoring algorithm (`near: <path>` / `near` option) prioritizing files closer in tree hierarchy to active editing context.
- **Multi-Pattern Disjunction Grep (#11)**: Registered `fsearch_multi_grep` for concurrent multi-symbol retrieval in a single IPC pass.
- **Dynamic Ignore Rules (#12)**: Trie-based pattern matcher in `src/sanitize.ts` evaluating `.gitignore` and `.ignore` outside git repositories.
- **Enterprise Credential Scrubbing (#13)**: Hardened regex scrubbing covering Slack tokens, Stripe live keys, AWS temporary credentials (STS), GCP API keys, fine-grained GitHub PATs, and path traversal (`../`) protection.
- **Model Context Protocol (MCP) Server (#14)**: Native stdio JSON-RPC 2.0 server in `src/mcp.ts` and executable `bin/mcp-server.ts` for universal integration with T3 Code and Antigravity.
- **Latency CI Regression Gate (#15)**: Automated test suite `test/benchmark-gate.test.ts` enforcing strict sub-10ms p95 search latency and sub-5ms p95 grep latency in GitHub Actions CI.

---

## [0.1.0] - 2026-10-13

### Added
- **Line-Buffered UNIX Socket Client (#1)**: Implemented `FSearchClient` in `src/client.ts` communicating with `~/Library/Application Support/FSearch/fsearch.sock`. Uses Node.js `readline` to guarantee clean message boundaries.
- **Pi Agent Tools (#2)**: Registered `fsearch_query`, `fsearch_grep`, `fsearch_locate`, and `fsearch_recent`.
- **Security Scrubbing (#3)**: Built-in credential redactor removing GitHub tokens, AWS keys, JWTs, and private keys.
- **Upstream FSearch Engine Update (#4)**: FSearch v0.2.1 engine update with 37% smaller index and 1.3ms live edit-to-grep sync.
