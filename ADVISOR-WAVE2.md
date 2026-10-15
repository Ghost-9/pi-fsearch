# ADVISOR — Wave 2 (`pi-ultrasearch`)

Author: **wave2/advisor2**. No source edits. Verdict default: **NEEDS WORK** — nothing in this
document certifies a Wave 2 improvement; it defines what would have to be measured for one to exist.

## 0. What is certified, and what is not

| Claim | Status |
|---|---|
| Wave-1 numbers as such | Certified by wave1/verify-final **except** the judgment rows (see F10). |
| The published "FP 0.50 after" for main | **Not certified.** The after-artifact is a byte-identical copy of the baseline artifact; main's real FP is 0.25 (R3 fixed by #36, measured live) and has never been scored. |
| This document's baseline table | **Advisor observation, single pass, no gate** (`wave2-probes.json`). Not a measurement. |
| Wave-1 verdict `49 verified / 1 failed / 13 unverified` | **Corrected to 37 verified / 1 failed / 13 unverified / 12 needs-re-run** (F10: the eleven `judgments.*` rows plus `judgments.acceptance_gates` were all marked verified). |

## 1. Deliverables and reproduction

| Artifact | Content |
|---|---|
| `bench/judgments/wave2-judgments.json` | 38 queries — symbol-ast 12 (9 must-hit, 3 negatives), semantic-paraphrase 12 (10/2), ranking-signal 10 (9/1), control 4. Graded 3/2/1/0, `symbol_assertions`, `not_expected`, `known_fail`, feature gates. |
| `bench/judgments/wave2-bars.json` | Machine-readable per-lane Tier-L/Tier-C/Tier-S bars, latency budgets, forbidden claims. |
| `bench/judgments/wave2-probes.json` | Advisor probe: observed file sets/order per query, R3/S3/M6 live probes, F10 artifact audit. |

Corpus `ultrasearch-repo@8d1419d` — 97 files, 1 390 437 bytes, `tree_sha256`
`c9c2e4ac15e88df9c5c0e241b0dd1c0281abce57155be58bc94120218f7f9665`.

```bash
git -C <repo> archive 8d1419d --format=tar -- . \
  ':(exclude)bench/**' ':(exclude)ADVISOR-WAVE1.md' ':(exclude)VERIFICATION-PROTOCOL.md' \
  | tar -x -C $HOME/.cache/pi-ultrasearch-bench/corpus-8d1419d-clean
```

Excluded because they quote judged queries and expected paths (F8); product docs are kept as the
realistic distractor class. The wave-1 set stays frozen on `0a16e50`: this is a new corpus and a new
query set, never an edit of the frozen one. Two corpus defects are inherited: `.corpus-meta.json` is
written **inside** the root and is returned by semantic queries (F11); there is no `.git`, so
git/boost signals are structurally unmeasurable (F12).

## 2. Baseline pre-registration (advisor probe — provisional)

| Lane | n | recall@10 | success@3 | MRR@10 | nDCG@10 | zero-result | FP | p50 / max ms |
|---|---|---|---|---|---|---|---|---|
| symbol-ast | 12 (9m/3n) | 0.778 | 0.778 | 0.778 | 0.778 | **0.222** | 0.00 | 1.37 / 11.63 |
| semantic-paraphrase | 12 (10m/2n) | 0.175 | 0.100 | 0.050 | **0.064** | 0.00 | **1.00** | 7.34 / 7.89 |
| ranking-signal | 6 of 10 (5m/1n; 4 feature-gated) | 0.800 | 0.800 | 0.800 | 0.723 | 0.200 | 0.00 | 1.13 / 8.42 |
| control | 4 | 1.000 | 1.000 | 1.000 | 1.000 | 0.00 | — | 1.41 / 2.28 |
| **global** | **28 must-hit / 6 negatives** | — | — | — | — | **0.107** | **0.333** | — |

Unmeasured by the probe: RS05 frecency (stateful), RS07 git filter, RS08 #42 tags (feature absent),
and RS06 boost, whose two arms returned **identical** output on the archive corpus — a tie, i.e. a
degenerate test, not evidence that boost is neutral.

