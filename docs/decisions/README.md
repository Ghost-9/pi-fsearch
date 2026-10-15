# Decision log

One file per decision, in the format **choice → reason → rejected alternatives**.
Decisions are append-only: correcting one means adding a new entry that
supersedes it, not rewriting history. Cite the file in the commit or PR that
implements it.

Why: architectural choices (single audit layer, Pi not registering via MCP,
budget defaults, gate thresholds) otherwise live only in chat history and commit
messages, and every later session re-litigates them (#39).

| # | Decision | Status |
|:--|:--|:--|
| [0001](0001-vendored-renamed-engine.md) | Vendor a renamed fork of the engine | accepted |
| [0002](0002-single-audit-layer.md) | One audit write per call, provenance-tagged | accepted |
| [0003](0003-budget-partial-results.md) | Server-side budgets answer partial, never block | accepted |
| [0004](0004-engine-enforces-policy.md) | Policy and containment live in the engine | accepted |
| [0005](0005-content-coverage-policy.md) | Content coverage is configurable and reported | accepted |
| [0006](0006-pi-native-not-mcp.md) | Pi uses the native extension, not MCP | accepted |
| [0007](0007-verifier-owned-harness.md) | Measurements come from a verifier-owned harness | accepted |
| [0008](0008-helper-pool-registry.md) | The helper pool serves every live search | accepted (wave 2) |
| [0009](0009-low-score-run-opt-in.md) | The low-score-run stop is opt-in and reported | accepted (wave 2) |
| [0010](0010-per-process-test-logs.md) | Each test process writes its own audit log (F7) | accepted (wave 2) |
| [0011](0011-connect-before-spawn.md) | Connect before spawn, detect duplicates in status | accepted (wave 2) |
| [0012](0012-live-gate-floor.md) | The live gate derives its floor in-run and keeps overhead strict | accepted (wave 2) |
| [0013](0013-grep-page-ranking.md) | A grep page is ranked by what its files contain | accepted (wave 3) |
