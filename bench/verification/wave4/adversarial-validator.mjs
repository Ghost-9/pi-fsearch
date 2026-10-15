#!/usr/bin/env node
// bench/verification/wave4/adversarial-validator.mjs — the wave-4 verifier's
// adversarial pass over the SHIPPED validator (bench/wave4/validate-judgments.mjs).
//
// Runs the validator CLI and its own test file, then attempts to fool the
// validator with the verifier's own mutations: an unsatisfiable expectation of
// every lane kind, an `absent-string` removal that hides a real match, a grade
// change on a re-homing, a vanished expectation, a window removal whose rank is
// inside the top 10, and a few structural mutations. Every case must FAIL the
// validator, with the expected error code.
//
//   node bench/verification/wave4/adversarial-validator.mjs [--out <json>]

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateJudgments } from "../../wave4/validate-judgments.mjs";
import { corpusReader, findCorpus } from "../../wave4/amendment.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = opt("out", path.join(HERE, "results", "adversarial.json"));
const V1_PATH = path.join(REPO, "bench", "judgments", "wave1-judgments.json");
const V2_PATH = path.join(REPO, "bench", "judgments", "wave1-judgments.v2.json");
const clone = (o) => JSON.parse(JSON.stringify(o));
const v1 = JSON.parse(fs.readFileSync(V1_PATH, "utf8"));
const v2 = JSON.parse(fs.readFileSync(V2_PATH, "utf8"));
const corpus = corpusReader(findCorpus(null));
const ctx = { corpus, v1 };

// ---------------------------------------------------------------- CLI + tests
const run = (cmd, args) => {
  try {
    const out = execFileSync(cmd, args, { cwd: REPO, encoding: "utf8", timeout: 120000, env: { ...process.env, PI_ULTRASEARCH_TEST: "1" } });
    return { exit: 0, out, tail: out.slice(-4000) };
  } catch (e) {
    const out = String(e.stdout ?? "");
    return { exit: e.status ?? -1, out, tail: out.slice(-4000), err: String(e.stderr ?? "").slice(-2000) };
  }
};
const shippedCli = run("node", ["bench/wave4/validate-judgments.mjs", "--json"]);
let shippedCliJson = null;
try {
  shippedCliJson = JSON.parse(shippedCli.out);
} catch {
  /* keep raw */
}
const shippedTests = run("node", ["--test", "bench/wave4/validate-judgments.test.mjs"]);
const testSummary = {
  exit: shippedTests.exit,
  tests: Number((shippedTests.out.match(/^ℹ tests (\d+)/m) ?? [])[1] ?? null),
  pass: Number((shippedTests.out.match(/^ℹ pass (\d+)/m) ?? [])[1] ?? null),
  fail: Number((shippedTests.out.match(/^ℹ fail (\d+)/m) ?? [])[1] ?? null),
  skipped: Number((shippedTests.out.match(/^ℹ skipped (\d+)/m) ?? [])[1] ?? null),
};

// ---------------------------------------------------------------- baseline
const baseline = validateJudgments(v2, { ...ctx, v1Sha256: null });
const v1AsSet = validateJudgments(v1, { corpus });
const v1Unsatisfiable = v1AsSet.errors.filter((e) => e.code === "unsatisfiable");

// Pick corpus files that are known not to contain a term, for the mutations.
const fileWithout = (term) => {
  for (const p of ["README.md", "AUDIT-2026-10-14.md", "CHANGELOG.md", "OPTIMIZATIONS.md", "CONTRIBUTING.md", "ROADMAP.md"]) {
    const t = corpus.text(p);
    if (t !== null && !t.includes(term) && !t.toLowerCase().includes(term.toLowerCase())) return p;
  }
  return null;
};

/** Deep-clone v2 and apply a mutation; must make the validator fail. */
const cases = [];
const addCase = (name, expectCodes, mutate, opts = {}) => {
  const set = clone(v2);
  mutate(set);
  const result = validateJudgments(set, { ...ctx, v1Sha256: opts.v1Sha256 ?? null });
  const codes = result.errors.map((e) => e.code);
  const ok = !result.ok && expectCodes.every((c) => codes.includes(c));
  cases.push({ name, expectCodes, got_codes: [...new Set(codes)], pass: ok, ok: result.ok, errors: result.errors.slice(0, 3) });
};

