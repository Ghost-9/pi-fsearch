# Changelog

All notable changes to `pi-ultrasearch` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Entries up to and including 0.3.1 are kept as written, with one retrospective edit: historical
> `fsearch_*` tool names were renamed to today's `ultrasearch_*` so the file reads consistently.
> Upstream-engine references (the upstream project URL, `~/.cache/fsearch`, MIT © Noah Dunnagan)
> are unchanged — they are attribution, not rebranding.

---

## [Unreleased] — UltraSearch-only naming, build/distribution, MCP conformance

### Changed (breaking)
- **One name, end to end.** The extension tools are `ultrasearch_query`, `ultrasearch_grep`,
  `ultrasearch_multi_grep`, `ultrasearch_locate`, `ultrasearch_recent`, `ultrasearch_metrics`;
  the `/fsearch` slash command is removed (only `/ultrasearch` remains); `bin/mcp-server.ts` exposes exactly
  one `ultrasearch_*` tool surface and the `fsearch_*` aliases are gone from MCP `tools/list` and from the
  Code Mode declarations. MCP clients that hard-coded `fsearch_*` names must switch to `ultrasearch_*`.
- **Daemon socket and state paths.** macOS `~/Library/Application Support/UltraSearch/ultrasearch.sock`;
  Linux `$XDG_RUNTIME_DIR/ultrasearch.sock`, else `~/.local/share/ultrasearch/ultrasearch.sock`;
  Windows `\\.\pipe\ultrasearch`. Environment overrides remain `PI_ULTRASEARCH_*` only.
- **Engine and daemon binary** are now the rebranded `ultrasearch` (installed as `ultrasearch-daemon`),
  produced by `engine/rebrand.sh` from upstream fsearch v0.2.1 (MIT, © Noah Dunnagan — see `NOTICE`).
  `trySpawnDaemon()` candidates are `UltraSearch.app` and `ultrasearch-daemon` only.

### Added
- **#43 build & distribution** — `npm run build` compiles TypeScript to `dist/` (ESM with `.ts` import
  specifiers rewritten to `.js`); `bin` entries point at built JavaScript; `engines.node >= 22.18` and `.nvmrc`;
  an explicit `files` allowlist; `typebox` declared as an optional peer dependency with a README note; CI adds a
  `npm pack` + packed-CLI `--help` smoke step.
- **#44 MCP conformance** — `test/mcp.test.ts` covers the initialize/initialized lifecycle, protocol-version
  negotiation, `tools/list` (single prefix, unique names, schemas, Pi-parity), `tools/call` for all six tools,
  malformed params, tool-level errors, unknown method (-32601), invalid request (-32600), parse error (-32700),
  pre-initialize rejection (-32002), notifications-never-answered, and stdio framing (split writes, batched
  messages, CRLF, blank lines). `src/mcp.ts` enforces that contract instead of the previous ad-hoc responses.
- `NOTICE` (upstream MIT attribution) and `docs/engine-rebrand.md` (migration + rollback runbook).
- `engine/rebrand.sh <src-dir> <dst-dir>` — deterministic, idempotent rebrand of an upstream engine checkout
  (LICENSE and upstream URLs are never rewritten).

### Fixed
- `npm run build` surfaced four latent type errors that `tsc` had never checked because `tsconfig.json`
  only listed ten files: `bin/cli.ts` (`recent` iterated a response object; `metrics` passed an array where a
  limit was expected) and `src/compactor.ts` (possibly-undefined `status.overlay` / `status.removed`).

---

## [0.3.1] - 2026-10-14

Honesty + reliability release driven by the full repository audit (`AUDIT-2026-10-14.md`).

