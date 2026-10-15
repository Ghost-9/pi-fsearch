#!/usr/bin/env node
// bench/verification/backlog/checks/f41-prefetch.mjs — issue #41
//
// Claim: after an edit the extension warms the file's trigrams (debounced);
// one `tool_execution_end` listener; no latency claim unless gate-backed.
//
// Independent method: register the real Pi extension against a mock daemon and
// count `prefetch` ops for a burst of edits; count the extension's
// tool_execution_end listeners; a removal control makes the debounce fire
// immediately in a scratch copy and must produce many flushes instead of one.

import * as fs from "node:fs";
import * as path from "node:path";
import { REPO, gate, run, tmpdir, rmrf, scratchCopy, mutate, writeArtifact, stableHash, sha256Text } from "../lib.mjs";

async function editBurst(root, { debounceMs } = {}, filesRoot = REPO) {
  const { MockDaemon } = await import(path.join(filesRoot, "test", "helpers", "mock-daemon.ts"));
  const { loadPiHarness } = await import(path.join(filesRoot, "test", "helpers", "pi-harness.ts"));
  const daemon = new MockDaemon({ reply: () => ({ ok: true, complete: true, hits: [], files: [] }) });
  await daemon.listen();
  const file = path.join(root, "edited.ts");
  fs.writeFileSync(file, "export const someLongIdentifier = 1;\n");
  const harness = await loadPiHarness({ socketPath: daemon.socketPath });
  const listeners = harness.handlers.get("tool_execution_end")?.length ?? 0;
  // burst of five edits of the same file inside the window
  for (let i = 0; i < 5; i++) {
    await harness.emit("tool_execution_end", { toolName: "edit", params: { path: file }, durationMs: 3 });
    await new Promise((r) => setTimeout(r, 15));
  }
  await new Promise((r) => setTimeout(r, (debounceMs ?? 150) + 500));
  const prefetches = daemon.requests.filter((r) => r.payload?.op === "prefetch");
  const opens = daemon.requests.filter((r) => r.payload?.op === "open");
  // a read must not prefetch
  await harness.emit("tool_execution_end", { toolName: "read", params: { path: file }, durationMs: 2 });
  await new Promise((r) => setTimeout(r, 400));
  const prefetchesAfterRead = daemon.requests.filter((r) => r.payload?.op === "prefetch");
  const out = {
    listeners,
    prefetch_requests: prefetches.length,
    prefetch_paths: prefetches.map((p) => (p.payload.paths ?? []).length),
    open_requests: opens.length,
    prefetch_requests_after_read: prefetchesAfterRead.length,
  };
  await daemon.close();
  return out;
}

export async function check() {
  const g = gate();
  const rows = [];
  const tmp = tmpdir("ults-pf-");
  const head = await editBurst(tmp);

  // debounce removal control: immediate flush in a scratch copy
  let control = { ran: false };
  try {
    const scratch = scratchCopy("f41");
    mutate(path.join(scratch, "src", "prefetch.ts"), "}, this.options.debounceMs ?? 150);", "}, 0);");
    const ctl = await editBurst(tmp, { debounceMs: 0 }, scratch);
    control = { ran: true, ...ctl, scratch };
  } catch (e) {
    control = { ran: false, error: String(e) };
  }

  // no ungated latency claim for prefetch
  const claims = await run("sh", [
    "-c",
    `cd ${REPO} && grep -rn -i "prefetch" README.md CHANGELOG.md docs/*.md 2>/dev/null | grep -iE "[0-9]+(\\.[0-9]+)? *(ms|×|x|%)" || true`,
  ]);

  const defects = [];
  if (head.listeners !== 1) defects.push(`tool_execution_end listeners = ${head.listeners}, expected exactly 1`);
  if (head.prefetch_requests !== 1) defects.push(`5 rapid edits produced ${head.prefetch_requests} prefetch requests, expected 1 (debounce)`);
  if (head.prefetch_requests === 1 && head.prefetch_paths[0] !== 1) defects.push(`the single flush carried ${head.prefetch_paths[0]} paths, expected 1`);
  if (head.prefetch_requests_after_read !== head.prefetch_requests) defects.push("a read event triggered a prefetch");
  if (control.ran && !(control.prefetch_requests > head.prefetch_requests))
    defects.push(`debounce removal control did not increase flushes (control=${control.prefetch_requests}, head=${head.prefetch_requests})`);
  // acceptance: edit->grep latency measured before/after (no such measurement is published)
  const latencyPublished = claims.stdout.trim().length > 0;
  if (!latencyPublished) defects.push("acceptance line 'edit→grep latency measured before/after' has no published artifact (no ungated latency claim either)");

  const artifact = {
    generated_at: new Date().toISOString(),
    gate: g,
    head,
    debounce_removal_control: control,
    prefetch_latency_claims_in_docs: claims.stdout.trim().split("\n").filter(Boolean),
    defects,
  };
  const written = writeArtifact("bench/verification/backlog/results/f41-prefetch.json", artifact);

  rows.push({
    issue: 41,
    claim: "prefetch on edit: debounced warm-up, a single tool_execution_end listener, and edit->grep latency measured before/after with no ungated latency claim",
    verdict: defects.length ? "needs-work" : "verified",
    evidence:
      `real Pi extension against a mock daemon: tool_execution_end listeners=${head.listeners}; 5 rapid edits of one file produced ${head.prefetch_requests} prefetch request(s) ` +
      `carrying ${JSON.stringify(head.prefetch_paths)} path(s); a read event produced ${head.prefetch_requests_after_read - head.prefetch_requests} additional prefetch(es); ` +
      `removal control (debounce -> 0ms in scratch): ${control.prefetch_requests} request(s); published prefetch latency claims: ${latencyPublished ? JSON.stringify(claims.stdout.trim()) : "none"}`,
    method: "verifier drives the real index.ts tool_execution_end handler via test/helpers/pi-harness.ts against a mock daemon and counts the ops; removal control mutates the debounce constant in a scratch copy of HEAD; docs grepped for prefetch latency numbers",
    n: 4,
    gate: g.status,
    artifact: "bench/verification/backlog/results/f41-prefetch.json",
    evidence_hashes: { artifact: written.sha256, probe: stableHash(artifact) },
    notes: defects.length ? defects.join(" | ") : "debounce, single listener and no ungated claim reproduced",
  });

  rmrf(tmp);
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await check(), null, 2));
}