// 1. unsatisfiable expectation per lane kind ---------------------------------
addCase("unsatisfiable-path", ["unsatisfiable"], (s) => {
  const q = s.queries.find((x) => x.id === "P1");
  q.expected.push({ path: "src/client.ts", grade: 1 }); // path does not match `package.json`
});
addCase("unsatisfiable-content-literal", ["unsatisfiable"], (s) => {
  const q = s.queries.find((x) => x.id === "G4"); // query `fsearch.sock`
  const target = fileWithout("fsearch.sock");
  q.expected.push({ path: target, grade: 1 });
});
addCase("unsatisfiable-content-regex", ["unsatisfiable"], (s) => {
  const q = s.queries.find((x) => x.id === "R1"); // query `class\s+\w+Client`
  q.query = "zzz_no_such_regex_match_zzz"; // matches nothing in the corpus
  q.expected.push({ path: "src/client.ts", grade: 1 });
});
addCase("unsatisfiable-declaration", ["unsatisfiable"], (s) => {
  const q = s.queries.find((x) => x.id === "S1"); // symbol FSearchClient
  q.expected.push({ path: "test/client.test.ts", grade: 2 }); // reference, not declaration
});
addCase("unsatisfiable-semantic-no-tokens", ["unsatisfiable"], (s) => {
  const q = s.queries.find((x) => x.id === "M1");
  q.query = "what is it"; // no distinctive token after the stopword filter
});

// 2. absent-string removal that hides a real match ---------------------------
addCase("removal-hides-match", ["removal-hides-match"], (s) => {
  const r = s.removed.find((x) => x.class === "content-mention-not-top10"); // K3/README.md
  r.class = "absent-string";
});

// 3. grade change on a re-homing --------------------------------------------
addCase("grade-changed", ["grade-changed"], (s) => {
  s.rehomings[0].grade = s.rehomings[0].grade + 1;
});

// 4. a vanished expectation -------------------------------------------------
addCase("unaccounted-expectation", ["unaccounted"], (s) => {
  const q = s.queries.find((x) => x.id === "P3"); // v1 expects src/client.ts (3) + test/client.test.ts (2)
  q.expected = q.expected.filter((e) => e.path !== "src/client.ts");
});

// 5. window removal whose rank is inside the top 10 --------------------------
addCase("removal-window-rank", ["removal-window"], (s) => {
  const r = s.removed.find((x) => x.class === "content-mention-not-top10");
  r.evidence.lane_probe.rank = 5;
});

// 6. structural mutations the validator already claims to catch --------------
addCase("removal-no-evidence", ["removal-evidence"], (s) => {
  const r = s.removed.find((x) => x.class === "content-mention-not-top10");
  delete r.evidence.rg_command;
});
addCase("duplicate-expectation", ["duplicate"], (s) => {
  const q = s.queries.find((x) => x.id === "P1");
  q.expected.push({ ...q.expected[0] });
});
addCase("negative-with-grade1", ["negative"], (s) => {
  const q = s.queries.find((x) => x.negative === true);
  q.expected.push({ path: "README.md", grade: 1 });
});
addCase("empty-must-hit", ["empty-must-hit"], (s) => {
  const q = s.queries.find((x) => x.must_hit === true && x.negative !== true);
  q.expected = [];
});
addCase("symbol-lane-with-literal-mode", ["mode"], (s) => {
  const q = s.queries.find((x) => x.lane === "symbol");
  q.params = { ...(q.params ?? {}), mode: "literal" };
});
addCase("unknown-lane", ["lane"], (s) => {
  s.queries[0].lane = "nota-lane";
});

// ---------------------------------------------------------------- v1 supersedes sha
const v1Sha = execFileSync("shasum", ["-a", "256", V1_PATH], { encoding: "utf8" }).split(" ")[0];
const supersedesMismatch = validateJudgments(v2, { corpus, v1, v1Sha256: "0".repeat(64) });

const out = {
  suite: "wave4-adversarial-validator",
  generated_at: new Date().toISOString(),
  shipped_cli: { exit: shippedCli.exit, ok: shippedCliJson?.ok ?? null, errors: shippedCliJson?.errors?.length ?? null, warnings: shippedCliJson?.warnings?.length ?? null, v1_sha256_matches_recorded: shippedCliJson?.v1_sha256_matches_recorded ?? null },
  shipped_tests: testSummary,
  baseline: { ok: baseline.ok, errors: baseline.errors.length, warnings: baseline.warnings.length, stats: baseline.stats },
  v1_against_validator: { ok: v1AsSet.ok, unsatisfiable_errors: v1Unsatisfiable.length, codes: [...new Set(v1AsSet.errors.map((e) => e.code))] },
  supersedes_sha_guard: { fails_on_wrong_v1_sha: supersedesMismatch.errors.some((e) => e.code === "supersedes-sha") },
  cases,
  cases_passed: cases.filter((c) => c.pass).length,
  cases_total: cases.length,
  v1_sha256: v1Sha,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ out: path.relative(REPO, OUT), shipped_cli: out.shipped_cli, shipped_tests: testSummary, baseline: out.baseline, v1_unsatisfiable: out.v1_against_validator, cases_passed: `${out.cases_passed}/${out.cases_total}`, failed_cases: cases.filter((c) => !c.pass).map((c) => c.name) }, null, 2));
