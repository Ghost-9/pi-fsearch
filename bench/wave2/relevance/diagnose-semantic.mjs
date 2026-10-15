// bench/wave2/relevance/diagnose-semantic.mjs
// Fast iteration harness for the semantic lane (not an acceptance instrument).
//   PI_ULTRASEARCH_TEST=1 node bench/wave2/relevance/diagnose-semantic.mjs
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
process.env.PI_ULTRASEARCH_TEST = "1";

const root = path.join(os.homedir(), ".cache", "pi-ultrasearch-bench", "corpus-0a16e50");
const judgments = JSON.parse(fs.readFileSync(path.join(REPO, "bench/judgments/wave1-judgments.json"), "utf8"));
const { UltraSearchClient } = await import(pathToFileURL(path.join(REPO, "src/client.ts")).href);
const { searchSemanticIntent } = await import(pathToFileURL(path.join(REPO, "src/semantic.ts")).href);

const only = process.argv[2];
const client = new UltraSearchClient({ timeoutMs: 20000 });
const norm = (p) => (p.startsWith(root) ? p.slice(root.length).replace(/^\//, "") : p);

function ndcg(retrieved, expected, k = 10) {
  const grades = new Map(expected.map((e) => [e.path, e.grade]));
  const dcg = (list) => list.reduce((a, g, i) => a + (Math.pow(2, g) - 1) / Math.log2(i + 2), 0);
  const top = retrieved.slice(0, k).map((p) => grades.get(p) ?? 0);
  const ideal = [...expected.map((e) => e.grade)].sort((a, b) => b - a);
  return { ndcg: dcg(top) / dcg(ideal), top };
}

for (const q of judgments.queries) {
  if (q.lane !== "semantic" || (only && q.id !== only)) continue;
  const t0 = performance.now();
  const res = await searchSemanticIntent(client, q.query, { in: root, limit: q.params?.limit ?? 10 });
  const ms = performance.now() - t0;
  const got = (res.files ?? []).map((f) => norm(f.path));
  const ev = res.evidence;
  const { ndcg: n, top } = ndcg(got, q.expected);
  console.log(`\n== ${q.id} "${q.query}" (${ms.toFixed(0)} ms) nDCG=${n.toFixed(3)} conf=${res.confidence.toFixed(2)} abstain=${!!ev?.abstained}`);
  console.log(`   groups:`, ev?.groups.map((g) => `${g.id}${g.present ? "✓" : "✗"}${g.generic ? "~" : ""}(df=${g.df})`).join(" "));
  console.log(`   coverage=${ev?.coverage_ratio.toFixed(2)} reason=${ev?.reason}`);
  q.expected.forEach((e, i) => {
    const pos = got.indexOf(e.path);
    console.log(`   exp${i} g${e.grade} ${e.path} -> ${pos >= 0 ? "#" + (pos + 1) : "MISS"}`);
  });
  console.log(`   top:`, got.slice(0, 10).map((p, i) => `${i + 1}.${p}`).join(" "));
  if (ev?.ranking) {
    console.log(`   score:`, ev.ranking.slice(0, 6).map((r) => `${r.path.split("/").pop()}=${r.score}`).join(" "));
    const watch = new Set([...q.expected.map((e) => e.path), ...ev.ranking.slice(0, 3).map((r) => r.path.replace(root + "/", ""))]);
    for (const p of watch) {
      const r = ev.ranking.find((x) => x.path.endsWith("/" + p));
      if (r) console.log(`   contrib ${p}:`, r.contributions.map((c) => `${c.group}[p${c.primary} s${c.synonym} f${c.path} d${c.declared}]`).join(" "));
      else if (got.includes(p)) console.log(`   contrib ${p}: (outside top10, score unknown)`);
    }
  }
}
client.close();