### Fixed
- **CI**: daemon-dependent integration tests now skip cleanly on a bare runner and a **hermetic mock-socket latency gate** runs everywhere, so the GitHub Actions job can pass and the benchmark gate actually executes. Previously 18/18 runs failed and the gate step was unreachable.
- **Telemetry integrity**: benchmark-gate runs are isolated with `PI_ULTRASEARCH_TEST=1`; audit rows are recorded in a **single layer** (client) instead of client + tool wrapper duplicates; `ultrasearch_compact` rows no longer report the whole index as `hitCount`.
- **Recursive learning**: `recordMistake()` is invoked by real failure paths (empty results, path mismatch, DLP interception, CLI bypass) instead of only tests.
- **`.gitignore` / `.ignore` evaluation** was dead code; it is now applied to `query`, `grep`, and `multi_grep` results for the declared scope, with a 60-second per-scope cache.
- **Fallback quality**: native fallback prefers `rg` (with `grep` fallback) and the `find` max-depth cap was removed.
- **Rich results**: `ultrasearch_grep` no longer requests and discards context lines; optional `context` and `tag_symbols` parameters are exposed to Pi and MCP clients.
- **MCP registration**: registered in Antigravity (`~/.gemini/antigravity/mcp_config.json`, `~/.gemini/config/mcp_config.json`), VS Code user `mcp.json`, and Claude Desktop. Pi deliberately keeps the native extension rather than a duplicate MCP tool surface.
- Documentation: README and ROADMAP rewritten against measured evidence; `OPTIMIZATIONS.md` added; version metadata reconciled to 0.3.1.

### Added
- `mode: "semantic"` in `ultrasearch_grep` (Pi + MCP) wiring the intent-expansion module into a reachable path.
- `near` parameter on the MCP `ultrasearch_query` tool.
- Auto-compaction supervisor started/stopped with the interactive TUI lifecycle.

---

## [0.3.0] - 2026-10-13

Retroactive entry for work that shipped after 0.2.2 without a changelog update.

### Added
- Interactive observability TUI (`src/tui.ts`, `bin/tui.ts`): live metrics, audit inspector, learning store, one-key LSM compaction, FDA helper.
- LSM compaction supervisor (`src/compactor.ts`) with manual and automated modes and compaction history.
- Recursive learning store (`src/recursive-learning.ts`) with typo remappings, mistake patterns, and CLI bypass/DLP counters.
- Semantic intent expansion (`src/semantic.ts`) — concept dictionary to code-token expansion.
- Rich grep results: code context windows (`-C`), AST symbol tags, and MCP support (`src/formatter.ts`, `src/mcp.ts`).
- Daemon management: launchd `com.pi.ultrasearch` LaunchAgent with `KeepAlive`, `authorize` command, and unified `UltraSearch.app` branding for stable Full Disk Access attribution.
- Dynamic native fallback for consent-gated workspaces (Downloads/Documents/Desktop).
- CLI surface (`bin/cli.ts`): `query`, `grep`, `metrics`, `audit`, `compact`, `learnings`, `tui`.

---

## [0.2.2] - 2026-10-13

### Changed
- **License Conversion to GNU AGPLv3**: Relicensed project from MIT to the **GNU Affero General Public License v3.0 (AGPL-3.0-or-later)** to guarantee copyleft protection and close the remote network SaaS loophole (Section 13). Updated `LICENSE`, `package.json`, and `README.md`.
- **Extension & Repository Rebranding**: Formally renamed extension to `pi-ultrasearch` across all documentation, metadata, type definitions, MCP server declarations (`pi-ultrasearch-mcp`), and package repository manifests (`https://github.com/Ghost-9/pi-ultrasearch.git`).
- **Slash Commands**: Registered `/ultrasearch` command for inspecting real-time metrics, telemetry audits, and status, retaining `/ultrasearch` as backwards-compatible alias.
- **Cache Path Alignment**: Telemetry logs default to `~/.pi/agent/cache/pi-ultrasearch/audit.jsonl` with seamless migration from existing audit files.

---

## [0.2.1] - 2026-10-13

### Changed
- **Zero Typo Tolerance Enforced**: Completely eliminated all fuzzy typo forgiveness across `ultrasearch_query` and fallback search. Plain query terms are transformed into strict exact match mode (`Mode::Exact`), guaranteeing zero false positives and deterministic resolution.

