#!/usr/bin/env node
// bench/wave3/work-probe.mjs — load-invariant cost evidence for the grep ranking.
//
//   PI_ULTRASEARCH_TEST=1 PI_ULTRASEARCH_SOCKET=<sock> node bench/wave3/work-probe.mjs \
//     --judgments <f> --out <f> --label <n> [--rounds 5]
//
// Wall-clock on a shared laptop is not quotable when Spotlight or Time Machine
// are busy, so this records what the *daemon* did, which is invariant under
// host load: how many candidates it considered and how many files it read
// (`read`, `candidates`), plus the engine's own `took_us` (which excludes the
// socket and the client). The ranking change must not open a single extra file:
// `read` and `candidates` must be identical, arm to arm, for every row.

process.env.PI_ULTRASEARCH_TEST = "1";

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const JUDGMENTS = JSON.parse(fs.readFileSync(opt("judgments", path.join(REPO, "bench", "judgments", "wave1-judgments.json")), "utf8"));
const OUT = opt("out", path.join(REPO, "bench", "wave3", "results", "work.json"));
const LABEL = opt("label", path.basename(OUT, ".json"));
const ROUNDS = Number(opt("rounds", 5));
const ROOT = opt(
  "corpus",
  [
    path.join(process.env.HOME, ".cache", "ultrasearch", "corpus", "wave1-0a16e50"),
    path.join(process.env.HOME, ".cache", "pi-ultrasearch-bench", "corpus-0a16e50"),
  ].find((p) => fs.existsSync(p)),
);

const { UltraSearchClient } = await import(pathToFileURL(path.join(REPO, "src", "client.ts")).href);

const client = new UltraSearchClient({ timeoutMs: 20000 });
// Warm the content index and the page cache the same way for both arms.
{
  const deadline = Date.now() + 60000;
  let stable = 0;
  let last = -1;
  while (Date.now() < deadline) {
    const s = await client.status().catch(() => null);
    const docs = s?.content_docs ?? 0;
    if (docs === last && docs > 0 && (s?.content_pending ?? 0) === 0) {
      if (++stable >= 3) break;
    } else stable = 0;
    last = docs;
    await new Promise((r) => setTimeout(r, 400));
  }
  process.stderr.write(`[work] warm-up: content_docs=${last}\n`);
}
for (const q of JUDGMENTS.queries) {
  if (["path", "ranking-frecency", "ranking-proximity", "ranking-boost-ab"].includes(q.lane)) continue;
  const limit = q.params?.limit ?? 10;
  for (let i = 0; i < 3; i++) await client.grep(q.query, { in: ROOT, limit, mode: q.params?.mode ?? "literal", budget_ms: 2500, context: 0 }).catch(() => null);
}

const rows = [];
for (const q of JUDGMENTS.queries) {
  if (["path", "ranking-frecency", "ranking-proximity", "ranking-boost-ab"].includes(q.lane)) {
    const limit = q.params?.limit ?? 10;
    const samples = [];
    for (let r = 0; r < ROUNDS; r++) {
      const t0 = performance.now();
      const res = await client.search(q.query, { in: ROOT, limit, git: true });
      samples.push({ wall_ms: performance.now() - t0, took_us: res.took_us ?? null, read: res.read ?? null, candidates: res.candidates ?? null, n: (res.hits ?? []).length });
    }
    rows.push({ id: q.id, lane: q.lane, op: "search", query: q.query, samples });
    continue;
  }
  const limit = q.params?.limit ?? 10;
  const mode = q.params?.mode ?? "literal";
  const samples = [];
  for (let r = 0; r < ROUNDS; r++) {
    let res;
    try {
      res = mode === "semantic"
        ? await (await import(pathToFileURL(path.join(REPO, "src", "semantic.ts")).href)).searchSemanticIntent(client, q.query, { in: ROOT, limit })
        : await client.grep(q.query, { in: ROOT, limit, mode, budget_ms: 2500, context: 0, tag_symbols: mode === "symbol" });
    } catch (e) {
      samples.push({ error: String(e?.message ?? e) });
      continue;
    }
    samples.push({
      wall_ms: null,
      took_us: res.took_us ?? null,
      read: res.read ?? null,
      candidates: res.candidates ?? null,
      complete: res.complete ?? null,
      n: (res.files ?? []).length,
    });
  }
  rows.push({ id: q.id, lane: q.lane, op: mode === "semantic" ? "semantic" : `grep:${mode}`, query: q.query, samples });
}
client.close();

const artifact = {
  meta: {
    suite: "wave3-work-probe",
    label: LABEL,
    generated_at: new Date().toISOString(),
    rounds: ROUNDS,
    engine: process.env.ULTRASEARCH_ENGINE_BIN ?? path.join(REPO, "engine", "target", "release", "ultrasearch"),
    engine_sha256: (() => {
      const p = process.env.ULTRASEARCH_ENGINE_BIN ?? path.join(REPO, "engine", "target", "release", "ultrasearch");
      return fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : null;
    })(),
    corpus: ROOT,
    note: "read/candidates/took_us come from the daemon's own answer; they are invariant under host load, unlike wall-clock",
  },
  rows,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
console.log(JSON.stringify({ out: OUT, engine_sha: artifact.meta.engine_sha256?.slice(0, 16), rows: rows.length }, null, 1));
