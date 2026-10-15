# 0007 — Measurements come from a verifier-owned harness

**Choice.** Latency, equivalence, token, zero-result and judgment numbers are
produced by `bench/baseline/*.mjs` on the verifier's branch, with an environment
gate (AC power, load < 1.5, no cargo/rustc) and raw JSON committed. Author
numbers are hypotheses until re-measured.

**Reason.** Earlier harnesses were author-owned and reported figures the README
later retracted. An instrument the claimant also owns cannot be audited.

**Rejected.**
- Reusing `test/bench.ts` (author-owned): no independence.
- Reporting provisional numbers as final because the delta "looked stable":
  rejected; `meta.status` is part of the artifact.
- A single-run p50: median + CI + n ≥ 30 is the price of a claim.
