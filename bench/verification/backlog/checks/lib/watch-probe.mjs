#!/usr/bin/env node
// bench/verification/backlog/checks/lib/watch-probe.mjs
//
// Verifier-owned watch probe. Runs the real WatchSession against the socket in
// PI_ULTRASEARCH_SOCKET over WATCH_DIR, streams the query, then stops and
// reports residual handles. Run in its own process so a leaked socket or timer
// keeps the process alive (the parent treats a non-zero/absent exit as a leak).

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.env.VERIFY_REPO;
const DIR = process.env.WATCH_DIR;
const SOCKET = process.env.PI_ULTRASEARCH_SOCKET;

const { WatchSession } = await import(path.join(ROOT, "src", "watch.ts"));
const { UltraSearchClient } = await import(path.join(ROOT, "src", "client.ts"));

const events = [];
const client = new UltraSearchClient({ socketPath: SOCKET, autoSpawnDaemon: false, maxReconnectRetries: 0, lanes: 1, timeoutMs: 15000, enableFallback: false });
const session = new WatchSession({
  query: "watchmarker*.txt",
  dir: DIR,
  client,
  limit: 20,
  debounceMs: 40,
  installSignalHandlers: false,
  closeClientOnStop: true,
  pollIntervalMs: 10000,
  watchSilenceMs: 10000,
  onEvent: (e) => events.push({ ...e }),
});

await session.start();
const baseline = events.filter((e) => e.type === "baseline").length;
const t0 = Date.now();
const newFile = path.join(DIR, "watchmarker-new.txt");
fs.writeFileSync(newFile, "two\n");
let addAt = null;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 25));
  if (events.some((e) => e.type === "add")) {
    addAt = Date.now();
    break;
  }
}
const adds1 = events.filter((e) => e.type === "add").length;
fs.appendFileSync(newFile, "three\n");
await new Promise((r) => setTimeout(r, 900));
const adds2 = events.filter((e) => e.type === "add").length;
fs.rmSync(newFile);
await new Promise((r) => setTimeout(r, 900));
const removes = events.filter((e) => e.type === "remove").length;
const stats = session.stop();
await new Promise((r) => setTimeout(r, 300));
const resources = process.getActiveResourcesInfo().filter((r) => /Socket|Pipe|Timeout|Immediate|FSWatcher|StatWatcher/.test(r));

console.log(
  JSON.stringify({
    baseline,
    add_latency_ms: addAt === null ? null : addAt - t0,
    adds1,
    adds2,
    removes,
    stats,
    pool: client.poolStats(),
    resources,
    event_types: events.map((e) => e.type),
  })
);
process.exit(0);
