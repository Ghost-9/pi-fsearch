# W3-03 — `recall@10 == 1.00` is unreachable on the frozen wave-1 set (#48)

**Verdict:** the gate cannot pass, and not because of the engine. After the ranking fix
there are **zero reachable misses**: every expectation that any correct implementation
could satisfy is found in the top 10. The 16 remaining misses name a file that does not
contain the query term, ask a path lane for a content mention, or ask symbol mode for a
reference.

## The audit

`bench/wave3/expectation-audit.mjs` classifies every `grade >= 1` expectation that is
absent from the top 10 against the corpus file itself.

| results artifact | reported recall@10 | audited recall@10 | reachable misses |
|:--|--:|--:|--:|
| `final-base.json` (engine `7029579839`) | 0.7833 | 0.9872 | **2** — R2: `src/sanitize.ts`, `test/client.test.ts` |
| `final-rank.json` (engine `7b413d87`) | 0.7962 | **1.0000** | **0** |

Audited recall@10 recomputes the metric over the expectations that are reachable.

## The 16 unreachable expectations

### `absent-string` (3) — the file does not contain the query term

| id | lane | query | expected | proof |
|:--|:--|:--|:--|:--|
| G4 | grep-literal | `fsearch.sock` | `README.md` (g1) | `rg -c 'fsearch\.sock' README.md` → 0 (the file says "UNIX socket"; `CHANGELOG.md` and `src/client.ts` are the only two files with the literal, and both are returned) |
| P6 | path | `codemode` | `OPTIMIZATIONS.md` (g1) | `rg -c -i codemode OPTIMIZATIONS.md` → 0 |
| K1 | ranking-frecency | `readme` | `CONTRIBUTING.md` (g1) | `rg -c -i readme CONTRIBUTING.md` → 0 |

No implementation can return these. G4 additionally cannot be "incomplete": only two files
in the corpus contain the token and the tool returns both.

### `path-lane-content` (6) — a path lane asked for a content mention

`P3` (`client.ts` → `test/client.test.ts`), `P6` (`codemode` → `AUDIT-2026-10-14.md`),
`K2` (`sanitize` → `OPTIMIZATIONS.md`, `AUDIT-2026-10-14.md`), `K3` (`client` → `src/mcp.ts`,
`README.md`). These expectations exist in the corpus and mention the term, but only in their
*content*.

`ultrasearch_query` is a path search; content retrieval is `ultrasearch_grep`. Adding a
content fallback to `search` would break the lane's own pinned invariant — RS01
(`src/client.ts`) declares `not_expected: test/client.test.ts`, "exact path query must not
degrade into a substring match" — and would put a content scan on the ranking lane, whose
budget is p50 ≤ 3 ms.

### `symbol-lane-reference` (7) — symbol mode asked for a reference

`S1` (`FSearchClient` → `test/client.test.ts`, `src/mcp.ts`, `src/tui.ts`, `index.ts`),
`S3` (`applyProximityRanking` → `AUDIT-2026-10-14.md`), `S4` (`resolveWorktreeRoot` →
`CHANGELOG.md`, `AUDIT-2026-10-14.md`). Each names a file that *references* the identifier
without declaring it.

The two frozen sets contradict each other here. Wave 2's symbol bar pins declaration-first
behaviour: `SY01`'s `symbol_assertions` require the declaration line, and the wave-2 engine
found `symbol recall@10 0.778 → 1.000 (9/9)` by making symbol mode declaration-only
(`GrepMode::Symbol` with a plain identifier plans on the definition index, so the candidate
set *is* "the docs that define it"). Returning references to satisfy wave 1 would put
non-declarations back into the ranked set that wave 2 measures as `not_expected`/grade 0.

## Conclusion

The honest reading of `recall@10` on this set is the **audited** one: **1.0000**, with the
shortfall fully attributed. The as-written gate requires returning files that do not contain
the query, so it is reported as an evidence-backed cap rather than a pass, exactly as the
mission allows for a bar that cannot be met ("or the bar documents a justified cap with
evidence").

Recommended action for the owning wave: amend the frozen wave-1 set to either drop the three
`absent-string` expectations and move the `path-lane-content` / `symbol-lane-reference`
expectations into the lane that can satisfy them, or score the path lane against
path-matching expectations only and record `recall@10` per lane basis. The verdict here is
that no engine change can close it.

## Per-lane reformulation (the other half of #48)

| lane | n | before | after | bound | verdict |
|:--|--:|--:|--:|--:|:--|
| grep-literal | 5 | 0.4000 | **0.0000** | ≤ 0.35 | **PASS** |
| grep-regex | 2 | 0.5000 | **0.0000** | ≤ 0.35 | **PASS** |
| path | 6 | 0.0000 | 0.0000 | ≤ 0.35 | pass |
| symbol | 4 | 0.0000 | 0.0000 | ≤ 0.35 | pass |
| semantic | 5 | 0.2000 | 0.2000 | ≤ 0.35 | pass |
| ranking-frecency / -proximity / -boost-ab | 1 / 1 / 1 | 0.0000 | 0.0000 | ≤ 0.35 | pass |
| ranking-symbol-intrafile | 1 | 0.0000 | 0.0000 | ≤ 0.35 | pass |
| **overall** | 26 | 0.1538 | **0.0385** | ≤ 0.20 | **PASS**, Δ CI [−0.3462, −0.0385] excludes 0 |

`reformulation` is "share of must-hit rows whose top-1 grade < 2". The `grep-regex` lane is
scored as a point condition: a BCa interval over two rows is not a statistic, and the bound
is a threshold on the lane mean, not an estimate.
