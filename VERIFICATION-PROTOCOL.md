# Verification protocol — pi-ultrasearch (wave1/baseline)

Owner: **wave1/baseline (verifier)**. Binds every later wave. A claim that does not pass
this protocol fails verification regardless of how it was produced.

> **Independence rule (non-negotiable).** The verifier never uses author-provided numbers,
> author-provided scripts, or author-selected scopes to certify a claim. Every number that
> ends up in a verdict is re-measured on this machine by a verifier-owned script, and the raw
> JSON is committed. If a wave reports "X ms" or "Y% fewer tokens", that is a hypothesis to be
> re-tested, not evidence.

---

## 1. Frozen artifacts (this branch)

| Artifact | Path | Content |
| --- | --- | --- |
| Latency baseline | `bench/baseline/results/latency-<date>.json` | per-run raw samples, median/p50/p95, seeded bootstrap 95% CI of the median, native comparator pairing |
| Equivalence golden | `bench/baseline/results/equivalence-golden.json` | 30 fixed queries, US + native result sets, per-query diffs, tolerance rules |
| Token baseline | `bench/baseline/results/tokens-baseline.json`, `bench/baseline/TOKENS.md` | 10 fixed tasks, tool-text chars, token estimate, estimator limits |
| Zero-result / fallback | `bench/baseline/results/zeroresult-baseline.json` | absent/present zero-hit rates, audit-derived fallback counts |
| Judgment scoring | `bench/baseline/results/judgments-baseline.json` (+ `judgments-input.json`) | recall@k / MRR@10 / nDCG@10 / zero-result / FP / reformulation per judgment query |
| Environment + status | inside every JSON (`meta.environment`, `meta.status`) | gate checks, daemon pid/index_bytes, power, load |
| Harness | `bench/baseline/*.mjs`, `run-all.sh`, `gate-check.mjs` | verifier-owned; no repo harness is imported |
| Findings | `bench/baseline/FINDINGS.md` | F1–F5 with reproductions; do not fix silently |

`meta.status` is `"final"` only when the pre-run gate passed and the environment did not
degrade during the run. Otherwise it is `"provisional"` and the numbers may **not** be cited
as production evidence.

---

## 2. Environment gate (advisor directive, mandatory)

A measurement is only valid when the machine is measurement-idle. `bench/baseline/gate-check.mjs`
checks, in this order:

1. **AC power** — `pmset -g batt` must say `'AC Power'`. Discharging battery invalidates.
2. **1-minute load < 1.5** — `os.loadavg()[0] < 1.5`.
3. **No competing rustc/cargo** — no process whose executable basename is `cargo` or `rustc`
   (`ps -Ao pid=,comm=`, robust to multi-line command lines).

The environment block additionally records the **daemon PID and index state**
(`entries`, `content_docs`, `content_pending`, `index_bytes`) because the daemon is shared and
can be restarted by another wave mid-session (observed: PID 786 → 13298 during wave 1).

Procedure:

```bash
node bench/baseline/gate-check.mjs          # exit 0 = pass, print JSON either way
GATE_WAIT_SECONDS=1800 bash bench/baseline/run-all.sh   # poll 60 s, then run
```

- **Gate fails →** scripts still write results, but every JSON gets `"status": "provisional"`
  and the full environment block. Do not delete provisional runs: they are the evidence trail.
- **Gate passes →** re-run the whole suite so every file shares one valid environment. Only
  then may a file be called `"final"`.
- If the gate degrades *during* a run (power unplugged, cargo starts), the end-of-run check
  downgrades the file to `"provisional"`. Load at end-of-run is recorded but not gated: the
  benchmark's own subprocesses contribute to it.
- The verifier must not accept an author run performed without a passing gate, even if the
  author's numbers "look right".

---

## 3. Reproduction

Full suite (latency n=30, all datasets):

```bash
cd <worktree-with-this-branch>
PI_ULTRASEARCH_TEST=1 bash bench/baseline/run-all.sh
```

Individual suites:

```bash
PI_ULTRASEARCH_TEST=1 node bench/baseline/latency.mjs      # BENCH_N=30 default; PILOT_N=3 for smoke
PI_ULTRASEARCH_TEST=1 node bench/baseline/equivalence.mjs
PI_ULTRASEARCH_TEST=1 node bench/baseline/tokens.mjs
PI_ULTRASEARCH_TEST=1 node bench/baseline/zeroresult.mjs  # ZERO_REPS=5 default
node bench/baseline/make-corpus.mjs                       # clean 0a16e50 corpus for judgments
PI_ULTRASEARCH_TEST=1 node bench/baseline/judgments.mjs   # JUDGMENTS_PATH / JUDGMENTS_ROOT override
```

