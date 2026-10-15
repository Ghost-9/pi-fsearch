# Wave 2 ranking — remaining engine item (deferred)

Owner: **wave2/relevance** (engine ranking functions were reassigned to this child; the
`patches/wave2-ranking-engine.patch` route was the fallback before that reassignment).

## Landed in `engine/`

- `engine/src/symbols.rs` — tree-sitter declaration spans (TypeScript/TSX/JavaScript/Rust;
  Go/Swift have no ABI-compatible grammar compiled in and keep the lexical confirmation).
- `engine/src/content.rs` — `DEFINES`/`MODIFIERS` index and scan patterns, string/comment
  rejection in `defined_at`, AST declaration lines as the authority in `lines_at`
  (`mode: "symbol"` no longer counts a declaration-shaped string literal and now finds
  `public`/`private` member declarations).
- `engine/src/server.rs` — the returned score vector `{match, near, boost, def}`; the `near`
  self-penalty is gone (`+10` for the named file, `+12` for its folder, `-3` per folder,
  clamped at 0).
- Client: `src/client.ts` requests `defs` for symbol/tagged grep; `src/formatter.ts` renders
  `[def:*]` from the engine verdict and `explainReasonTags()` renders `[exact] [glob]
  [git:*] [proximity] [frecency] [symbol] [match:N] [score:N]` for `ultrasearch_query`.
  `test/ranking-guard.test.ts` pins both properties.

## Deferred: the exact-word conjunct (RS09)

`enforceExactQuery` (client, `src/client.ts`) rewrites each query word to an exact token and
the client then keeps only paths containing every token, so `search("format grep files")`
returns 0 rows (RS09, measured). The advisor's recommendation is an engine-side `all`/`any`
operator:

- request shape: `{"op":"search","q":"format grep files","words":"any"}` (default `all` =
  today's conjunctive behaviour; `any` = rank rows matching at least one word, exact-word
  matches first, then prefix, then substring, with the match component in the score vector);
- single-token queries stay byte-identical (equivalence is required before/after);
- the client's `enforceExactQuery`/`extractExactWords` filters are then limit-only.

RS09 is non-gating for Tier-L (known_fail row, excluded) and blocking only for an
"agents find files first try" claim, so it did not ship in this wave. No patch file is
provided: the engine is editable by this child now; the work is scoped above for the next
wave or the parent.