## 3. Per-lane acceptance bars (full form in `wave2-bars.json`)

**Tier-L (blocking to merge).** `zero-result = 0.00` on declared-answerable must-hit queries;
`FP = 0.00` on negatives; recall@10 not below the probe; control lane perfect. Feature-gated rows are
reported, never scored. **Tier-C (required to say "improved").** Paired per-query delta, BCa CI (10k)
excluding 0, point ΔnDCG@10 ≥ +0.05, no lane regressing > 0.02 — the wave-1 rule, reused.

| Lane | Tier-L floor | Tier-C target | Latency budget (97-file corpus) | Why these numbers |
|---|---|---|---|---|
| symbol-ast | zero-result 0.00, FP 0.00, recall@10 ≥ 0.78 | recall@10 1.00, rank-1 for every declaration, nDCG ≥ 0.95, mock-string not returned | p50 ≤ 5 ms, p95 ≤ 25 ms | The zero-result floor **is** the #26 acceptance: SY03 (`public`) and SY04 (`private`) are real declarations returning 0 files. Tier-C adds the AST discriminators (SY01 mock string, SY07 intra-file order, Rust/Python-style span checks). |
| semantic-paraphrase | zero-result 0.00, FP 0.00, recall@10 ≥ 0.10, top-3 doc share ≤ 0.67 | mapped success@3 ≥ 0.60, paraphrase success@3 ≥ 0.40, nDCG ≥ 0.50, MRR ≥ 0.55 (stretch 0.70) | p50 ≤ 25 ms, p95 ≤ 75 ms | 10 confident wrong files (SE11/SE12 measured) is worse than a miss: Tier-L forces an abstention or an explicit low-confidence signal. Tier-C is sized from mechanism, not hope — the answers are lexically reachable (`sanitize`↔masked, `ignoreCache`/`IGNORE_TTL_MS`↔ttl+ignore, `mock-daemon.ts`↔mock+daemon), so filename/identifier weighting + stopwords + ≥2-term co-occurrence suffices without a model. |
| ranking-signal | exact recall 1.00; glob completeness = 1.00 at its own limit; FP 0.00; near pair differs and same-folder peer rank 1 | frecency Δrank ≥ 1 with CI; boost ΔnDCG ≥ +0.05 with CI (else default off); near does not demote the file named; reason tags consistent with order | p50 ≤ 3 ms, p95 ≤ 15 ms | Each signal gets a discriminating pair. RS02 is scored as `recall@limit`, not recall@10 — with 14 expected files recall@10 is capped at 0.714 by definition (a bar of 1.00 would be impossible: the kind of trap Tier-C exists to avoid). |
| control | recall@10 1.00, zero-result 0.00, nDCG ≥ 0.90 | 1.00 | p50 ≤ 5 ms, p95 ≤ 20 ms | Four retrieval primitives every other lane depends on. One miss is a blocker regardless of lane scores. |

Latency is deliberately **corpus-relative**. A 97-file corpus cannot price an AST parse, an index or a
whole-disk scan; any latency claim outside it must be a paired comparison against the wave-1 rows
(fixture-5k / repo / `/Users/batra/Search`) with medians and CIs.

## 4. Findings (mine; none fixed here)

- **F10 — the AFTER judgment artifact does not exist.** `bench/verification/after/judgments-baseline.json`
  is byte-identical to `bench/baseline/results/judgments-baseline.json` (sha256 `ab4e4ac7…`), with
  `meta.status:"provisional"`, `branch:"wave1/baseline"`, `generated_at` from 2026-10-14. The other
  three after-artifacts are genuine runs at `3135e28`. `summarize.mjs:119-164` compares the two files,
  so `judgments.*` and `judgments.acceptance_gates` in `wave1-summary.json` report a delta of 0 between
  a number and itself, yet carry `status:"verified"`. Live probe at `8d1419d`: R3 now returns
  `ok:false` with no files, so main's negative FP is **0.25, not 0.50** — and the stale figure is the
  one quoted in the Wave-2 relevance brief.
