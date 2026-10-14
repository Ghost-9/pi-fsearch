# Contributing to pi-ultrasearch

We welcome contributions to `pi-ultrasearch`!

## Development Workflow

1. Install dependencies and check types:
   ```bash
   npm install
   npm run typecheck
   ```

2. Run the test suite. Integration tests require the resident `fsearch` daemon and are **skipped cleanly** when it is
   not running, so the suite is safe on a bare machine:
   ```bash
   npm test
   ```

3. Run the latency gate. This always executes a hermetic mock-socket gate (client IPC round-trip, p95 < 10 ms search /
   < 5 ms grep) and additionally runs the live daemon gates when a daemon is available:
   ```bash
   npm run test:gate
   ```

4. Run empirical benchmarks (requires the daemon; these are developer tools, not CI):
   ```bash
   npm run bench
   node test/deep-bench.ts
   ```

### Rules
- Benchmark and gate code must set `process.env.PI_ULTRASEARCH_TEST = "1"` so it never writes into the production
  audit log at `~/.pi/agent/cache/pi-ultrasearch/audit.jsonl`.
- Do not record telemetry twice: the client is the single audit-recording layer (use `auditTool` for tool-specific
  names instead of wrapping `recordAudit` around a client call).
- New performance claims must cite repeatable measurements (median over repeated runs, scope, date) — see
  `OPTIMIZATIONS.md` §E.

## Commit Guidelines

Follow Conventional Commits:
- `feat:` for new capabilities or tools.
- `fix:` for bug fixes or edge case protections.
- `perf:` for latency optimizations.
- `docs:` for updates to ROADMAP or documentation.
- `test:` for benchmark or test coverage additions.
