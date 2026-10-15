# Wave 3 — relevance fixes (#47, #48)

Branch `wave3/relevance-fixes`. Two issues, two frozen judgment sets, one instrument.

| note | subject |
|:--|:--|
| [W3-01](W3-01-glob-set-completeness.md) | #47 `glob_set_completeness` was measuring the instrument, not the engine |
| [W3-02](W3-02-grep-page-ranking.md) | #48 engine change: a grep page is ranked by what its files contain |
| [W3-03](W3-03-recall10-cap.md) | #48 the recall@10 cap, with the expectation audit |
| [W3-04](W3-04-cli-mcp-identity.md) | #47 identical sets through client, CLI and MCP |
| [0014](../decisions/0014-grep-page-ranking.md) | the decision and its rejected alternatives |

## Headline

| gate | before | after | verdict |
|:--|--:|--:|:--|
| Tier-L (wave-2 set, 18 checks) | 17/18 | **18/18** | pass |
| `glob_set_completeness` (RS02) | 0.714 (instrument error) | **1.000** | pass |
| reformulation, `grep-literal` (≤ 0.35) | 0.400 | **0.000** | pass |
| reformulation, `grep-regex` (≤ 0.35) | 0.500 | **0.000** | pass |
| reformulation, overall (≤ 0.20) | 0.154 | **0.038** | pass, Δ CI excludes 0 |
| recall@10 on the wave-1 set | 0.783 | 0.796 (CI includes 0) | **capped, evidence in W3-03** |
| recall@10 over reachable expectations | 0.987 | **1.000** | pass |

## Reproduce

```bash
# corpora (stable path; the advisor worktree the wave-1 set declares is gone)
node bench/wave3/make-corpora.mjs                 # -> ~/.cache/ultrasearch/corpus/{wave1-0a16e50,wave2-8d1419d}

cargo build --release --manifest-path engine/Cargo.toml
node bench/verification/checks/isolated-daemon.mjs start --dir /tmp/us-w3 \
  --corpus ~/.cache/ultrasearch/corpus/wave1-0a16e50
export PI_ULTRASEARCH_SOCKET=/tmp/us-w3/ultrasearch.sock

# wave-1 judgment set: measure, audit expectations, pair against a baseline
node bench/wave3/measure.mjs            --out bench/wave3/results/rank.json --label rank --wait-docs 33
node bench/wave3/expectation-audit.mjs  --results bench/wave3/results/rank.json
node bench/wave3/compare.mjs            --before bench/wave3/results/final-base.json --after bench/wave3/results/rank.json

# wave-2 Tier-L table
PI_ULTRASEARCH_TEST=1 node bench/verification/checks/score-wave2.mjs \
  --judgments bench/judgments/wave2-judgments.json --bars bench/judgments/wave2-bars.json \
  --corpus ~/.cache/ultrasearch/corpus/wave2-8d1419d

# #47 acceptance: same set through all three surfaces
node bench/wave3/identity-cli-mcp.mjs

# load-invariant cost evidence (daemon-reported reads, not wall clock)
node bench/wave3/work-probe.mjs --out bench/wave3/results/work.json --label work --rounds 5
```

## Environment / quotability

Every artifact in `bench/wave3/results/` was produced with the gate **provisional**
(AC power, no `cargo`/`rustc`, but 1-min load 10–18 from `mds_stores`, `mediaanalysisd` and
Time Machine during the ops run). Quality rows are set comparisons and are unaffected;
**timing** rows are labelled provisional and must not be quoted as absolute p95s. The
load-invariant substitute is the daemon-reported `read`/`candidates` count in
`W3-02`.

The semantic lane's latency budget (`p50 ≤ 25 ms`, `p95 ≤ 75 ms`) is **already exceeded in
the verifier's own wave-2 baseline** (p50 35.99 / p95 101.69) and is unchanged by this
branch (p50 36.6 / p95 98.6 here) — pre-existing, not a wave-3 regression.