- **F11 — the corpus contains a harness file.** `make-corpus.mjs` writes `.corpus-meta.json` inside the
  root; it is indexed, returned (SE01 rank 1) and was returned in wave-1's M6 row. Corpus hygiene, not
  product behaviour.
- **F12 — boost/git are unmeasurable on the archive corpus.** No `.git`, uniform mtimes: RS06's arms
  returned identical output. Either `git init` + a deterministic commit is added to the corpus, or every
  boost/git claim is labelled unmeasurable.
- **F13 — `mode:"symbol"` is a declaration filter, not a ranker.** Measured: literal
  `UltraSearchClient` → 20 files; symbol → 2, the second being a declaration-shaped line **inside a
  mock string literal**. File-level "definitions first" is therefore not what symbol mode does, and the
  client's `prioritizeSymbols` only reorders lines within one file.
- **Product defects the lane pins down:** (a) `near` counts the file itself as −20
  (`engine/src/server.rs:837-846`), so naming a file demotes it — measured last in both RS03/RS04;
  (b) `enforceExactQuery` makes every word an exact conjunct, so `format grep files` returns **0**
  results; (c) semantic mode currently answers "absent subject" questions with 10 files.

## 5. Plan critique — the three running children

Briefs read from the child threads (`wave2-relevance-1`, `wave2-interop-1`, `wave2-platform-1`); no
child had committed at review time, so this critiques the briefed scope, not code.

### relevance (`#26`, `#42`, semantic, FP/zero-result, ranking signals)
- **Risk 1 — the brief hands over a stale baseline.** "before and after Wave 1, identical … FP 0.50" is
  F10. A real re-run puts the starting FP at 0.25 (R3 fixed in Wave 1); reporting "FP 0.50 → 0.10"
  would claim Wave-1 work as Wave-2. **Required:** re-measure the baseline on their branch before
  touching code, and keep R3's delta in a separate row.
- **Risk 2 — the third reranker.** The brief demands "real definitions-first ranking **at file level**"
  while forbidding `engine/` edits. The client sees only post-`top_k` rows; a client-side AST pass can
  tag and reorder what survived, not promote a dropped declaration. If #26 is implemented client-side
  with overscan, that is a third ranking layer over the engine's score. **Required:** the engine request
  path (`patches/wave2-ranking-engine.patch` + `docs/wave2/engine-ranking-request.md`) must be the
  primary route, with the client change limited to rendering (see §6).
- **Risk 3 — tree-sitter is a large cost for a small measured gap.** Two of the three #26 acceptance
  symptoms are fixed by extending the declaration regex (access modifiers) and by not matching string
  literals. The AST must earn its keep: SY01 `not_expected`, all five languages, and the file-level
  ordering claim. If only the regex moves, say so and drop the dependency.
- **Risk 4 — semantic tuning to the test.** "Replace/extend the keyword map so semantic nDCG reaches
  0.60" invites fitting `SE01–SE10` strings. Require the mapped/paraphrase split, SE11/SE12 FP, and a
  generated held-out set for final acceptance.
- **Missing acceptance evidence:** per-language declaration coverage; incremental parse budget
  (ms/file, bytes/symbol); no-regression on the wave-1 fixture/repo grep rows; proof that no client
  path sorts daemon rows; #42 tag/order consistency (tags alone are a cosmetic artifact).
- **Drop first if short:** Go/Swift grammars (no corpus coverage — keep the fallback), #42 tags before
  the ranking change itself.

### interop (`#27`, `#28`, `#29`, `#30`, `#40`, `#41`)
- **Risk 1 — breadth over depth, and none of it moves a relevance gate.** Six features; only #28
  (dedupe) and #30 (alias default) touch anything an agent can feel. Time-box hard.
- **Risk 2 — #41's "edit→grep latency before/after" is artifact-shaped.** Prefetch warms the *second*
  call, so an unpaired before/after will always "win". Require alternating A/B with the same edit
  sequence, a control that does not prefetch, failure accounting (a fast error is not a fast search),
  and the daemon block. Overlaps the relevance child's `tool_execution_end` frecency hook — direct
  code conflict on the same hook.
- **Risk 3 — #30's "tool count defaults to 6" is a removal.** Do not present it as a token saving: the
  token estimator is ±20% and unvalidated · measure chars, or say nothing.
