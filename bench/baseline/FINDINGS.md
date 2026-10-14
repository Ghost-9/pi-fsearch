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
