# 0001 — Vendor a renamed fork of the engine

**Choice.** Keep the engine source in-tree at `engine/` as a renamed fork (MIT,
© Noah Dunnagan, v0.2.1), regenerated deterministically by `engine/rebrand.sh`;
the daemon that ships is built from that source.

**Reason.** Engine behaviour must be changeable and testable in-tree, upstream
attribution must survive, and "the source that ships is the source that is
reviewed". `docs/engine-changes.md` lists every behavioural patch so a future
upstream sync can re-apply them; `engine/LICENSE` is byte-identical to upstream.

**Rejected.**
- Patching a pip/cargo upstream dependency at build time: the built artefact
  would not match the reviewed tree.
- Shipping a prebuilt binary without source: no behaviour change is reviewable.
- Renaming without the rebrand script: every sync would re-derive the mapping by
  hand and drift.