`PI_ULTRASEARCH_TEST=1` is **mandatory in every process**; it redirects the audit log to
`~/.pi/agent/cache/pi-ultrasearch/test_audit.jsonl`. Never run an ad-hoc `node -e` client
import without it — doing so writes to the production audit log (this happened once in wave 1;
see F5 in `FINDINGS.md`).

Fixture: `make-fixture.mjs` regenerates `~/.cache/pi-ultrasearch-bench/fixture-5k`
(5005 deterministic files, outside the repo, idempotent; `--force` to rebuild).
The judgment corpus is frozen at `/Users/batra/ultrasearch-waves/advisor`
(`ultrasearch-repo@0a16e50`, 33 files); the scorer records the corpus commit and dirty flag.

**Compatibility (945faba, UltraSearch rename):** the harness now imports `UltraSearchClient`
and labels calls with `ultrasearch_*` tool names. Query sets, scopes, statistics and golden
files were intentionally **not** changed: entries such as `FSearchClient` remain because they
are frozen measures of the `0a16e50` corpus, and the K4 detector still matches
`class FSearchClient` in the clean-archive corpus. A wave must decide whether it is measuring
the old or the new corpus before re-running the suite.

---

## 4. Latency verification

Method frozen in `latency.mjs`:

- Scopes: this worktree (`repo`), fixture `5k`, `/Users/batra/Search`.
- Ops: path search, trigram grep, multi-grep, locate (global), recent, ping; plus a
  supplementary CLI end-to-end measurement.
- **Alternating A/B**: one UltraSearch call, then one native call, repeated n≥30 per pair.
- Native comparators: `rg --files -g` for git scopes, `find -name` for non-git scopes,
  `rg -l` for grep, `rg -l -e` for multi-grep, `mdfind -name` for global locate.
- Statistics: median, p50, p95, min/max, **seeded percentile-bootstrap 95% CI of the median**
  (10 000 resamples). `p50 == median` by construction. p95 has no CI (unstable at n=30).

How a later wave proves a latency claim:

1. Re-run `latency.mjs` on its own branch, same scopes, same n, same gate.
2. Compare **paired** samples against the frozen baseline using the same bootstrap routine:
   for each A/B pair compute the per-pair difference (candidate − baseline) and report the
   median paired difference with its 95% CI.
3. A claim passes only if the CI **excludes 0** and the point delta exceeds the noise floor
   observed in the frozen baseline (baseline CI width is the reference).
4. Report both absolute medians and the ratio-of-medians; never report a mean-only speedup,
   a single run, or a best-case p50.
5. Unpaired or differently-scoped comparisons (e.g. smaller n, warmup omitted, different
   query set) are rejected as evidence.

Known noise sources (recorded per run): shared resident daemon under other waves' load,
page cache, FSEvents compaction, and the daemon being restarted mid-session.

---

## 5. Equivalence verification

`equivalence.mjs` holds a **fixed 30-query set** (path, grep, multi-grep, locate; 3 negatives).
Each query stores the US set and the native (`rg`/`find`) set, relative to the scope, plus
`us_only` / `native_only` and recall/precision/Jaccard.

Rules for later waves:

1. Re-run the script and diff every query's `us_set` against the golden JSON.
2. An item that was present in the frozen US set and disappears is a **regression** unless it
   falls under the documented tolerance list below; each removal needs a written justification
   in the wave report (file changed by the wave, deleted file, intentional scope change).
3. Aggregate recall must stay within **−2 pp** (path lane) / **−5 pp** (grep lane) of the frozen
   number; otherwise verification fails even if nothing changed in the diff lists.
4. Negative queries must stay at 0 US results.
5. `limit` truncation must be excluded: the frozen run uses `limit = 1000` for this reason
   (an earlier run with `limit = 200` showed a fake 0.518 recall on a 386-hit query).
6. `.gitignore` semantics: the US client currently returns entries tagged `git:"ignored"`
   (finding F1). Metrics are therefore computed twice — raw (tool-visible) and effective
   (ignored entries removed). Both are frozen; a wave must not "fix" the metric by silently
   changing which one is reported.

Tolerance list (documented, not open-ended): index freshness/staleness windows, declared
`.gitignore`/`.ignore` handling, native tools' binary-file skipping, and symlink policy.
Anything else is a regression.