- **Risk 4 — #27 watch acceptance "~100 ms" needs a clock, not a vibe.** One file write is a single
  observation; require N writes, alternating with a no-write control, and socket-leak checks after exit.
- **Conflicts:** `src/mcp.ts` (interop) and `index.ts` tool params + #42 result text (relevance) overlap;
  `bin/cli.ts`/`src/tui.ts` (interop) and frecency/prefetch hooks (relevance) overlap.
- **Drop first:** #40 history+suggestions, then #41 prefetch, then #27 watch. Keep #30 and #29 (drift
  test), because they are small, testable and irreversible in the docs if left undone.

### platform (`#35`, `#45`, `#18`, `#32`, `#33`, gate re-scope, F7, `#39`)
- **Risk 1 — the largest cross-child hazard is theirs and it is invisible to them.** Installing or
  rebuilding the live daemon (`docs/engine-rebrand.md`) changes `index_bytes`/`event_id` under every
  sibling measurement; wave 1 lost a window this way (two daemons; grep p50 3.3 → 128 ms). **Required:**
  freeze the daemon during measurement windows, and record the daemon block in every artifact.
- **Risk 2 — F7 must land first, not last.** While three children run tests and benchmarks, the shared
  test audit log can be truncated mid-window (wave-1 F7). Per-process logs are the prerequisite for any
  FP/zero-result evidence.
- **Risk 3 — gate re-scope is where a threshold gets tuned to a green CI.** Lowering the live grep gate
  is legitimate **only** if the new threshold is derived from a measured machine floor with a stated
  margin (wave 1: raw daemon p50 7.17 / p95 7.65, n=60) and the hermetic mock gate stays strict. A
  "skip when cold" rule that can skip every failing window is an unfalsifiable gate.
- **Risk 4 — #18 batch ≈ max(t) is artifact-prone.** Require per-query output equivalence, an error
  count, and a control at lanes:1 vs lanes:3; otherwise a serialized-but-broken batch reads as a win.
- **Risk 5 — #33 SLAs written from provisional numbers.** The wave-1 AFTER latency/judgment JSONs are
  `provisional` (load 4.9+). An SLA document citing them would enshrine unquotable numbers; source every
  threshold from gated artifacts or mark it unmeasured.
- **Missing evidence:** Linux CI that runs only skipped integration tests proves nothing about the
  daemon · require the hermetic mock-daemon gate plus `cargo test` on Linux. #35 needs top-k
  equivalence at multiple budgets, not just "p95 improved".
- **Drop first:** #32 Linux packaging (cannot be validated here), then #18 concurrency. Keep #39
  (decision log, permanent value), #45 client guard, F7, and #35's equivalence tests.

## 6. Engine vs client — ranking ownership

Facts measured or read: `mode:"symbol"` filters declarations engine-side (20 → 2 files);
`prioritizeSymbols` sorts matches **within a file** (`src/formatter.ts:33-70`); `near` is forwarded to
the engine and the client re-ranks only native-fallback rows (`src/client.ts:663-668`); `nearness` is
one engine formula (+12 / −3 / −20, `server.rs:837`); `boost` is engine-side and no longer forced by
the client; `enforceExactQuery`/`extractExactWords` are client-side **filters** that change the
candidate set after the engine returned it.

**Recommendation.** Anything that decides which entries survive `top_k` belongs in the engine, because
the client cannot promote what it never received. Therefore:

1. **Tree-sitter symbol ranking: engine-owned.** Index-time symbol spans + a `def` score component +
   `mode:"symbol"` served from the index. The client keeps the regex fallback and rendering only; no
   client sort on daemon rows. Evidence to accept: symbol lane before/after + equivalence (no lost
   declarations) + no grep-p95 regression.
2. **Proximity: one formula, engine-owned, sign fixed.** The current self-penalty contradicts the
   primary use case ("rank the file I am editing first") and is measured: the named file ranks last.
   Client `+100` stays fallback-only. Evidence: RS03/RS04 paired ranks, near file rank 1.
