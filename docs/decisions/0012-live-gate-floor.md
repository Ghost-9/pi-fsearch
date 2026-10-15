# 0012 — The live gate derives its floor in-run and keeps overhead strict

**Choice.** The live benchmark gate calibrates against the bare daemon socket in
the same run: `ceiling = max(12 ms, rawP95 × 2 + 1)`, with an unconditional
`clientP50 − rawP50 < 3 ms` assertion. A cold or replaying index (#19:
`replay_in_progress`, `staleness_ms > 0`, `uptime_ms < 30 s`) may excuse the
absolute ceiling only, up to a `rawP95 × 4 + 10 ms` hard cap.

**Reason.** The wave-1 5 ms live grep threshold was below this machine's own
floor (raw daemon p95 7.65 ms, n=60; client p95 8.59 ms), so `test:gate` could
never pass and the threshold could not detect a client regression. A
floor-relative threshold plus the overhead assertion is auditable and
machine-independent. `gateDecision()` is a pure exported function with unit tests:
a wave-1-style 128 ms takeover fails even with a stale-window excuse, so the skip
rule cannot mask a regression.

**Rejected.**
- Skipping the live gate when cold: an unfalsifiable gate.
- Lowering the threshold to the measured floor without a formula: the next
  machine silently re-breaks it.
- Dropping the live gate and keeping only the hermetic mock: a mock cannot see
  the daemon or the socket.
