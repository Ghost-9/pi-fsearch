# 0013 — A grep page is ranked by what its files contain

**Choice.** `ultrasearch_grep` orders the page it returns by content, not by where
the candidate order happened to put each file:

1. a file whose matched line **defines** the match beats a file that only mentions it;
2. then **more matches** beat fewer;
3. then **source** beats prose (`.md`/`.markdown`/`.rst`/`.txt`/`.adoc`/`.asciidoc`/`.org`/`.tex`,
   and `README`/`CHANGELOG`/`CONTRIBUTING`/`NOTICE`/`LICENSE`/`AUTHORS`/`COPYING`).

Ties keep candidate order, and the tier in (3) is also applied to the *candidate*
order (`doc_rank`), so a document cannot spend the page before a source file is read.
Symbol mode is excluded: its candidate plan is already "exactly the docs that define it".

**Reason.** Candidate order is `(your-files tier, mtime, segment, doc)`. On a corpus whose
mtimes tie — a `git archive`, a fresh clone — that is plain path order, so
`AUDIT-2026-10-14.md` sorts above the file that declares the symbol it discusses. Measured
on the frozen wave-1 judgment set: `grep-literal` reformulation 0.40 and `grep-regex` 0.50
against a bound of 0.35, with the wrong file at rank 1. An agent's first row was a changelog.
After the change both lanes are 0.00 and the whole-set recall of the regex row is 1.00.

The tiers are ordered by strength, not by taste: `defined_at` is a fact about the file,
match count is a measurement, and source-over-prose is a tie-break that cannot overturn
either. A definition always wins, and the class tier is only reached when the first two
are level.

**Rejected.**
- *Ranking in the client.* Decided in [0004](0004-engine-enforces-policy.md): one socket,
  many clients, and the engine is the only place a path can be dropped. Also, the client
  never sees the candidates the engine declined to read.
- *Over-reading (read `limit + margin` files) and then ranking.* It would pull more files
  into the page, but it breaks the `cursor` contract — the `next` page index is derived
  from the furthest candidate read, so files dropped by the re-rank would become
  unreachable — and it opens more files for every grep. Not worth it: demoting prose in
  the candidate order already lets the declaring file into the page.
- *Ranking multi-pattern (`any_of`) greps differently.* Tried and reverted: it changed
  nothing measurable (SE09 was identical with it on and off), so it was speculative.
- *Ranking `search` (path/intent) results.* Untouched. The path lane's contract is
  `RS01`: an exact path query must not degrade into a substring match.

**Cost.** The sort is over the page already read: no extra candidate is opened by it.
Measured on the mixed worktree scope (1 126 entries, 320 content docs) the tier *reduces*
reads — 83 → 80 files for `UltraSearchClient`, 39 → 36 for `ignored` — because prose no
longer occupies read slots. On the 33-file frozen corpus all 30 judgment rows report
identical `read`, `candidates` and result counts.
