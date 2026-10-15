# Contributing to pi-ultrasearch

We welcome contributions to `pi-ultrasearch`!

## Development Workflow

1. Install dependencies and check types:
   ```bash
   npm install
   npm run typecheck
   ```

2. Run the test suite. Integration tests require the resident `ultrasearch` daemon and are **skipped cleanly** when it is
   not running, so the suite is safe on a bare machine:
   ```bash
   npm test
   ```

3. Run the latency gate. This always executes a hermetic mock-socket gate (client IPC round-trip, p95 < 10 ms search /
   < 5 ms grep) and additionally runs the live daemon gates when a daemon is available. The live gate calibrates
   against the bare daemon socket in the same run (`ceiling = max(12 ms, rawP95×2+1)`, client overhead < 3 ms); a
   cold/stale window can only excuse the absolute ceiling, up to a hard blow-up cap:
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
  audit log at `~/.pi/agent/cache/pi-ultrasearch/audit.jsonl`. Test logs are per-process
  (`test_audit.<pid>.jsonl`); set `PI_ULTRASEARCH_TEST_LOG` when a run needs a fixed path (wave-1 finding F7).
- Do not record telemetry twice: the client is the single audit-recording layer (use `auditTool` for tool-specific
  names instead of wrapping `recordAudit` around a client call).
- New performance claims must cite repeatable measurements (median over repeated runs, scope, date) — see
  `OPTIMIZATIONS.md` §E.
- Before changing the daemon, the gate threshold or the helper pool, read `docs/decisions/` — one file per decision
  in the format **choice → reason → rejected alternatives** (#39). Add a new numbered file for a new decision; do not
  rewrite an accepted one, supersede it.
- Never rebuild or reinstall the resident daemon while another measurement window is open; record the daemon block
  (pid, entries, event_id) in every artifact and see `docs/daemon-single-instance.md`.

## Commit Guidelines

Follow Conventional Commits:
- `feat:` for new capabilities or tools.
- `fix:` for bug fixes or edge case protections.
- `perf:` for latency optimizations.
- `docs:` for updates to ROADMAP or documentation.
- `test:` for benchmark or test coverage additions.
