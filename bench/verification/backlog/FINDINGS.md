# Findings — wave-5 backlog adjudication (verifier)

Owner: independent verifier (`wave1/verify-final`). **Nothing here was fixed.** Each finding
carries a reproduction; the raw evidence is under `bench/verification/backlog/results/`.
Numbering continues the wave-4 record (F14 was the trigram index-composition finding).

No row in `bench/verification/backlog-closure.json` compares identical or stale artifacts to the
thing under test: every verdict is a fresh run, a fresh derivation, or a mutation control.

---

## F15 — smoke-matrix artifacts are still not fresh at HEAD (#52, open)

**Status: open at `0ad4919`.** The artifacts were regenerated (commit `0ad4919` touches all ten),
but they were generated *before* that commit landed: every artifact names `cc37a9a0` — the parent
— and carries `"worktreeDirty": true`, i.e. the tested tree included uncommitted changes (the
`index.ts` fix). Verified at HEAD `0ad4919`:

```bash
PI_ULTRASEARCH_TEST=1 node bench/harness-matrix.mjs --check --require-fresh; echo $?
# 10 problem(s): stale:pi … stale:antigravity   → exit 1
python3 -c "import json;d=json.load(open('bench/harness-smoke/pi.json'));print(d['commit'][:7], d['worktreeDirty'])"
# cc37a9a True
```

**Mechanism (not a defect in the checker):** `--require-fresh` compares `artifact.commit` with
`git rev-parse HEAD`, and `worktreeDirty` is sampled before the smoke writes anything. Once the
artifact-bearing commit moves HEAD, committed artifacts can never be fresh again — the acceptance is
only satisfiable in the regenerate-then-check window (the CI form: clean checkout at HEAD, regenerate,
check, do not commit). The MCP surface itself is correct: the verifier's own live `initialize` →
`tools/list` handshake from the checkout returns the canonical six tools at `2025-06-18`, agreeing
with every stored artifact.

## F16 — nightly real-session summary is not wired to any scheduler (#31, acceptance unmet)

**Observed:** `bench/nightly-summary.mjs` documents `Cron: 0 3 * * *`, but no CI workflow mentions
it and no crontab/launchd entry runs it. The only artifacts are `nightly-2026-10-14.{json,md}`.

**Reproduction:**
```bash
grep -rl nightly .github/workflows/ ; crontab -l | grep -i nightly ; ls bench/results/nightly-*
```
**Note:** the real/synthetic *view* itself works (see the closure row): the default view is `real`,
`synthetic` rows are excluded, and `report --json` reports `filteredOutRows`.

---

## F17 — no edit→grep latency measurement exists for prefetch (#41, acceptance unmet)

**Observed:** the functional behaviour reproduces (single `tool_execution_end` listener; five rapid
edits coalesce to one `prefetch`; a read warms nothing), but the acceptance line "Edit→grep latency
measured before/after in the harness" has no artifact. No ungated latency claim is published either,
so nothing false is stated — the measurement is simply absent.

**Reproduction:** `bench/verification/backlog/checks/f41-prefetch.mjs` (see its artifact).

---

## F18 — `execFileSync` on the request path — **RESOLVED at `0ad4919`** (#24)

**Was:** `index.ts::resolveWorktreeRoot()` fell back to `execFileSync("git", ["rev-parse",
"--show-toplevel"])` when no `.git` was found walking up; measured through the real Pi harness from
a non-git cwd with a stubbed `git`: 1 synchronous invocation, max event-loop gap **773 ms**.

**Now (re-measured on `0ad4919`):** the fallback is gone. Same probe: **0 git invocations, max gap
11.81 ms**. Async fallback still responsive (max gap 11.32 ms while a stubbed `rg` slept 400 ms;
`source=native_fallback`, 1 hit), cancellation still stops the child (1 tracked mid-flight → 0 after
abort), and the `src/spawn.ts → execFileSync` removal control still blocks (477 ms), so the probe is
sensitive.

**Guard non-vacuity:** re-adding the pre-fix call to `index.ts` in a scratch copy makes the widened
guard (`test/fallback.test.ts`, now scanning `src/client.ts` **and** `index.ts`) fail, while the old
`client.ts`-only scope still passes — the widening is load-bearing.

## F19 — `ultrasearch init --remove --write` does not byte-restore a pre-existing config (#51, fidelity nit)

