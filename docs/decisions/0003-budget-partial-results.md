# 0003 — Server-side budgets answer partial, never block

**Choice.** `budget_ms` is enforced inside the engine scan; an expired budget
returns the best hits found so far with `complete:false` and `scanned`/
`considered` counts. `candidates` caps how many candidates may be scored.

**Reason.** Real sessions produced 1,721 ms / 1,952 ms / 4,007 ms whole-disk
queries. A client-side timeout can only abandon the request; a server-side
deadline gives the agent *something* and says so. Wave-2 extends the same
contract with an opt-in low-score run (0009).

**Rejected.**
- Unbounded scans: multi-second tails.
- Client-side timeout only: the daemon keeps working, the socket stays busy.
- Returning a silent truncation without `complete:false`: indistinguishable from
  a real top-k.
