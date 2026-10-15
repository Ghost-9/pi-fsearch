# 0015 — Harness init and the smoke matrix

Date: 2026-10-15 · Issues: #51, #52 · Status: accepted

## Decision

**1. `ultrasearch init` plans unless `--write` is passed.** The issue text says "`--dry-run` prints the
diff", which would imply writing by default. We reversed the default: an operator's harness config is
personal state (`~/.claude.json` is tens of kilobytes of Claude Code state), and a tool that rewrites it
on first contact is a liability. `ultrasearch init` therefore prints the action, diff, backup path and
revert command, and writes nothing; `--write` applies. `--dry-run` remains accepted as an explicit
synonym and is rejected together with `--write`.

**2. Configs are edited surgically, never re-serialized.** `src/config-edit.ts` locates the exact
member/table with a scanner, splices text, and re-parses the result before it can be written. Reasons:
round-tripping `~/.claude.json` through `JSON.parse`/`stringify` reformats unrelated machine state, and
Zed's `settings.json` is JSONC — comments and trailing commas are the user's, not ours. Anything the
scanner cannot parse (unterminated strings, inline `mcp_servers = …`, duplicate TOML tables) is refused,
with the reason, and never guessed at. After a write the entry is read back; a mismatch restores the
backup (or deletes a file we created).

**3. The registry records *how* an entry shape was established.** Every row in
`src/harness-registry.ts` carries `entryShapeSource` ∈ {`machine-measured`, `machine-observed`, `docs`,
`assumed`}. Claude Code and Codex were measured by pointing their own CLIs at a temp `HOME`/`CODEX_HOME`
and reading what they wrote (`claude mcp add --scope user`, `codex mcp add`). Claude Desktop, Cursor,
Windsurf, VS Code and Antigravity shapes were observed in live registrations on this machine; Zed is
from its current documentation. A shape that cannot be defended is labelled, not implied.

**4. The smoke matrix separates the protocol arm from the native arm.**
- The **protocol arm** starts the server the way the harness would (the command from its live config when
  present, else the resolved `ultrasearch-mcp`), speaks `initialize` at the harness's declared revision,
  checks exactly six canonical `ultrasearch_*` tools, and performs one `tools/call`. Its daemon is a
  hermetic mock over a temp socket: this arm proves the MCP surface, not engine behaviour, and its
  artifact says `daemon: mock`.
- The **native arm** runs the harness's own CLI where one exists. Claude Code runs against a recording
  proxy (`bench/harness-smoke/probe-server.mjs`) so the artifact contains the harness's *measured*
  `protocolVersion`/`clientInfo` rather than our assumption; Codex runs `codex mcp add`/`mcp list` and
  the artifact is labelled `config-only` because that CLI does not handshake. Both use temp configs, so
  no live harness config is touched by a smoke.
- Where no non-interactive CLI exists the arm is `skipped:<reason>` (or `inherits-pi-provider` for T3
  Code). `--check` fails on a reasonless skip: an explicit "unsupported" is required, never an implied
  pass.

**5. Measured beats assumed.** The first native run showed Claude Code 2.1.299 requesting protocol
revision **2025-11-25**, newer than the server's newest supported (`2025-06-18`). The registry now
records the measured value and the smoke asserts that a declared-but-unsupported revision is negotiated
down to the newest supported one. The matrix prints `(assumed)` on every row that has not been measured.

## Rejected

- **`JSON.stringify` whole-file rewrites** — reformats user state and destroys JSONC comments.
- **A TOML library dependency** — the project has no runtime dependencies; the conservative scanner plus
  refuse-on-unknown covers the one table we write, and refuses anything the writer did not produce.
- **Registering `ultrasearch` into the live harness configs during smoke tests** — smokes read live
  configs (read-only) and otherwise work in a temp HOME; only `init --write` ever touches a real config.
- **Reusing `tool-schema.ts` names from the live config** — the protocol arm asserts against
  `TOOL_SCHEMAS`, so a hand-edited config cannot make a smoke pass with the wrong tools.
- **Treating the live benchmark gate's failure as a code regression** — see the note below.

## Known behaviour found while running the gates (not introduced here)

**A linked git worktree is deliberately outside the content index.** The engine says so in
`engine/src/content.rs::linked_worktree` ("Its text is mostly its main checkout's: left out", also
documented in `engine/README.md` §"What grep covers"), so a scoped grep inside a linked worktree is
served by `source=scan` by construction — not by a cold index that eventually warms. The live
benchmark gate measures `client p50 - raw p50`; with the daemon answering the raw leg in ~2 ms while the
client-side scan path costs ~10 ms (ignore filtering, ranking, audit under CPU contention), that
assertion fails, and it is the only gate that does. Measured on 2026-10-15:

| Checkout | grep source | live gate |
|:--|:--|:--|
| this linked worktree (`wave5/init-smoke`) | `scan` | fails: client overhead ~8 ms |
| untouched a1f4f1d linked worktree | `scan` | passed once because the raw leg was equally slow (~8 ms) — same condition |
| normal clone of this branch | `index` | passes: grep p95 2.17 ms, search p95 1.17 ms |

`src/client.ts`, `src/mcp.ts` and `test/benchmark-gate.test.ts` are byte-identical to a1f4f1d in this
branch, and `npm test` + `npm run test:engine` pass in the worktree, so this is an environment/coverage
property, not a regression. Wave 5 work in a linked worktree should run `npm run test:gate` from the
primary checkout or a normal clone of the branch (verified), and treat a worktree-only failure of the
live grep overhead assertion as the documented policy above.
