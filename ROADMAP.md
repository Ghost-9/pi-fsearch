# Pi-FSearch Architecture & Roadmap

This roadmap tracks the development lifecycle of `pi-fsearch`, mapping technical milestones to GitHub issues, empirical gates, and upstream `fsearch` releases.

---

## Semantic Versioning Strategy

`pi-fsearch` follows Semantic Versioning 2.0.0 (`MAJOR.MINOR.PATCH`):
- **0.1.x**: Initial client protocol, core tool bindings, line-buffered socket IPC.
- **0.2.x**: QuickJS Code Mode integration, automatic CWD and worktree scoping.
- **0.3.x**: Upstream v0.2.1 sync, live git status filters (`git:modified`), frecency open tracking.
- **0.4.x**: Enterprise security hardening, regex credential scrubbing, `.gitignore` evaluation.
- **0.5.x**: T3 Code collaborative browser and MCP daemon integration.
- **1.0.0**: Production-ready, multi-tenant workspace isolation with CI regression gate.

---

## Milestone Breakdown

### Milestone 1: IPC Daemon & Core Pi Extension (v0.1.0) — *Current*
- [x] Line-buffered UNIX socket client (`net.createConnection` + `readline`).
- [x] Multiplexed request-response handler with correlation IDs.
- [x] Basic secret scrubbing for API keys, AWS tokens, and private keys.
- [x] Tools: `fsearch_query`, `fsearch_grep`, `fsearch_locate`, `fsearch_recent`.
- [x] Empirical test harness measuring p50/p95 latency against native shell tools.

### Milestone 2: Code Mode Optimization & Worktree Isolation (v0.2.0)
- [ ] Strict CWD boundary enforcement for git worktrees (`.t3/worktrees/*`).
- [ ] Dynamic TypeScript declarations generation for `@earendil-works/pi-codemode`.
- [ ] In-sandbox array filtering and transformation helpers.
- [ ] Auto-reconnect and daemon restart watchdog.

### Milestone 3: Upstream v0.2.1 Integration & Frecency Boosting (v0.3.0)
- [ ] Direct binding to `git:` query filters (`git:modified`, `git:staged`, `git:untracked`).
- [ ] Automatic file open hook (`tool_execution_end`) sending `{"op": "open"}` to feed frecency.
- [ ] Proximity ranking (`near: <current_file>`) for related module discovery.
- [ ] Multi-pattern OR matching via `multi_grep`.

### Milestone 4: Security Hardening & .gitignore Evaluation (v0.4.0)
- [ ] Fast `.gitignore` and `.ignore` parser to filter uncommitted local build artifacts.
- [ ] Extended regex credential redactor for custom enterprise tokens.
- [ ] Consent-gated macOS directory fallback (fail-open to native `rg` when TCC restricts access).

### Milestone 5: T3 Code MCP Integration & Enterprise Production (v1.0.0)
- [ ] Expose `fsearch mcp` configuration in T3 Code / Antigravity MCP catalog.
- [ ] Unified multi-agent index sharing across concurrent child tasks.
- [ ] Sub-10ms p95 latency gate verified in CI across 1M+ file trees.
