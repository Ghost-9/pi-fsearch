# Pi-UltraSearch Architecture & Roadmap

This roadmap tracks the development lifecycle of `pi-ultrasearch`. It was rewritten on **2026-10-14** after a full
repository audit (`AUDIT-2026-10-14.md`). Milestone statuses now reflect what is actually reachable in a running
session, not merely what exists in the tree.

Semantic versioning (`MAJOR.MINOR.PATCH`):
- **0.1.x** — socket client, core tool bindings (released)
- **0.2.x** — resilience, worktree scoping, rebrand, license, observability foundations (released)
- **0.3.x** — git filters, ranking, multi-grep, TUI, learner, MCP server, **honesty release 0.3.1** (current)
- **0.4.x** — hardening + measured performance overhaul (`OPTIMIZATIONS.md` P0/P1)
- **0.5.x** — interop polish: MCP parity across clients, Code Mode pipelines, cross-platform groundwork
- **1.0.0** — production gates: deterministic multi-scope benchmark suite, hermetic CI, documented SLAs

---

## Audit reality check (2026-10-14)

The first version of this roadmap declared milestones 4–6 complete at version 0.3.0 while CI had never passed, the
MCP server was registered nowhere, `.gitignore` evaluation was dead code, and the "1 M+ file" gate tested a ~25-file
repository. The audit matrix is reproduced in `AUDIT-2026-10-14.md`; the corrective work is itemised in
`OPTIMIZATIONS.md`.

Legend: ✅ shipped & reachable · 🟡 partial / limited · ❌ not delivered at that time · 🔧 corrected in 0.3.1

---

## Current milestone status

### Milestone 1 — IPC daemon & core Pi extension (v0.1.0) — ✅ released
- [x] #1 Line-buffered UNIX socket client with correlation ids (`src/client.ts`)
- [x] #2 Core tools: `ultrasearch_query`, `ultrasearch_grep`, `ultrasearch_locate`, `ultrasearch_recent`
- [x] #3 Secret scrubbing and sensitive-file masking (`src/sanitize.ts`)
- [x] #4 Upstream fsearch v0.2.1 engine (MIT; tracked in `~/.cache/fsearch`)

### Milestone 2 — Hardening, Code Mode, resilience (v0.2.0) — ✅ released
- [x] #5 Worktree scoping via nearest-`.git` walk (cached)
- [x] #6 Code Mode TypeScript declarations (`src/codemode.ts`) — *library only*; the harness exposes tools to the
      sandbox directly, so this module is not required at runtime
- [x] #7 Reconnect watchdog + `rg`/`find` fallback

### Milestone 3 — Git engine & ranking (v0.3.0) — ✅ released
- [x] #8 `git:` query filters (`git:modified`, `git:staged`, `git:untracked`) — verified against upstream git engine
- [x] #9 `tool_execution_end` frecency hook — implemented; end-to-end regression test still missing
- [x] #10 Proximity re-ranking (`near:`)
- [x] #11 `ultrasearch_multi_grep`

### Milestone 4 — Security & ignore rules (v0.4.0) — 🟡 **in progress** (was mislabelled complete)
- [x] #12 🔧 `.gitignore` / `.ignore` evaluation **wired into search & grep results** (0.3.1) with a per-scope cache;
      declared rules only — built-in defaults stay opt-in
- [x] #13 Enterprise patterns (Slack, Stripe, GCP, AWS STS) — present
- [ ] #13 remaining: configurable fail-closed directory blocklists; DLP applied to query path output;
      PEM regex fix (tracked in `OPTIMIZATIONS.md` §F)

### Milestone 5 — MCP & interop (v0.5.0) — 🟡 **in progress** (was mislabelled complete)
- [x] #14 stdio MCP server (`src/mcp.ts`, dual `ultrasearch_*` / `ultrasearch_*` names, semantic mode, context, tags)
- [x] #14 🔧 registered in **Antigravity**, **VS Code**, and **Claude Desktop** (0.3.1)
- [ ] #14 remaining: T3 Code has no generic user-level MCP registry — documented; Pi deliberately uses the native
      extension instead of a duplicate MCP tool surface

### Milestone 6 — Production CI & latency gates (v1.0.0) — 🟡 **in progress** (was mislabelled complete)
- [x] #15 🔧 CI is now **hermetic and green-capable**: daemon-dependent integration tests skip cleanly on a bare
      runner, and a **mock-socket latency gate** runs everywhere (0.3.1)
- [ ] #15 remaining: real multi-scope benchmark fixtures (repo / monorepo / home / whole disk) with medians,
      confidence intervals, and output-equivalence checks — see `OPTIMIZATIONS.md` §E

---

## Completed corrective release — v0.3.1 (2026-10-14)

- CI: hermetic tests + mock-socket gate; the job can pass on a clean machine and the gate now actually executes.
- Telemetry: benchmark/gate runs isolated from production audit log; single-layer audit recording (no duplicates);
  `ultrasearch_compact` rows no longer report the whole index as hits.
- Learner: `recordMistake()` now called from real empty-result, path-mismatch, DLP and CLI-bypass paths.
- Ignore rules: `loadIgnoreRules()` is production code, applied to `query`, `grep`, and `multi_grep`.
- Semantic mode wired into `ultrasearch_grep` (Pi + MCP); context/tag options exposed to Pi tools; MCP gains `near`.
- Fallback upgraded from `grep -rn` to `rg` (with `grep` fallback) and `find` max-depth cap removed.
- Auto-compaction supervisor wired into the interactive TUI lifecycle.
- MCP registered in Antigravity / VS Code / Claude Desktop (Pi excluded by design).
- Docs: README, ROADMAP, CHANGELOG rewritten against measured evidence; `OPTIMIZATIONS.md` added.

---

## Next: v0.4.0 — hardening & performance overhaul

Full detail, evidence and expected impact in [`OPTIMIZATIONS.md`](OPTIMIZATIONS.md).

**Performance (engine & client)**
1. Search-side `budget_ms` deadlines and partial-result streaming for cold/global queries (tail: 1.7–4.0 s observed).
2. Content-index coverage configuration + warm-up on daemon start (currently ~129 k docs / 3.7 M entries).
3. Socket concurrency (connection lanes) to remove head-of-line blocking for parallel agent calls.
4. Staleness metric in `status` (FSEvents drops + compaction windows) and agent-visible freshness hints.
5. Token accounting harness: replace `150 + 75 × hits` estimate with measured A/B prompt-token deltas.

**Quality**
6. Multi-scope benchmark fixtures + medians/CI; per-scope regression thresholds in CI.
7. End-to-end regression tests: frecency hook, two-linked-worktree scoping, ignore rules, semantic mode.
8. Security: PEM regex fix, DLP on path results, scope containment for `query`, fail-closed blocklists.

**Features**
9. AST/symbol index (tree-sitter) so `mode: symbol` ranks real definitions, not regex shapes.
10. `ults watch` (query on file-change) and multi-root workspace support.
11. Cross-platform daemon distribution + Linux CI matrix.

---

## Later: v0.5.0 — interop and Code Mode

- MCP parity audit across Antigravity / VS Code / Claude Desktop / Cursor; client-specific smoke tests.
- Code Mode pipeline recipes (search → grep → read in one sandbox turn) with generated declarations.
- Result deduplication across linked worktrees and multi-root scopes.
- Query history, suggestions, and per-tool token budgets.

## v1.0.0 — production gates

- Deterministic benchmark suite committed as JSON results, run on every release.
- Documented SLAs per scope (warm path, cold path, content grep) with alert thresholds.
- Cross-platform support for at least macOS + Linux, with the daemon packaged and verifiable.
