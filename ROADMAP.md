# Pi-FSearch Architecture & Roadmap

This roadmap tracks the development lifecycle of `pi-fsearch`, mapping technical milestones to GitHub issues, empirical gates, and upstream `fsearch` releases.

---

## Semantic Versioning Strategy

`pi-fsearch` follows Semantic Versioning 2.0.0 (`MAJOR.MINOR.PATCH`):
- **0.1.x**: Initial client protocol, core tool bindings, line-buffered socket IPC. (Released)
- **0.2.x**: QuickJS Code Mode integration, worktree isolation, fail-open resilience, MCP server. (Released)
- **0.3.x**: Git status filters (`git:modified`), proximity re-ranking, automated frecency tracking.
- **0.4.x**: Enterprise security hardening, custom credential scrubbing, dynamic `.gitignore` evaluation.
- **0.5.x**: Standard Model Context Protocol (MCP) registration in T3 Code & Antigravity.
- **1.0.0**: Production-ready deterministic sub-10ms CI regression gate.

---

## Milestone Breakdown & Issue Mapping

### Milestone 1: IPC Daemon & Core Pi Extension (v0.1.0) — *Released*
- [x] **#1**: Line-buffered UNIX socket client (`net.createConnection` + `readline`).
- [x] **#2**: Core Pi Agent tools: `fsearch_query`, `fsearch_grep`, `fsearch_locate`, `fsearch_recent`.
- [x] **#3**: Basic secret scrubbing for API keys, AWS tokens, and private keys.
- [x] **#4**: Upstream FSearch v0.2.1 sync with 37% smaller index and live trigram sync.

### Milestone 2: Hardening, Code Mode & Resilience (v0.2.0) — *Completed*
- [x] **#5**: Strict CWD boundary enforcement for git worktrees (`resolveWorktreeRoot`).
- [x] **#6**: Dynamic TypeScript declarations generation for `@earendil-works/pi-codemode` (`renderFSearchDeclarations`).
- [x] **#7**: Auto-reconnecting daemon watchdog and graceful fail-open fallback to native `ripgrep` / `find`.

### Milestone 3: Git Status Engine & Context Proximity (v0.3.0) — *Completed*
- [x] **#8**: First-class `git:` query filters (`git:modified`, `git:staged`, `git:untracked`) in Pi tools.
- [x] **#9**: Automated file-touch lifecycle tracking via `tool_execution_end` and `{"op": "open"}`.
- [x] **#10**: Proximity re-ranking (`near: <active_file>`) for context-relevant search.
- [x] **#11**: Multi-pattern OR content retrieval (`fsearch_multi_grep`).

### Milestone 4: Security Hardening & .gitignore Evaluation (v0.4.0) — *Completed*
- [x] **#12**: Dynamic `.gitignore` and `.ignore` rule evaluation outside repository roots.
- [x] **#13**: Extended enterprise credential scrubbing (Slack, Stripe, GCP, AWS STS) and path traversal (`../`) protection.

### Milestone 5: Universal Tool Interop & MCP (v0.5.0) — *Completed*
- [x] **#14**: Native Model Context Protocol (MCP) server over stdio (`src/mcp.ts` & `bin/mcp-server.ts`).

### Milestone 6: Production CI Latency Gate (v1.0.0) — *Completed*
- [x] **#15**: Deterministic sub-10ms p95 latency CI regression gate across 1M+ file trees (`test/benchmark-gate.test.ts` & `.github/workflows/ci.yml`).
