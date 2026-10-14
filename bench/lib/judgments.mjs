/**
 * Judgment-set evaluation for the benchmark harness (advisor finding #6).
 *
 * The judgment file is authored by wave1/advisor and lives at
 * bench/judgments/wave1-judgments.json once it lands on main. Until then the
 * loader also looks in sibling worktrees of this checkout, so the harness works
 * before the merge and prefers the repo copy afterwards.
 *
 * Metrics: recall@k, MRR@10, nDCG@10, zero-result rate, false-positive rate,
 * reformulation signal — matching the `metrics` block of the judgment file.
 */
import * as fs from "node:fs";
import * as path from "node:path";

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

export function findJudgmentsFile(repoRoot) {
  const parent = path.dirname(repoRoot);
  const candidates = [
    process.env.PI_ULTRASEARCH_JUDGMENTS,
    path.join(repoRoot, "bench/judgments/wave1-judgments.json"),
    ...safeReaddir(parent).map((d) => path.join(parent, d, "bench/judgments/wave1-judgments.json")),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function loadJudgments(repoRoot) {
  const file = findJudgmentsFile(repoRoot);
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return { file, data };
  } catch (err) {
    return { file, error: `failed to parse ${file}: ${err?.message ?? err}` };
  }
}

/** Repo-relative path for a result path, tolerant of realpath differences. */
export function toRepoRelative(corpusRoot, p) {
  let resolved = path.resolve(p);
  for (const candidate of [path.resolve(p), path.resolve(corpusRoot, p)]) {
    try {
      resolved = fs.realpathSync(candidate);
      break;
    } catch {
      // keep the textual path
    }
  }
  let root = path.resolve(corpusRoot);
  try {
    root = fs.realpathSync(root);
  } catch {}
  const rel = path.relative(root, resolved);
  return rel.startsWith("..") ? path.resolve(p).split(path.sep).slice(-2).join("/") : rel.split(path.sep).join("/");
}

export function gradeMapFor(expected = []) {
  const map = new Map();
  for (const e of expected) map.set(e.path.replace(/^\.\//, ""), e.grade);
  return map;
}

function dcgAt(gains, k) {
  let sum = 0;
  for (let i = 0; i < Math.min(gains.length, k); i++) {
    sum += (2 ** gains[i] - 1) / Math.log2(i + 2);
  }
  return sum;
}

function ndcgAt(gains, idealGains, k) {
  const ideal = dcgAt([...idealGains].sort((a, b) => b - a), k);
  if (ideal === 0) return 1;
  return dcgAt(gains, k) / ideal;
}

/**
 * Scores one query. `resultPaths` is the ordered ranked list of repo-relative
 * result paths (deduped, best first).
 */
export function scoreQuery(query, resultPaths) {
  const grades = gradeMapFor(query.expected);
  const gains = resultPaths.map((p) => grades.get(p) ?? 0);
  const idealGains = (query.expected ?? []).map((e) => e.grade);

  const recallAt = {};
  for (const k of [1, 3, 5, 10]) {
    const relevant = new Set(idealGains.map((g, i) => [query.expected[i].path, g]).filter(([, g]) => g >= 2).map(([p]) => p));
    if (relevant.size === 0) {
      recallAt[k] = 1;
      continue;
    }
    let hits = 0;
    for (const p of resultPaths.slice(0, k)) if (relevant.has(p)) hits++;
    recallAt[k] = hits / relevant.size;
  }

  let mrr10 = 0;
  for (let i = 0; i < Math.min(resultPaths.length, 10); i++) {
    if ((grades.get(resultPaths[i]) ?? 0) >= 2) {
      mrr10 = 1 / (i + 1);
      break;
    }
  }

  return {
    id: query.id,
    lane: query.lane,
    difficulty: query.difficulty,
    query: query.query,
    resultCount: resultPaths.length,
    top1Grade: gains.length > 0 ? gains[0] : null,
    top1Path: resultPaths[0] ?? null,
    top5Paths: resultPaths.slice(0, 5),
    gains: gains.slice(0, 10),
    recallAt,
    mrr10,
    ndcg10: ndcgAt(gains, idealGains, 10),
    zeroResult: resultPaths.length === 0,
    mustHit: query.must_hit !== false,
    negative: query.negative === true || query.must_hit === false,
  };
}

export function aggregateJudgments(rows, judgments) {
  const must = rows.filter((r) => r.mustHit);
  const negatives = rows.filter((r) => r.negative);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const laneNames = [...new Set(rows.map((r) => r.lane))];
  const perLane = {};
  for (const lane of laneNames) {
    const laneRows = rows.filter((r) => r.lane === lane);
    const laneMust = laneRows.filter((r) => r.mustHit);
    perLane[lane] = {
      queries: laneRows.length,
      recallAt10: mean(laneMust.map((r) => r.recallAt[10])),
      mrr10: mean(laneMust.map((r) => r.mrr10)),
      ndcg10: mean(laneMust.map((r) => r.ndcg10)),
      zeroResultRate: laneMust.length ? laneMust.filter((r) => r.zeroResult).length / laneMust.length : 0,
      falsePositiveRate: laneRows.filter((r) => r.negative).length
        ? laneRows.filter((r) => r.negative && r.resultCount > 0).length / laneRows.filter((r) => r.negative).length
        : 0,
      reformulationSignal: laneMust.length ? laneMust.filter((r) => (r.top1Grade ?? 0) < 2).length / laneMust.length : 0,
    };
  }

  const aggregate = {
    queries: rows.length,
    mustHitQueries: must.length,
    negativeQueries: negatives.length,
    // Headline gates scored on every run (verifier baseline set).
    recallAt1: mean(must.map((r) => r.recallAt[1])),
    recallAt3: mean(must.map((r) => r.recallAt[3])),
    recallAt5: mean(must.map((r) => r.recallAt[5])),
    recallAt10: mean(must.map((r) => r.recallAt[10])),
    mrr10: mean(must.map((r) => r.mrr10)),
    ndcg10: mean(must.map((r) => r.ndcg10)),
    zeroResultRate: must.length ? must.filter((r) => r.zeroResult).length / must.length : 0,
    falsePositiveRate: negatives.length ? negatives.filter((r) => r.resultCount > 0).length / negatives.length : 0,
    recallAt: {
      1: mean(must.map((r) => r.recallAt[1])),
      3: mean(must.map((r) => r.recallAt[3])),
      5: mean(must.map((r) => r.recallAt[5])),
      10: mean(must.map((r) => r.recallAt[10])),
    },
    reformulationSignal: must.length ? must.filter((r) => (r.top1Grade ?? 0) < 2).length / must.length : 0,
    perLane,
  };

  // Baseline values supplied by the verifier (provisional/directional). A run
  // "beats" the baseline when recall/nDCG are >= and the false-positive rate is <=.
  const BASELINE = { recallAt10: 0.674, ndcg10: 0.705, falsePositiveRate: 0.5 };
  const baselineComparison = {
    source: "verifier baseline (provisional, directional)",
    recallAt10: { baseline: BASELINE.recallAt10, value: aggregate.recallAt10, delta: aggregate.recallAt10 - BASELINE.recallAt10, beats: aggregate.recallAt10 >= BASELINE.recallAt10 },
    ndcg10: { baseline: BASELINE.ndcg10, value: aggregate.ndcg10, delta: aggregate.ndcg10 - BASELINE.ndcg10, beats: aggregate.ndcg10 >= BASELINE.ndcg10 },
    falsePositiveRate: { baseline: BASELINE.falsePositiveRate, value: aggregate.falsePositiveRate, delta: BASELINE.falsePositiveRate - aggregate.falsePositiveRate, beats: aggregate.falsePositiveRate <= BASELINE.falsePositiveRate },
  };

  const checks = [
    { name: "recall@10 == 1.00 on must-hit queries", value: aggregate.recallAt10, threshold: 1.0, pass: aggregate.recallAt10 >= 1.0 - 1e-9 },
    { name: "zero_result_rate == 0.00 on must-hit queries", value: aggregate.zeroResultRate, threshold: 0.0, pass: aggregate.zeroResultRate === 0 },
    { name: "false_positive_rate == 0.00 on negative queries", value: aggregate.falsePositiveRate, threshold: 0.0, pass: aggregate.falsePositiveRate === 0 },
    { name: "nDCG@10 >= 0.75 overall", value: aggregate.ndcg10, threshold: 0.75, pass: aggregate.ndcg10 >= 0.75 },
    {
      name: "nDCG@10 >= 0.60 semantic lane",
      value: perLane.semantic?.ndcg10 ?? null,
      threshold: 0.6,
      pass: (perLane.semantic?.ndcg10 ?? 1) >= 0.6,
    },
    { name: "reformulation_signal <= 0.20 overall", value: aggregate.reformulationSignal, threshold: 0.2, pass: aggregate.reformulationSignal <= 0.2 },
  ];

  return {
    aggregate,
    baselineComparison,
    checks,
    pass: checks.every((c) => c.pass),
    source: judgments?.file ?? null,
    schema: judgments?.data?.schema ?? null,
    corpus: judgments?.data?.corpus ?? null,
  };
}
