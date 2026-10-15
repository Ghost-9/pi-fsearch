# 0005 — Content coverage is configurable and reported

**Choice.** `coverage.json` / `ULTRASEARCH_CONTENT_*` / `ULTRASEARCH_WARM`
control what the content index holds; `status.content_policy` reports the policy
in force, and warm folders are queued at start.

**Reason.** Coverage was 3.5 % (129 k of 3.73 M entries) and undocumented, so a
0-hit grep was ambiguous. A stated policy plus a reported one turns "no results"
into a checkable answer.

**Rejected.**
- Indexing everything: binary and generated noise, unbounded disk.
- Keeping the fixed heuristic and documenting it as-is: the number would drift
  with every upstream change and no operator could widen it.
- A silently unparsable policy: it is an error at daemon start, not a fallback.