---

## 6. Token-output verification

`tokens.mjs` freezes 10 tasks (path/grep/multi-grep/locate/recent, hits and zero-hits) and the
exact tool text derived from `index.ts` + `formatter.ts`, stored as
`tool_text_chars`, `estimated_tokens = ceil(chars/4)`, and the formatter's own `tokenCount`.

- Estimator limits are documented in `TOKENS.md`: ±20% typical error; only same-estimator deltas
  are comparable; timing strings add <15 chars of run-to-run noise.
- A token-reduction claim requires: same task set, re-measured by the verifier, raw JSON
  committed, and a per-task delta. Aggregate-only claims are rejected.
- Any char delta within ±15 chars of the frozen per-task value is noise.

---

## 7. Zero-result and fallback verification

`zeroresult.mjs` queries deliberately absent and present targets (`ZERO_REPS=5` each),
records zero-hit rates, and reads **only** the rows this process appended to the isolated test
audit log (line-offset snapshot + query/scope match). It must also confirm the production
audit log was not written (see F5 for the counter-example).

- Absent targets: zero-hit rate must remain 1.0. Present targets: miss rate must be 0.0.
- Fallback occurrences are counted by `source: "native_fallback"` rows. The frozen baseline
  has 0 fallbacks; any wave that introduces fallbacks (or daemon downtime) must report the
  rows and the reason.
- `index` vs `scan` source split is recorded: content outside the daemon corpus is served by
  an on-demand scan (`scan`), which is legitimate but slower.

Extending the negative set: negative **grep** tokens must not be committed as literals inside
the measured scope, and must not target a scope containing the harness or its results
(self-contamination, finding F2). Prefer the generated fixture for negative grep queries.

---

## 8. Judgment-set scoring

`judgments.mjs` scores `bench/judgments/wave1-judgments.json` (30 queries, 4 negatives,
graded 3/2/1). It stores the exact input file plus its sha256, so a moved judgment set is
visible. Metric definitions (frozen here so they cannot drift):

- relevance: judged grade 3/2/1; unjudged = 0; success = grade ≥ 2.
- `recall@k` = |expected grade≥1 in top-k| / |expected grade≥1|; `success_recall@10` uses ≥2.
- `MRR@10` = 1/rank of the first grade≥2 result (rel1 variant also recorded).
- `nDCG@10` = DCG / IDCG with gain `2^grade − 1`, discount `1/log2(rank+1)`; IDCG over all
  expected grades. The linear-gain variant is recorded for transparency.
- `zero_result_rate` on must-hit queries; `false_positive_rate` on negatives.
- `reformulation_signal` = share of must-hit queries whose top-1 grade < 2.

Procedure notes:

- K1 (`ranking-frecency`) requires an `{op:"open"}` of `README.md` ≥30 s before measurement;
  the scorer performs it and records the result. Treat K1 as a stateful probe: re-check the
  precondition if the daemon was restarted.
- K3 (`ranking-boost-ab`) runs `boost:true` and `boost:false` and records the paired nDCG
  delta; only that delta is admissible evidence for the boost claim.
- K4 is scored as **line order inside `src/client.ts`**, not file order; the scorer records the
  first three matches and whether the first is the class declaration.
- R3 (`(a+)+$`) is an acceptance probe, not a latency result: the scorer records `error_class`
  and whether an audit row appeared (i.e., whether the request reached the socket/recorder).
  A wave fixing issue #36 must show an actionable client-side error and no audit row.
- Semantic lanes must go through `src/semantic.ts::searchSemanticIntent` (as `index.ts` does);
  calling `grep(mode:"semantic")` directly is not the shipped path.
- Acceptance gates from the judgment file (recall@10 == 1.00, zero-result 0.00, FP 0.00,
  nDCG@10 ≥ 0.75 overall and ≥ 0.60 semantic, reformulation ≤ 0.20 overall and ≤ 0.35 per lane)
  are evaluated in `aggregates.acceptance_gates` with observed values. Note: the acceptance text
  says "5 negative queries" while the set contains 4; the scorer uses the actual count and
  records the discrepancy.

