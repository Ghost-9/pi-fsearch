process.env.PI_ULTRASEARCH_TEST = "1";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * F7 — per-process test audit logs.
 *
 * Wave 1 observed the single shared `test_audit.jsonl` truncated from 205 rows
 * to 4 by another process mid-window; every FP / zero-result / fallback
 * measurement reads that log, so a shared file makes concurrent evidence
 * unquotable. Each process must resolve its own log (or an explicit
 * `PI_ULTRASEARCH_TEST_LOG`), and the production log must stay untouched.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROD_AUDIT = path.join(os.homedir(), ".pi", "agent", "cache", "pi-ultrasearch", "audit.jsonl");

/** One row, written by the current process, with a marker query. */
const WRITER = `
process.env.PI_ULTRASEARCH_TEST = "1";
const { recordAudit, getTestAuditFilePath } = await import(${JSON.stringify(path.join(REPO, "src", "telemetry.ts"))});
recordAudit({
  ts: Date.now(),
  tool: "ultrasearch_query",
  query: process.argv[1],
  scope: ${JSON.stringify(REPO)},
  ms: 1,
  ok: true,
  hitCount: 1,
  source: "index",
});
console.log(getTestAuditFilePath());
`;

function runWriter(marker: string, env: Record<string, string | undefined>) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", WRITER, marker], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
  return out.trim().split("\n").pop()!.trim();
}

function fileDigest(file: string): { exists: boolean; sha256: string; bytes: number } {
  try {
    const buf = fs.readFileSync(file);
    return { exists: true, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  } catch {
    return { exists: false, sha256: "", bytes: 0 };
  }
}

test("F7: two concurrent writers get distinct logs and neither truncates the other", () => {
  const before = fileDigest(PROD_AUDIT);
  const a = runWriter("f7-concurrent-a", { PI_ULTRASEARCH_TEST_LOG: undefined });
  const b = runWriter("f7-concurrent-b", { PI_ULTRASEARCH_TEST_LOG: undefined });
  assert.notEqual(a, b, "two processes must not share one test log");
  const aRows = fs.readFileSync(a, "utf-8").split("\n").filter(Boolean);
  const bRows = fs.readFileSync(b, "utf-8").split("\n").filter(Boolean);
  assert.ok(aRows.some((r: string) => r.includes("f7-concurrent-a")));
  assert.ok(!aRows.some((r: string) => r.includes("f7-concurrent-b")), "A's log must not contain B's rows");
  assert.ok(bRows.some((r: string) => r.includes("f7-concurrent-b")));
  assert.ok(!bRows.some((r: string) => r.includes("f7-concurrent-a")), "B's log must not contain A's rows");

  // Same writer, explicit shared path: both rows land in exactly that file.
  const shared = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "us-f7-")), "shared.jsonl");
  const pa = runWriter("f7-shared-a", { PI_ULTRASEARCH_TEST_LOG: shared });
  const pb = runWriter("f7-shared-b", { PI_ULTRASEARCH_TEST_LOG: shared });
  assert.equal(pa, shared);
  assert.equal(pb, shared);
  const sharedRows = fs.readFileSync(shared, "utf-8").split("\n").filter(Boolean);
  assert.equal(sharedRows.length, 2, "the explicit log takes both rows");
  assert.ok(sharedRows.some((r: string) => r.includes("f7-shared-a")));

  const after = fileDigest(PROD_AUDIT);
  assert.deepEqual(after, before, "the production audit log must be byte-identical");
});
