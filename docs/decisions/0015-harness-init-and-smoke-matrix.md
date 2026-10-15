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

**Two joined causes, both scope — not code.** (1) A linked git worktree is deliberately outside the
content index: `engine/src/content.rs::linked_worktree` ("Its text is mostly its main checkout's: left
out", documented in `engine/README.md` §"What grep covers"), so a scoped grep there is served by
`source=scan` by construction — not by a cold index that warms. (2) A `scan` is not ignore-filtered the
way the content index is, so a worktree carrying a large gitignored build cache (`engine/target`, 182 MB
here) returns those hits and the *client* filters them after the response, ~8 ms per grep. The live gate
asserts `client p50 - raw p50 < 3 ms`; that is the only failing gate. Measured on 2026-10-15, same
branch and same daemon:

| Checkout (same code) | grep source | live gate |
|:--|:--|:--|
| this linked worktree, `engine/target` present | `scan` | **fails**: grep overhead ~8 ms |
| this linked worktree, `engine/target` moved out | `scan` | **passes 8/8**: grep p95 4.54 ms, overhead 1.62 ms, load1 16 |
| normal clone of this branch | `index` | **passes 8/8**: grep p95 1.74 ms, search p95 0.68 ms |
| untouched a1f4f1d linked worktree | `scan` | passed once because the raw leg was equally slow — same condition |

`src/client.ts`, `src/mcp.ts` and `test/benchmark-gate.test.ts` are byte-identical to a1f4f1d in this
branch; `npm test` (225 pass / 1 intentional skip) and `npm run test:engine` (42/42) pass in the
worktree. Wave 5 work in a linked worktree should either move the gitignored build cache out for the
gate run (measured above) or run `npm run test:gate` from the primary checkout / a normal clone, and
treat a worktree-only failure of the live grep overhead assertion as this documented scope property.
The real fix — filter ignored directories before the daemon returns scan hits — is an engine/client
change that needs its own paired A/B and is not attempted here.
