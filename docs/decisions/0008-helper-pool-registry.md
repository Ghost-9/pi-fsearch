# 0008 — The helper pool serves every live search

**Choice.** `run_lanes` registers its lane set in a registry of live sets, and
each helper thread claims one lane from the next live set with unclaimed lanes
(round-robin), instead of the pool holding only the newest search.

**Reason.** With a single newest-only slot, helpers all served the search
published last; every earlier concurrent search was left with only its calling
thread (one lane of four to six) and ran near-serially. Measured on the fixture:
three concurrent greps used ~3.6 cores total and took 2.1–2.3× one call whatever
the client lane count. The new registry lets helpers spread across live sets.
`content::tests::concurrent_runs_share_the_helper_pool` fails on the old code
(a search never gathers its four lanes; the gate reports the timeout) and passes
on the new one.

**Rejected.**
- Spawning short-lived scoped threads per `run_lanes`: ~50–100 µs of spawn cost
  on a hot path (every grep calls it several times).
- Leaving it and documenting "3 concurrent ≈ 3×": that is a real concurrency
  defect, not a physics limit — the pool was not being shared.
- A global query queue/semaphore: the engine already ran queries concurrently;
  the defect was *within* the helper scheduler, and a queue would add
  head-of-line blocking without addressing it.
