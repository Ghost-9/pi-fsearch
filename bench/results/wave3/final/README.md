# Empty by design

No wave3/ops artifact passed the environment gate (AC + load1 < 1.5 + no cargo/rustc)
during the bounded 30-minute wait, so none may be labelled `final`
(`VERIFICATION-PROTOCOL.md` §2, `docs/sla.md` §3).

Provisional artifacts and their metadata live in `../provisional/`; the gate wait record
is `../gate-samples.jsonl`; the index is `../manifest.json`.