**Observed:** with a pre-existing config `…key = 1\n`, one `--write` and then
`--remove --write` leaves the file as `…key = 1` (the trailing newline is gone). The *printed*
`revert : cp <backup> <config>` restores the original bytes exactly, so reversibility holds; only
the removal path's whitespace fidelity is off. All other `init` acceptance lines reproduce
(8/8 harnesses registered on a fresh HOME, dry-run writes nothing, idempotent, unparseable configs
refused with exit 1 and left byte-identical).

**Reproduction:** `node bench/verification/backlog/checks/harness-cli.mjs`; `results/f51-init.json`.

---

## F20 — TUI per-row savings figure is unlabelled on its own line (#20, cosmetic)

**Observed:** the TUI header says `[💰 Tokens Saved (est)]` and the expanded inspector says
`Tokens Saved (ESTIMATE) … not measured`, but the per-row `(+${n}t saved)` line carries no label.
The CLI summary (`ESTIMATE ONLY — formula 150+75×hits, not measured`) and the TUI header do. Under
a strict reading of "labelled everywhere it is displayed" this one line is a gap.

**Reproduction:** `grep -n "t saved" src/tui.ts`; `results/m20-tokens.json`.

---

## F21 — the smoke protocol arm exercises the installed shim, not the checkout (#52)

**Observed:** each stored protocol artifact records `launch.source: "installed"` with
`command: /Users/batra/.local/bin/ultrasearch-mcp`. The arm therefore proves the installed MCP
shim's surface (against a mock daemon), not the checkout's. The verifier's own run of
`bin/mcp-server.ts` from the checkout agrees (6 tools, `2025-06-18`), so no divergence exists today
— but the artifact alone cannot catch a checkout-side regression.

**Reproduction:** `python3 -c "import json;print(json.load(open('bench/harness-smoke/pi.json'))['arms']['protocol']['launch'])"`.

---

## F22 — the #50 engine guard is live (positive control)

**Observed:** an engine built from `ba76d15~1` (source before the protocol freeze) fails the shipped
`test/engine/status.test.mjs` with `status is missing protocol_version`; the binary built from HEAD
passes and reports `protocol_version: "1.0"`. `docs/protocol.md` (twice), `PROTOCOL_VERSION`, and a
real isolated daemon all read `1.0`; a daemon reporting `2.0` produces
`protocol_mismatch: {client: "1.0", daemon: "2.0"}`.

**Reproduction:** `PI_ULTRASEARCH_TEST=1 node bench/verification/backlog/checks/daemon-suite.mjs`;
`results/f50-protocol.json` (`stale_binary_control`).

---

## F23 — every functional guard dies when its feature is removed (positive control)

Nine mutations, each in a fresh `git archive HEAD` copy, restore the pre-fix behaviour and make the
shipped guard test fail: #25 filter-then-limit, #27 `stop()` watcher close, #28 realpath dedupe,
#30 default MCP surface, #31 real-by-default view, #37 `tokenCount`, #40 opt-in history,
#51 unparseable-config refusal, #53 half-marker refusal. Plus: #24 async spawn → 472 ms event-loop
block; #29 registry description change → declaration drift test fails; #41 debounce → 5 flushes
instead of 1; #49 pre-fix scope/limit → the archive-scope assertion fails.

**Reproduction:** `node bench/verification/backlog/checks/removal-matrix.mjs`;
`results/removal-matrix.json`.

---

## F24 — `npm test` does not cover the engine (process note)

**Observed:** `npm test` runs the TypeScript/Node suites only; `test/engine/*` and
`test:gate` are separate scripts (`test:all` chains them). A source/binary drift in the Rust engine
is therefore invisible to the default test command — the verifier's pre-existing worktree binary
(sha256 `16091e93…`, built 2026-10-15 18:02) failed `test/engine/status.test.mjs` while `npm test`
stayed green. The main checkout's binary (`f9168ccf…`, 2026-10-16 00:39) is current; this is a
process gap, not a delivery defect.

**Reproduction:** `npm test` vs `npm run test:engine` on a checkout whose engine binary predates
the engine source.

---

## Gate (applies to every row)

`bench/baseline/gate-check.mjs` reports **provisional** throughout this session: AC power yes, no
cargo/rustc, but load1 5.2–6.5 against the `< 1.5` bound. Every functional/set row is unaffected
(they are membership and ordering comparisons). The two measurement rows (#20, #21) are marked
`needs-work` for exactly this reason; their committed artifacts are also `-degraded`.
