# The engine deny-list (fail-closed)

The daemon can be told that some paths must never reach a client, whatever an
agent asks for. It is enforced in the engine — the last place a path can be
stopped — before a result is written, and it applies to every result-bearing
operation (`search`, `glob`, `grep`, `recent`).

## Configuring it

First source that is configured wins:

1. `ULTRASEARCH_DENY` — absolute path prefixes, `:` or `,` separated.
2. `ULTRASEARCH_DENY_FILE` — a file to read the same list from.
3. `<index dir>/deny.txt` — used when it exists.

A list file is one absolute path prefix per line; blank lines and lines
starting with `#` are ignored:

```
# never let an agent see these
/Users/me/private
/Volumes/company-vault/
```

Matching is by whole path components: `/p/secret` blocks `/p/secret/keys.pem`
but not `/p/secretary`. Rules and caller roots are normalized the way the index
normalizes paths (symlinks resolved, longest existing prefix), so a rule
written as `/var/folders/...` still matches the `/private/var/folders/...` the
index holds.

## Fail-closed behaviour

* A rule that is not an absolute path is an error: **no result request is
  served** while the list is unusable. A rule we cannot understand must not
  silently allow what it was meant to block.
* `ULTRASEARCH_DENY_FILE` naming a file that does not exist is an error. The
  implicit `<index dir>/deny.txt` simply may not exist, and then nothing is
  denied (upstream's behaviour).
* The list is re-read when its mtime changes. A source that changes but no
  longer parses keeps failing every request rather than falling back to the
  last good list.
* `ping`, `status` and `save` still answer, and `status` reports
  `deny_configured`, `deny_rules` and (when broken) `deny_error`, so an
  operator can see that the policy, not the index, is what broke.
* A denied **scope** is refused outright rather than silently narrowed: an
  agent must not be able to read "denied" as "nothing matched".

## What a caller sees

* `withheld: <n>` on a reply whose results were filtered (search and grep).
* `{"ok": false, "error": "security: …"}` for a denied scope, a scope outside
  the caller's `root`, or an unusable policy.

## Caller boundary (`root`)

A request may name the boundary it is allowed to see:

```json
{"op": "search", "q": "in:/somewhere config", "root": "/Users/me/repo"}
```

* A scope outside `root` — including one named by the query language's own
  `in:` filter, or by an absolute glob, or a `git:` filter's `cwd` — is a
  security error for that request.
* Hits outside `root` are dropped and counted in `withheld`, so a daemon whose
  own index is wider than the caller's boundary cannot leak through it.

The extension sends `root` for its worktree-scoped tools and refuses an
escaping `in:` scope before dispatch, so the agent gets an actionable message;
the engine's check is the one that cannot be bypassed by a caller bug.
