# 0002 — One audit write per call, provenance-tagged

**Choice.** `recordAudit` is called once per tool call (from the client), and
rows carry `origin: "organic" | "synthetic"`. Test/benchmark runs are isolated by
`PI_ULTRASEARCH_TEST=1` (and, since wave 2, a per-process log, see 0010).

**Reason.** Wave 1 found 101 of 139 rows were synthetic and that rows were
double-written (client and tool wrapper), so percentiles were not trustworthy.
One writer plus explicit provenance is what makes "real-session p50/p95" a
measurement rather than a formula.

**Rejected.**
- Recording in both the client and the tool wrapper: duplicated rows.
- Filtering synthetic rows out at read time by query signature: a heuristic that
  leaked into "real" statistics.
- Writing benchmarks into the production log: contaminates agent-facing metrics.
