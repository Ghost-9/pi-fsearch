# 0004 — Policy and containment live in the engine

**Choice.** The fail-closed deny-list and the caller's `root` boundary are
enforced in the daemon, before any result leaves; a denied scope is a security
error, not an empty result. DLP scrubbing stays client-side.

**Reason.** The engine is the last place a path can be stopped; a client-only
filter is bypassable by any other client of the same socket, and "withheld"
must be distinguishable from "no results".

**Rejected.**
- Filtering in the client only: one socket, many clients.
- Silent narrowing to the allowed root: an agent cannot tell policy from absence.
- Applying the deny-list to `ping`/`status`/`save`: an operator must be able to
  ask why everything stopped working.
