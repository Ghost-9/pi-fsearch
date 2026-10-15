# Findings — wave1/baseline (verifier)

Recorded during the frozen baseline run at commit `0a16e50`. **Nothing here was fixed.**
Each finding has a reproduction; severity is about evidence value, not product triage.

---

## F1 — `.gitignore` directory patterns with trailing slash are not honored

**Severity:** correctness / trust in the README claim ("Respects declared `.gitignore` / `.ignore`
rules in the scope root").

**Observed:** path search returns files under `node_modules/` even though the daemon tags them
`git: "ignored"`, and the client-side ignore filter fails to drop them. The workspace
`.gitignore` contains `node_modules/` (trailing slash).

**Reproduction:**

```bash
cd <worktree>
PI_ULTRASEARCH_TEST=1 node --input-type=module -e '
const m = await import("./src/client.ts");
const s = await import("./src/sanitize.ts");
const c = new m.FSearchClient({ timeoutMs: 15000 });
const res = await c.search("package.json", { in: process.cwd(), limit: 10 });
console.log(res.hits.map(h => `${h.git ?? "-"} ${h.path}`).join("\n"));
const rules = s.loadIgnoreRules(process.cwd(), { includeDefaults: false });
console.log("rules:", rules);
console.log("match node_modules/...:", s.matchesIgnorePattern("node_modules/@types/node/package.json", rules));
c.close();
'
```

Observed output (abridged): hits include
`ignored /…/node_modules/@types/node/package.json`, `ignored /…/node_modules/typescript/package.json`;
`rules: ["node_modules/","dist/","*.log",".DS_Store",".coverage","*.tmp",".agency/"]`;
`match …: false`.

**Root cause hypothesis (not fixed):** `src/sanitize.ts::matchesIgnorePattern` checks
`normalized.endsWith(trimmed)` and `normalized.includes('/' + trimmed + '/')`. For a pattern
ending in `/` (`node_modules/`), the second test looks for `/node_modules//` and never matches;
the glob fallback does not normalize the trailing slash either. Patterns without a trailing
slash (`node_modules`) do match.

**Impact on the baseline:** `equivalence-golden.json` records both raw sets (tool-visible,
including ignored entries) and effective sets (ignored entries removed); token/latency
measurements are unaffected. Later waves must not silently change which metric they report.

---

## F2 — Negative-control self-contamination inside a measured scope

**Severity:** methodology. A negative control whose literal string is committed inside the
measured scope is self-defeating: the harness and its result JSON are themselves files in the
index, so the "absent" token is present.

**Observed:** in the first tokens run of wave 1, `t06` (`zzz_absent_token_9c3f`, repo scope)
returned **2 hits** — the two harness files that contained the literal. After the fix, `t06`
targets the generated fixture and uses a runtime-constructed token (split string), returning 0.

**Reproduction of the mechanism (generic):**

```bash
cd <worktree>
rg -l 'ULTRAMARKER_7' . --glob '!node_modules'
# -> bench/baseline/lib.mjs, bench/baseline/TOKENS.md, results JSONs …
```

Any grep for a literal that is committed somewhere in the scope matches those committed files,
so a "must be absent" control placed there is invalid regardless of product behavior.

**Guard (now in the protocol):** negative grep controls use the generated fixture
(`~/.cache/pi-ultrasearch-bench/fixture-5k`, outside the repo) or another clean scope, and their
literals are assembled at runtime so committed scripts do not contain the full token. Results
JSON still contains the token, which is another reason negative controls must not target the
repo scope once results are committed.

---

## F3 — `multiGrep` truncates the file set at its default limit

**Severity:** correctness of the multi-pattern tool. Files containing matches are dropped even
when the requested file limit is larger than the number of matching files.

**Observed (fixture scope, patterns `ULTRAMARKER_1232` | `ULTRAMARKER_7`):**

| Call | Files returned |
| --- | --- |
| `client.multiGrep([...])` (default `limit: 30`) | **16** |
| `client.multiGrep([...], {limit: 200})` | **19** |
| `client.grep("ULTRAMARKER_7")` (single pattern) | **18** |
| `rg -l -e ULTRAMARKER_1232 -e ULTRAMARKER_7` | **19** |

**Reproduction:**

```bash
cd <worktree>
PI_ULTRASEARCH_TEST=1 node --input-type=module -e '
const m = await import("./src/client.ts");
const FIX = process.env.HOME + "/.cache/pi-ultrasearch-bench/fixture-5k";
const c = new m.FSearchClient({ timeoutMs: 20000 });
const pats = ["ULTRAMARKER_1232", "ULTRAMARKER_7"];
console.log("default:", (await c.multiGrep(pats, { in: FIX })).files.length);
console.log("limit200:", (await c.multiGrep(pats, { in: FIX, limit: 200 })).files.length);
console.log("grep single:", (await c.grep("ULTRAMARKER_7", { in: FIX, limit: 200 })).files.length);
c.close();
'
```

Also visible in `equivalence-golden.json` query `m02`: `us=16`, `native=19`
(`native_only: dir_07/module_00784.ts, module_00791.ts, module_00798.ts`).

**Root cause hypothesis (not fixed):** the daemon's `multi_grep` applies `limit` while merging
matches/candidates, so the budget can be spent before all matching files are emitted;
`fsearch_multi_grep` in `index.ts` passes `limit: params.limit ?? 30`, so the tool inherits the
truncation. Whether the fix belongs in engine or client is a later wave's decision.

**Impact:** any wave claiming multi-grep parity must raise the limit for its measurements
(the frozen equivalence run uses `limit: 1000`) and must not use default-limit sets as a
correctness reference.

---

## F4 — Global locate has no usable native comparator on this machine

**Severity:** measurement limitation.

`latency.mjs` pairs global locate (`search("'package.json", {limit:50})`) against Spotlight
`mdfind -name`. On this machine `mdfind` returns **0** results for `package.json`, `README.md`
and `dmg.py` (Spotlight index unavailable/disabled), so the frozen `global__locate` row shows
US 50 hits vs native 0. This is a comparator failure, not evidence that locate is wrong.

**Reproduction:**

```bash
mdfind -name package.json | wc -l   # 0
mdfind -name README.md    | wc -l   # 0
```

**Consequence:** global-locate latency is retained as a self-relative measurement
(median 1.174 ms, CI [1.134, 1.230], n=30) and explicitly **not** compared to a native tool.
Later waves must not cite the 0-hit comparator as an equivalence result. A valid comparator
(e.g. `sudo /usr/libexec/locate.updatedb` + `locate`) is out of scope for this baseline.

---

## F5 — Four production audit rows were written by one unisolated probe

**Severity:** methodology / data hygiene. Report it rather than hide it; rows were left in
place, not deleted.

During wave 1, one ad-hoc diagnostic (`node --input-type=module -e` checking `multiGrep`
limits) omitted `PI_ULTRASEARCH_TEST=1`, so `recordAudit` wrote to the production
`~/.pi/agent/cache/pi-ultrasearch/audit.jsonl`. Rows appended (UTC):

```json
{"ts":"2026-10-14T20:28:48.433Z","tool":"fsearch_grep","query":"ULTRAMARKER_7","scope":"…/fixture-5k","ms":108.87,"source":"scan"}
{"ts":"2026-10-14T20:28:48.473Z","tool":"fsearch_grep","query":"ULTRAMARKER_7","scope":"…/fixture-5k","ms":38.67,"source":"scan"}
{"ts":"2026-10-14T20:28:48.523Z","tool":"fsearch_multi_grep","query":"ULTRAMARKER_1232 | ULTRAMARKER_7","scope":"…/fixture-5k","ms":48.49,"source":"index"}
{"ts":"2026-10-14T20:28:48.599Z","tool":"fsearch_multi_grep","query":"ULTRAMARKER_1232 | ULTRAMARKER_7","scope":"…/fixture-5k","ms":76,"source":"index"}
```

**Guard:** every script calls `ensureTestEnv()` before importing the client, the value is echoed
in every result's `meta`, and the protocol forbids ad-hoc client imports outside those scripts.
The zeroresult run additionally reports how many audit rows in its window were written by
others (0 in the frozen run).

---

## F6 — Judgment acceptance text and negative count disagree

**Severity:** spec inconsistency. `bench/judgments/wave1-judgments.json` contains **4** negative
queries (P8, G6, R3, M6) while its acceptance text says "false_positive_rate == 0.00 on the
**5** negative queries". `judgments.mjs` evaluates against the actual count (4) and records the
spec text in `aggregates.acceptance_source`; the discrepancy is flagged in
`aggregates.acceptance_gates` and in the protocol.

---

## F7 — Shared test audit log can be truncated by another process mid-wave

**Severity:** observability hazard for any wave that reads the shared test log.

**Observed:** `~/.pi/agent/cache/pi-ultrasearch/test_audit.jsonl` went from 38,234 bytes /
205 lines to 1,093 bytes / 4 synthetic `cli_bypass` rows while other waves were active
(mtime 2026-10-14T20:29:34Z). The truncation did not corrupt wave 1's completed measurements
(all offsets were read within single runs), but a truncation **during** an offset-based read
would.

**Guard:** `lib.readAuditSince` is only safe for the duration of one script run; the zeroresult
report records `other_writers_rows`; later waves should prefer the same per-run snapshot
pattern and treat any externally reset log as a failed measurement window.

**Recommendation (product-side, for `src/telemetry.ts`):** give each process its own test log
instead of one shared append-only file — e.g. `test_audit.<pid>.jsonl` or a path selected by
`PI_ULTRASEARCH_TEST_LOG` — so concurrent waves and concurrent scripts cannot truncate or
interleave each other's evidence window. The verifier only records this; it is not fixed here.

---

## F8 — The advisor worktree root contains the judgment file, which spoils every query

**Severity:** measurement validity. The judgment set declares its corpus as
`ultrasearch-repo@0a16e50` (33 files), but the worktree at
`/Users/batra/ultrasearch-waves/advisor` also contains `bench/judgments/wave1-judgments.json`
and `ADVISOR-WAVE1.md`. The judgment file quotes **every query string and every expected
path** in the set, so any search/grep for a judged term can return the key to the test itself.

**Observed (declared-root run, preserved as `results/judgments-worktree-root-diagnostic.json`):**

| Query | Effect of the spoiler file |
| --- | --- |
| G6 (negative literal) | returned exactly 1 file: `bench/judgments/wave1-judgments.json` → false positive |
| R2 (regex) | rank 1 = the judgment file (grade 0), pushing real hits down |
| M6/M1–M5 (semantic) | spoiler file and `ADVISOR-WAVE1.md` appear in result sets |

Aggregate effect: recall@10 0.645 → 0.674, nDCG@10 0.614 → 0.705, false-positive rate
0.75 → 0.50 once the spoiler is removed.

**Resolution (implemented):** `bench/baseline/make-corpus.mjs` extracts a clean checkout via
`git archive 0a16e50` into `~/.cache/pi-ultrasearch-bench/corpus-0a16e50`
(33 files, `tree_sha256` recorded) and `judgments.mjs` defaults to it. The scorer records
`meta.corpus.source` (`clean-archive` vs `declared-root`) and a `spoiler_note` when the
worktree root is used. Canonical result: `results/judgments-baseline.json` (clean archive).

**Reproduction:**

```bash
cd <worktree>
rg -l 'SUPERCALIFRAGILISTIC_TOKEN_ZZZ' /Users/batra/ultrasearch-waves/advisor
# -> bench/judgments/wave1-judgments.json   (the negative control's own text)
node bench/baseline/make-corpus.mjs
PI_ULTRASEARCH_TEST=1 node bench/baseline/judgments.mjs   # meta.corpus.source = clean-archive
```

---

## Environment observations (not findings, context)

- The daemon was restarted during wave 1: PID 786 → 13298, `entries` 3,873,786 → 3,919,708,
  `content_docs` 129,420 → 129,643. Every JSON records the daemon block it ran against.
- All frozen numbers were produced with the gate **failing** (battery 23–29% discharging,
  load 3.6–12, engine-wave `cargo build --release` active), so every JSON is marked
  `"status": "provisional"`. Re-run `bench/baseline/run-all.sh` on AC with load < 1.5 and no
  cargo/rustc to produce `"final"` numbers.

---

## Wave 1 final verification (wave1/verify-final, HEAD 3135e28) — current status

Re-measured independently by the final verifier on 2026-10-15. Evidence:
`bench/verification/after/checks-regressions.json`, `bench/verification/after/checks-gate-floor.json`,
`bench/verification/wave1-summary.json`. Method: the probe suite imports only the product
surface (`src/client.ts`, `src/sanitize.ts`, `src/validate.ts`) and the vendored
`engine/target/release/ultrasearch`; the production audit log is hash-checked before and after.

| Finding | Status under main | Evidence |
| --- | --- | --- |
| **F1** trailing-slash `.gitignore` (`node_modules/`) | **fixed** | `matchesIgnorePattern("node_modules/@types/node/package.json", ["node_modules/"])` → `true`; `dist/` and nested `packages/a/node_modules/x.js` also match; `src/client.ts` → `false`. Live path search in the repo returns no `git:ignored` rows. |
| **F2** negative-control self-contamination | **verified (held)** | Not re-created: the probe uses runtime-generated literals (`ULTRAMARKER_*` in the fixture, a runtime token for #23). |
| **F3** `multiGrep` default-limit truncation | **fixed** | Fixture (5 000 files, patterns `ULTRAMARKER_1232` \| `ULTRAMARKER_7`): default limit, `limit: 200`, single `grep` and `rg -l` all return **19** files. |
| **F4** global locate has no native comparator | **unchanged (limitation)** | `mdfind -name package.json` still returns 0 rows; the locate row stays self-relative. |
| **F5** production audit rows from an unisolated probe | **guarded, holds** | Production `audit.jsonl` is byte-identical (sha256 + mtime + line count) before and after the whole probe suite with `PI_ULTRASEARCH_TEST=1`. |
| **F6** judgment acceptance text says 5 negatives, file has 4 | **unchanged** | The scorer still records the spec text and evaluates the real count. |
| **F7** shared test audit log (single fixed path) | **open (recommendation)** | `src/telemetry.ts` still resolves one shared `test_audit.jsonl`; no per-process path or `PI_ULTRASEARCH_TEST_LOG`. No truncation occurred during this verification window (concurrent writers' rows from two clients are all present). |
| **F8** judgment corpus must be a clean archive | **verified (held)** | The clean archive is used (`tree_sha256 98e299a6…`); the corpus created under an isolated `$HOME` in this verification reproduced the same `tree_sha256`, and the judged numbers reproduce the frozen ones (recall@10 0.674, nDCG@10 0.705). |

Issue-level re-verification (the Wave 1 engine/security report's own claims):

| Issue | Claim | Status | Evidence |
| --- | --- | --- | --- |
| #36 | `(a+)+$` rejected before the socket | **verified** | With a provably dead socket (a valid pattern on the same client throws a connection error), the rejected pattern returns `ok:false` with `rejected regex pattern …` and no audit row exists for the literal. `(\w*)*` also rejected; `(a|aa)+` warns; `^export class` passes. |
| #23 | multi-line PEM redaction + line-wise body + DLP on paths | **verified** | Whole-block scrub removes the body; `SecretGuard.line()` redacts header/body/footer lines and closes after the footer; a `ghp_…` shaped filename is redacted; ordinary code, git SHAs, checksums and URLs are unchanged. |
| #19 | staleness fields | **verified** | `status` carries `last_event_id`, `event_lag`, `staleness_ms`, `replay_in_progress`; an answer carries `stale_ms` (0 when caught up, as documented). |
| #16 | `budget_ms` partial answers | **verified** | Engine, global search `budget_ms:1` → `complete:false, scanned=24610…40990, considered≈scanned`; global grep `budget_ms:1` → `complete:false` with `candidates`/`read`; ample budget (5 s) → `complete:true` over 3 879 988 scanned; ample ≡ none output-identical. A 1 ms budget over a small/fast scope is a race and is recorded as informational only. |
| #34 | compaction counters + pause | **verified** | `status` carries `compactions`, `last_compact_ms`, `last_compact_bytes`, `last_compact_entries`, `last_compact_secs_ago`, `compactions_postponed`, `queries_in_flight` (live: `compactions:3`). Pause semantics asserted by `test/engine/status.test.mjs` (26/26 engine tests pass). |
| #17 | coverage policy in status + configurable | **verified** | `status.content_policy` present beside `content_docs`/`content_pending` (`configured:false` by default); `test/engine/coverage.test.mjs` passes. |
| #22 | worktree isolation + frecency | **verified** | A scoped search returns 0 paths from the sibling worktree; `recent` returns frecency-ranked rows with `boost`; `test/engine/search.test.mjs` passes. |
| #45 | one daemon per index dir | **verified** | A second `ultrasearch serve` on the same `ULTRASEARCH_DIR` exits with "another … daemon is running"; the live socket has exactly one owner. |

Additional independent check — the `npm run test:gate` blocker:

| Claim | Status | Evidence |
| --- | --- | --- |
| "the live 5 ms grep gate measures the machine floor, not a client regression" | **verified** | Raw daemon socket (no client), same call as the gate: p50 **7.17 ms**, p95 **7.65 ms** (n=60); client leg p50 7.88 ms, p95 8.59 ms. The gate's 5 ms threshold is below the machine's own floor; `test:gate` is 3 pass / 1 fail on this machine and that failure is environmental. |

Findings **F1** and **F3** are now fixed; **F7** is still open as a recommendation; **F4**/ **F6**
are unchanged limitations. No Wave 1 claim failed verification.

---

## New defect found during final verification (Wave 1, reported not fixed)

**F9 — stray merge-conflict marker in `README.md`.** Line 309 carries
`>>>>>>> d50249a (feat(index): configurable content coverage, warm-up, and the policy in status (#17))`
as a literal line of the published README (the `<<<<<<<`/`=======` halves are gone, so it renders as
text in the Content coverage / Running-an-isolated-instance section). Cosmetic, user-facing, and
trivially greppable: `grep -n '^>>>>>>>' README.md`. No other conflict marker exists in the tree
(`grep -rn '^<<<<<<<|^=======$|^>>>>>>>' --include='*.md' --include='*.ts' --include='*.mjs' --include='*.rs' .`).

## 2026-10-15 — F10 correction (wave-2 advisor, verified by inspection)

- `bench/verification/after/judgments-baseline.json` was byte-identical to the baseline artifact (sha256 `ab4e4ac731fcc05f…`): the 12 `judgments.*` summary rows compared a value with itself and must not be read as verified. They are now `needs-re-run`.
- Live probe at `8d1419d`: catastrophic regex is rejected, so main negative FP is **0.25**, not the published 0.50. Treat 0.50 as stale.
- F9 (README conflict marker) is fixed in `8d1419d`.

## 2026-10-15 — F10 repaired (instrument + measurement), and the drift it was hiding

**Root cause (measured, not guessed).** The AFTER judgments scorer never completed in the wave-1 session:
the tool call that ran it hit a 1800 s timeout, the per-step copy then propagated the *committed golden*
(`bench/baseline/results/judgments-baseline.json`, the pristine `0a16e50` result) into
`bench/verification/after/`, and `summarize.mjs` — which had no provenance check between the two sides of a
row — marked the twelve `judgments.*` rows `verified`. Both sides were the old system; the after side was
not a measurement at all. Only the judgments lane was affected: latency/equivalence/tokens/zeroresult were
fresh runs (their artifacts carry distinct hashes, refs and timestamps).

**Instrument repair.** `bench/verification/checks/identity-guard.mjs` enforces, per measurement row:
**G1** any before/after sha256 equal · **G2** after artifact older than before · **G3** both sides recording
the same commit (two runs of one ref, the F10 shape even when the bytes differ) · **G4** a claimed artifact
missing → any violation forces `needs-re-run`. Every row now carries `evidence_hashes`; `summarize.mjs` runs
`assertNoVerifiedIdentical` before writing (generate-time tripwire). Regression test:
`node --test bench/verification/checks/identity-guard.test.mjs` — 8 cases including the exact F10 shape
(two byte-identical files → `needs-re-run`) and a control that must stay `verified`. Applied to the stale
artifacts the guard re-derives the advisor's manual correction **mechanically**: 37 verified / 1 failed /
13 unverified / 12 needs-re-run.

**Measurement repair (gated re-run).** `bench/verification/checks/rerun-wave1-judgments.sh` waits for its own
gate window, records the daemon block first (single socket owner is a precondition), runs the **frozen**
scorer unchanged, stamps provenance, refuses an artifact whose hash equals the golden's, and restores the
golden. Result at head `91e7832`:

| Field | Value |
| --- | --- |
| artifact | `bench/verification/after/judgments-baseline.json` |
| sha256 | `7ce35a4c0be18362…` (golden `ab4e4ac731fcc05f…`, before `64fee02691e2f4dd…` — all distinct) |
| daemon | pid 8887 · entries 3 919 543 · event_id 5705271483 · 1 socket owner, 1 serve process · FDA true |
| gate | **provisional** — no window in 30 min (external `rustc` build + Tinycast `FileIndexHelper` kept load1 ≥ 7) |
| golden after restore | `ab4e4ac731fcc05f…` (unchanged) |

The summary now carries `after_gate` per row and a documented rule: **timing** rows require a gate-clean
artifact; **quality** rows (judgments, equivalence, zero-result, wave-2 quality lanes) are set comparisons
whose gate is recorded and whose value is accepted when two distinct runs of the two refs agree — the
judgments aggregates are the load-invariance evidence (identical before at load1 1.43 and after at 7.83).
Counts after the repair: **50 verified / 1 failed / 13 unverified / 0 needs-re-run** (64 rows).

**FP correction (as the advisor predicted, now measured).** `false_positive_rate 0.50 → 0.25`.
R3 `(a+)+$` returns `[]` with `rejected regex pattern …` (client-side, pre-socket); P8 and G6 return `[]`;
M6 (semantic OR-expansion) still returns 10 files → 1 of 4 negatives. Any wave-1 text quoting 0.50 is stale.

**F11 — semantic-lane drift the F10 masking was hiding.** With a real after-artifact the frozen set no longer
reproduces exactly: recall@10 `0.6737 → 0.6686`, nDCG@10 `0.7050 → 0.7004`, semantic nDCG@10
`0.1936 → 0.1700`. Per-query cause, with evidence:

| Query | Before | After | What changed |
| --- | --- | --- | --- |
| M4 (`why does a whole disk search return partial results`) | ci.yml grade 3 at rank 6, n=21 | ci.yml absent from top 10, n=10 | nDCG 0.532 → 0.266 |
| M5 (`keep results inside the workspace even if a symlink points out of it`) | index.ts grade 3 absent (n=18) | index.ts grade 3 at rank 10 (n=10) | nDCG 0.104 → 0.252 |
| R3 (negative) | 2 files | 0 files | FP 0.50 → 0.25 |
| M1–M3, M6 | n = 24/21/17/16 | n = 10 each | returned set now honours the caller's `limit` |

Mechanism: the semantic lane fans out to per-pattern greps (`multi_grep` is not a daemon op in either ref)
and the client now **honours `limit`** — `finalize(...).files.slice(0, limit)` — where the old client returned
everything the fan-out found (16–24 files for a `limit: 10` call). `src/semantic.ts` is byte-identical between
the refs. Two expected answers changed rank order as a side effect. **Verdict impact: none** — every advisor
gate fails before and after (recall@10 1.0, nDCG@10 ≥ 0.75, FP 0, semantic ≥ 0.60, zero-result 0,
reformulation ≤ 0.20), and the semantic lane was already the failing lane. Recorded so a later wave does not
re-discover it as a regression.

## 2026-10-15 — Wave-2 relevance verification (rebased onto `ad2237d`; isolated daemons)

**System under test.** `origin/main` `ad2237d` (relevance `db25478` + platform `413a7f7`). The installed
daemon is still the wave-1 binary, so every measurement here runs the engine **built from this tree**
(`engine/target/release/ultrasearch`, sha256 `b161a63740102f7b…`) over the frozen corpora on its own socket and index dir
(`ULTRASEARCH_DIR`/`HOME`/`SCAN_ROOT` + `PI_ULTRASEARCH_SOCKET`); the live daemon was never touched or
reinstalled. Every arm is `gate=final` with a single socket owner.

**Wave-1 judgment set on the new engine** (frozen 30 queries, corpus-0a16e50, gate=final, artifact
`99b62ae2…`): recall@10 **0.674 → 0.783**, nDCG@10 **0.705 → 0.863**, semantic nDCG **0.194 → 0.831**,
FP **0.50 → 0.00**, zero-result **0.038 → 0.000**, MRR@10 **0.710 → 0.897**, success@10 **0.75 → 0.94**.
Advisor gates: **5/7 pass** (the 0a16e50 baseline passed 1/7); the two failures are
`recall@10 == 1.00` (0.783) and the per-lane reformulation bound for grep-literal (0.40) and grep-regex (0.50).

**FP correction chain (measured three times).** **0.50 → 0.25 → 0.00.** The published 0.50 was the stale
`0a16e50` golden; the `91e7832` client (R3 `(a+)+\$` rejected pre-socket) measured 0.25 (artifact
`7ce35a4c…`); the current tree measures **0.00**, all four negatives returning nothing (M6's OR-expansion
no longer returns junk files).

**Wave-2 claims — reproduced or refuted** (`after/wave2-claims.json` `97237e02…`, BCa 10k, seeded):

| Claim | Verdict | Observed |
| --- | --- | --- |
| semantic ΔnDCG **+0.606 [0.242, 0.781]** | **reproduced as the wave's total effect; refuted as an engine effect** | +0.6110 **[0.2488, 0.7878]** client-side; engine-only **−0.0019 [−0.0134, 0.0000]** |
| symbol zero-result **0.222 → 0.00** | reproduced | engine-only 0.2222 → 0.0000 |
| symbol recall@10 **0.778 → 1.00 (9/9)** | reproduced | engine-only 0.7778 → 1.0000, categorical 7/9 → 9/9 |
| FP **0 everywhere** | reproduced | every lane 0 (engine A/B 0→0) |
| every **Tier-L** floor | **NOT all pass** | ranking-signal `glob_set_completeness` 0.714 (RS02 expects 14 files, returns 10) |

Attribution matters: the semantic gain is **client-side** (the engine A/B moves the lane by −0.002), while
the symbol gain is **engine-side**. The published semantic number is honest as a wave total and must not be
cited as an engine achievement. Known confound: the pre-relevance arm ran before corpus hygiene
(`.corpus-meta.json` was still inside the wave-2 corpus root, 98 files vs 97).