3. **No third reranker:** (i) move the exact-word conjunct into the engine as an explicit `all`/`any`
   operator (RS09 = 0 today); (ii) return one score vector + reason tags (`{match, near, boost, def}`)
   so #42 is rendering, not re-scoring; (iii) add a guard test that no client path sorts daemon rows,
   and shrink `overscanLimit` as engine signals replace it.

## 7. Top-10 recommendations

| # | Action | Effort | Expected gate movement | Exact evidence needed |
|---|---|---|---|---|
| 1 | Re-measure the baseline on `wave2-judgments.json` / corpus `8d1419d` **before** any code change, including a real after-run of the wave-1 set on main (F10) | S | Correct reference: FP 0.50 → 0.25 | Committed gated JSON, both artifacts distinct hashes, daemon block, `meta.status` |
| 2 | Freeze the daemon across measurement windows; record pid/entries/event_id in every artifact | S | Protects every latency/ranking row | Start/end daemon blocks equal; one socket owner; no install during the window |
| 3 | Land F7 (per-process test log) before measurement work | S | Protects FP/zero-result evidence | Two concurrent scripts, distinct logs, production log hash-identical, `other_writers_rows = 0` |
| 4 | Symbol: fix access-modifier declarations + stop counting the mock string as a declaration | S→M | symbol zero-result 0.222→0.00, recall@10 0.778→1.00 | SY01–SY09 rows with declaration lines; SY03/SY04 non-zero |
| 5 | Move symbol ranking to the engine as a `def` score (accept #26 there), client renders | M | symbol nDCG/MRR; enables "definitions first" without a reranker | Engine patch + paired symbol-lane delta with CI; equivalence; no grep-p95 regression |
| 6 | Semantic: identifier/filename weighting, stopwords, ≥2-term co-occurrence, explicit abstention | M | semantic recall 0.175→≥0.60 mapped; FP 1.00→0.00 | SE top-3 rows, SE11/SE12 abstain, doc-share ≤ 0.67, held-out set |
| 7 | Near: remove the −20 self-penalty (or explicitly rank the named file), publish the formula | S | ranking-signal target met | RS03/RS04 paired ranks; named file rank 1 in both; no non-near regression |
| 8 | Push the exact-word conjunct into the engine (`all`/`any`) | M | zero-result 0.107→0.00 incl. RS09 | RS09 non-zero; single-token query equivalence |
| 9 | Boost/frecency/git: paired evidence on a git corpus or default off + label docs | S | ranking-signal claim becomes admissible | Paired per-round ranks, CI; today's tie recorded as unmeasurable (F12) |
| 10 | Gate re-scope with a measured floor margin; SLAs only from gated artifacts | S | CI honesty; no fantasy SLA | Raw-daemon n≥60 + threshold formula; hermetic mock gate stays strict; Linux job runs the real gate |

## 8. Blocking risks

1. **F10 is live in the Wave-2 briefs.** Any child quoting FP 0.50 or the "verified" judgment rows is
   building on a duplicated artifact. Fix the baseline first.
2. **Daemon churn during sibling measurements** (platform owns `engine/`; wave-1 precedent 3.3 → 128 ms).
   No ranking/latency number survives an unrecorded daemon swap.
3. **A client-side #26** would be the third reranker and cannot deliver the file-level claim; decide
   engine ownership before implementation starts.
4. **Semantic tuning to the published queries.** Without a held-out run, a 0.60 nDCG can be memorised.
5. **Held-out/scorer gap:** the wave-1 scorer does not yet understand `symbol_assertions`,
   `not_expected`, `searchSemanticIntent`, or paired signal controls. Extending it belongs to the
   verifier, not to the child whose work it scores.

## 9. Limits of this review

No source edits; every measurement here is a single-pass, ungated probe on a busy machine (`load1`
7–13), and only behavioural facts (files, order, error class, zeros) are claimed. The children had no
commits at review time, so §5 critiques their briefs. Review-verified: expected paths exist in the
corpus, symbol assertions match real declaration lines, identifier negatives are absent from the corpus
(SE11/SE12 are `absent_concept` negatives whose generic words overlap by construction — that is the
mechanism under test).
