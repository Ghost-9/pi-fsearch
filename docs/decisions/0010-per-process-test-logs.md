# 0010 — Each test process writes its own audit log (F7)

**Choice.** With `PI_ULTRASEARCH_TEST=1` and no explicit
`PI_ULTRASEARCH_TEST_LOG`, `getAuditFilePath()` resolves
`test_audit.<pid>.jsonl`. A run that needs a fixed path sets the environment
variable.

**Reason.** Wave-1 finding F7: the single shared `test_audit.jsonl` went from
205 rows to 4 when another process truncated it mid-window. Every FP /
zero-result / fallback measurement reads that log, so concurrent writers made
evidence unquotable. `test/telemetry-logs.test.ts` runs two concurrent writers
and asserts distinct logs, no cross-contamination, explicit-path honouring, and a
byte-identical production log.

**Rejected.**
- Keeping one shared file with offset isolation: safe only until a truncation.
- A global lock around appends: does not stop truncation by a non-cooperating
  process, and serialises measurement processes.
- Deleting the old file: it is the record of what wave 1 measured; it stays.
