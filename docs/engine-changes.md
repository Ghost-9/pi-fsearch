# What this fork changes in the vendored engine

`engine/` is upstream `fsearch` v0.2.1 (MIT © Noah Dunnagan; see
`engine/NOTICE` and `engine/LICENSE`), vendored so engine behaviour can be
changed and tested in-tree. This is the list of behavioural changes, so a
future upstream sync can re-apply them. Naming (binary, crate, socket, env
prefix) is handled separately by `engine/rebrand.sh`.

Files: `engine/src/…`. Every change keeps upstream's behaviour when nothing
new is configured: an operator who sets no environment variable and writes no
config file sees the same searches and the same index as v0.2.1.

## Testability (no runtime effect unless the variables are set)

| Change | File | Why |
|---|---|---|
| `ULTRASEARCH_DIR` / `HOME` / `SCAN_ROOT` (+ `FSEARCH_*` fallbacks) | `env.rs`, `main.rs`, `mcp.rs`, `server.rs`, `walk.rs` | Run a real daemon over a fixture tree on its own socket, without touching the live index or crawling the whole disk. `SCAN_ROOT` is canonicalized: the crawl opens the root with `O_NOFOLLOW_ANY`, which refuses a path containing a symlink (`/tmp`). |
| `Index::build(…, root)` and `Index::path(0)` return the crawl root | `index.rs` | Paths must exist on disk; before this, a fixture scan root produced `/file.txt`. |
| `Index::lookup` strips the crawl root | `index.rs` | Otherwise `lookup(home)` failed under an isolated root and the content index never built. |
| `Live::to_listings` starts at the index's own root, not `/` | `live.rs` | Otherwise a `save`/compaction folded no overlay entry under an isolated root: files added since the build were silently dropped. |
| The early index's root is `/` | `engine.rs` | `folder_listings` builds a chain from `/` down, so that is that index's root. |
| FSEvents events outside `SCAN_ROOT` are dropped; `ULTRASEARCH_DEBUG_KEEP=1` logs them | `engine.rs` | The stream watches all of `/`; without the filter, changes anywhere populated the overlay and searches answered with paths outside the index's own area. |

## Ranking

| Change | File | Why |
|---|---|---|
| Hits carry their `near` and `boost` components | `engine.rs` (`Found`), `server.rs` | **The server owns proximity ranking.** One formula (`server::nearness`), documented in code: +12 in the `near` file's folder, -3 per folder of distance, clamped at 0; the `near` file itself is -20. A client that re-ranks a daemon result double-counts the same signal on a different scale (the extension's `applyProximityRanking` used +100 and is now only used for the native `find`/`rg` fallback). |

## Budgets, early exit and the counts to judge them (#16, #35)

| Change | File | Why |
|---|---|---|
| `Progress` (deadline, candidate cap, `scanned`/`considered`, `expired`) on `Query` | `query.rs` | `budget_ms` and `candidates` bound a cold or whole-disk query. `None` unless asked for, so an ordinary search pays one predictable branch per entry and no atomics. |
| Deadline checks in `Scan::full` / `Scan::selective` and at pass/round boundaries | `query.rs` | A spent budget skips the deeper typo retry, another `spread` round, another `driven` try and the `ranked` batch loop, and stops the entry scan mid-piece. Granularity is `min(4096 entries, 1/8 piece)`, and each piece also checks at its first entry — a piece shorter than the tick would otherwise never check at all. |
| `complete` / `scanned` / `considered` / `budget_ms` in a search reply; `scanned`/`considered` added to grep's reply beside `candidates`/`read` | `server.rs` | A partial answer must say so, and the work it did must be checkable. |

## Index health (#19, #34)

| Change | File | Why |
|---|---|---|
| `last_event_id`, `event_lag`, `staleness_ms`, `replay_in_progress` in `status`; `stale`/`stale_ms` on answers | `engine.rs`, `server.rs` | An agent must be able to tell whether a result may miss recent changes. `staleness_ms` is 0 when the index is caught up, and the window opens at a detected drop or a relist and closes on `HISTORY_DONE`/relist completion. |
| A stream started at (or past) the newest event id is not "replaying" | `engine.rs` | FSEvents sends no `HISTORY_DONE` for a stream with no history, so the window never closed and every answer was marked stale. |
| Compaction counters in `status`; a due compaction waits up to `COMPACT_DRAIN` (2 s) for in-flight queries, ignoring the pause past `COMPACT_URGENT`; churn warning after `CHURN_WARN` size-forced compactions | `engine.rs` | A compaction rebuilds the whole index and would take the cores a search is waiting on. `compact_now` is a pure function so the policy is unit-tested. |
| The save request is read, not cleared, until the compaction runs | `engine.rs` | A postponed compaction was otherwise lost entirely: the overlay may be under `COMPACT_PENDING` and the index not stale, so nothing brought it back. |

## Security boundary (#23)

| Change | File | Why |
|---|---|---|
| Fail-closed deny-list (`ULTRASEARCH_DENY`, `ULTRASEARCH_DENY_FILE`, `<index dir>/deny.txt`), enforced before any result leaves; `withheld` reported | `deny.rs`, `server.rs` | Enterprise policy above the user's request. Rules and caller roots are normalized like indexed paths, so a rule written `/var/...` still matches the `/private/var/...` the index holds. |
| Result-bearing ops refuse a denied scope; diagnostics (`ping`, `status`, `save`) stay reachable and `status` reports `deny_configured` / `deny_rules` / `deny_error` | `server.rs` | A broken policy must be visible, and "denied" must not look like "no results". |
| A request may name its allowed boundary (`root`); an escaping scope or grep `file:` is a security error, and hits outside the root are dropped | `server.rs` | The engine is the last place a path can be stopped. |

## Content coverage (#17)

| Change | File | Why |
|---|---|---|
| `coverage.json` / `ULTRASEARCH_CONTENT_*` / `ULTRASEARCH_WARM`, applied in `Scope::file` and `in_scope`, summarized in `status.content_policy` | `coverage.rs`, `content.rs`, `engine.rs` | Coverage was a fixed heuristic with no way to see or change it, so a 0-hit grep was ambiguous. A folder above a configured root still passes `in_scope` — the traversal has to reach the root — while `Scope::file` applies the rule to each file. |
| Warm folders are queued for content at start | `engine.rs` | A freshly opened repo becomes greppable without waiting for a general reconcile. |

## Known limitations (not fixed here)

* The listening socket's accept queue is the OS default (`libc::listen` is
  never called with a larger backlog), so a burst past it — empirically ~128
  simultaneous connects — is refused rather than queued. A client pool
  (`OPTIMIZATIONS.md` A5) is the right fix on the caller's side.
* `event_lag` counts every change on the volume, not the index's own, so on a
  busy machine it is a hint, not a staleness measure. `staleness_ms` is the
  measure.
* `scanned`/`considered` are 0 for a query answered by a strategy that visits
  names rather than entries (`ranked`, `driven`); they are counts of the entry
  scan, and the reply says nothing when no budget was requested.
* No discrete "low-score run" heuristic was added for #35: the early exit is a
  deadline, a candidate cap, and the existing floor-based pruning in `top_k`.