Corpus: the scorer defaults to a **clean `git archive` of commit `0a16e50`** prepared by
`bench/baseline/make-corpus.mjs` into `~/.cache/pi-ultrasearch-bench/corpus-0a16e50`
(33 files, `tree_sha256` recorded in `meta.corpus.clean_archive`). Do **not** score against the
advisor worktree root: it contains `bench/judgments/wave1-judgments.json`, which quotes every
query and spoils retrieval and ranking (finding F8). If `meta.corpus.source != "clean-archive"`,
the run carries a `spoiler_note` and its numbers are not admissible. Re-run
`make-corpus.mjs` whenever `tree_sha256` or the declared file count changes.

Corpus instability: if the corpus file count differs from the declared 33, the run is marked
`files_match_declared: false`; a wave must re-run once the corpus matches the frozen
`tree_sha256`.

---

## 9. Claim-vs-evidence checklist

A claim **fails verification** if any of the following is true:

- [ ] The claim is backed only by author-provided numbers without a verifier re-measurement.
- [ ] No reproducer script is committed on the wave branch, or the script does not run from a
      clean checkout of that branch.
- [ ] No median (or mean) **with a CI** is reported; mean-only or best-case-only numbers.
- [ ] n < 30 for a latency claim, or no alternating A/B against the native comparator.
- [ ] Raw JSON is missing, uncommitted, or its `meta.status` is `"provisional"` while the claim
      is presented as final.
- [ ] The environment gate failed and the claim ignores it (no AC / load ≥ 1.5 / cargo build).
- [ ] Equivalence diffs are unreported: changed/deleted entries unexplained, or aggregate recall
      outside the tolerance in §5.
- [ ] Token claims mix estimators, task sets, or compare against a different tokenizer.
- [ ] Negative controls regress (absent query returns hits, present query returns none).
- [ ] Judgment gates fail and the failure is omitted.
- [ ] The verification run wrote to the production audit log.

Every accepted claim names: script, branch, commit, environment status, n, median + CI,
raw JSON path, and the equivalence diff (if retrieval changed).

---

## 10. Known limitations

1. The daemon is shared across wave worktrees and was restarted mid-wave (PID 786 → 13298,
   index 3.87 M → 3.92 M entries). Latency and coverage numbers are only comparable when the
   recorded daemon/index block matches.
2. The test audit log is also shared and was externally truncated once during wave 1
   (38 KB/205 lines → 1 KB/4 synthetic rows). Offset isolation works only if no truncation
   happens mid-run; the zeroresult report records "rows by other writers" for this reason.
3. The fixture lives outside the repo and is regenerated deterministically; it is not committed.
4. Equivalence goldens include files that the benchmark itself writes (results JSON inside the
   repo). Grep sets therefore contain benchmark artifacts; the protocol scores set membership,
   not provenance.
5. p95 CIs are not meaningful at n=30; only medians carry CIs.
6. Battery power invalidates all numbers (gate §2). Wall-clock speedups are not claimed.
7. macOS-only tooling (`pmset`, `mdfind`, `find`, `rg`) — the protocol is not portable as-is.

---

## 11. Finding register (details in FINDINGS.md)

| ID | Summary | Status |
| --- | --- | --- |
| F1 | `.gitignore` directory patterns with trailing slash are not honored client-side (`node_modules/`); ignored files leak into path results | open, not fixed |
| F2 | Negative grep tokens self-contaminate when the literal is committed inside the measured scope (script/results text) | methodology guard added |
| F3 | `multiGrep` silently truncates the file set at the default limit (16 files returned vs 19 matching) | open, not fixed |
| F4 | Spotlight `mdfind` returns 0 for every probe (index unavailable) — global locate has no valid native comparator | recorded |
| F5 | One ad-hoc probe without `PI_ULTRASEARCH_TEST=1` wrote 4 rows to the production audit log | recorded, not removed |
| F6 | Judgment acceptance text says "5 negative queries"; the set has 4 | recorded |
| F7 | Shared test audit log was externally truncated mid-wave (205 → 4 rows) | offset-isolation runs only |
| F8 | Judgment file lives inside the advisor worktree corpus and quotes every query (G6 FP, R2 rank-1 spoiler) | clean-archive corpus implemented |

---

## 12. Change log

| Date | Change | Author |
| --- | --- | --- |
| 2026-10-14 | Initial protocol, frozen baseline at `0a16e50`, gate added per advisor directive | wave1/baseline (verifier) |
| 2026-10-14 | Clean-archive judgment corpus mandatory (F8); judgment scoring added | wave1/baseline (verifier) |
| 2026-10-15 | Rebased onto `945faba` (UltraSearch rename): client class + tool labels updated, measurement logic and goldens untouched; smoke-verified against the migrated daemon | wave1/baseline (verifier) |