### Added
- **Full Hybrid Observability System**:
  - Persistent JSONL append-only audit logger in `~/.pi/agent/cache/pi-ultrasearch/audit.jsonl`.
  - **Toolchain Shadow Detector** (`src/observer.ts`): Intercepts `bash` and `powershell` execution to flag CLI search bypasses (`find`, `rg`) where indexed search would be 12–45× faster.
  - **Diagnostic Analyzer**: Provides actionable corrective guidance on 0-hit queries (detects whether exact matches exist under different directories or advises on exact matching).
  - **Profiler Tool & Slash Command**: Registered `ultrasearch_metrics` tool and `/ultrasearch` (and `/ultrasearch`) slash command (`metrics`, `audit`, `reset`, `status`) to observe p50/p90/p95 latency and anti-patterns.

---

## [0.2.0] - 2026-10-13

### Fixed
- **Extension Tool Registration**: Fixed `pi.defineTool is not a function` runtime error by migrating to `pi.registerTool(...)` API with unified loader fallback across Pi Agent runtimes.
- **Git Worktree Isolation (#5)**: Added `resolveWorktreeRoot` using `git rev-parse --show-toplevel` to prevent search results from leaking across sibling Git worktrees.
- **Resilience Watchdog & Fail-Open Fallback (#7)**: Implemented auto-reconnecting socket watchdog with exponential backoff and seamless fallback to native `ripgrep`/`find` on daemon disconnection.

### Added
- **QuickJS WASM Code Mode Declarations (#6)**: Exported `renderUltraSearchDeclarations()` and `getUltraSearchCodemodeTools()` in `src/codemode.ts` for zero-shot single-turn agent workflows in `@earendil-works/pi-codemode`.
- **Git Status Query Filters (#8)**: Native support for `git:modified`, `git:staged`, and `git:untracked` query filters directly in `ultrasearch_query`.
- **Frecency Lifecycle Tracking (#9)**: Automated hook into `tool_execution_end` tracking file operations (`read`, `edit`, `write`, `view_file`) and forwarding touches to daemon `{"op": "open"}`.
- **Proximity Re-Ranking (#10)**: Directory-distance scoring algorithm (`near: <path>` / `near` option) prioritizing files closer in tree hierarchy to active editing context.
- **Multi-Pattern Disjunction Grep (#11)**: Registered `ultrasearch_multi_grep` for concurrent multi-symbol retrieval in a single IPC pass.
- **Dynamic Ignore Rules (#12)**: Trie-based pattern matcher in `src/sanitize.ts` evaluating `.gitignore` and `.ignore` outside git repositories.
- **Enterprise Credential Scrubbing (#13)**: Hardened regex scrubbing covering Slack tokens, Stripe live keys, AWS temporary credentials (STS), GCP API keys, fine-grained GitHub PATs, and path traversal (`../`) protection.
- **Model Context Protocol (MCP) Server (#14)**: Native stdio JSON-RPC 2.0 server in `src/mcp.ts` and executable `bin/mcp-server.ts` for universal integration with T3 Code and Antigravity.
- **Latency CI Regression Gate (#15)**: Automated test suite `test/benchmark-gate.test.ts` enforcing strict sub-10ms p95 search latency and sub-5ms p95 grep latency in GitHub Actions CI.

---

## [0.1.0] - 2026-10-13

### Added
- **Line-Buffered UNIX Socket Client (#1)**: Implemented `UltraSearchClient` in `src/client.ts` communicating with `~/Library/Application Support/UltraSearch/ultrasearch.sock`. Uses Node.js `readline` to guarantee clean message boundaries.
- **Pi Agent Tools (#2)**: Registered `ultrasearch_query`, `ultrasearch_grep`, `ultrasearch_locate`, and `ultrasearch_recent`.
- **Security Scrubbing (#3)**: Built-in credential redactor removing GitHub tokens, AWS keys, JWTs, and private keys.
- **Upstream fsearch Engine Update (#4)**: UltraSearch v0.2.1 engine update with 37% smaller index and 1.3ms live edit-to-grep sync.
