#!/usr/bin/env node
// bench/wave4/validate-judgments.mjs — prove a judgment set is scorable before it
// is scored: every must-hit expectation must be satisfiable in the lane it is
// declared in, every removal must carry a proof, and (against v1) every v1
// expectation must be accounted for.
//
//   node bench/wave4/validate-judgments.mjs [--set bench/judgments/wave1-judgments.v2.json]
//                                          [--corpus <dir>] [--json]
//
// Exit 0 = valid; exit 1 = at least one error (each printed with its evidence).
//
// The checks are data checks against the frozen corpus, not run results:
//   path lane          the expectation's path matches the query (glob or tokens)
//   content lane       the query occurs in the file's content (literal: exact
//                      case, matching the engine; regex: a matching line)
//   symbol lane        the file contains a declaration, not just a reference
//                      (the wave-2 declarations-first contract)
//   semantic lane      the file shares a distinctive token with the intent
//                      (weaker witness; semantic intents are not string matches)
// and for `removed`:
//   absent-string            the file must NOT contain the term (cs and ci)
//   content-mention-not-top10 the file MUST contain the term and the measured
//                            rank in a lane that can match it must be > 10

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  V1_PATH, V1_SHA256, LANE_KIND, laneKind, satisfiable, pathMatches,
  semanticTokens, semanticSatisfiable, corpusReader, findCorpus,
} from "./amendment.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

/** Validate one judgment set. Pure function: the CLI and the tests share it. */
export function validateJudgments(judgments, { corpus, v1 = null, v1Sha256 = null } = {}) {
  const errors = [];
  const warnings = [];
  const stats = { rows: judgments.queries.length, mustHitRows: 0, expectations: 0, removed: (judgments.removed ?? []).length, checked: 0 };
  const err = (code, msg) => errors.push({ code, msg });

  const kindOf = (lane) => LANE_KIND[lane] ?? null;
  if (judgments.schema && !/^ultrasearch\.judgments\/v\d+$/.test(judgments.schema)) err("schema", `unrecognised schema ${JSON.stringify(judgments.schema)}`);
  if (judgments.version >= 2 && judgments.supersedes) {
    if (v1Sha256 && judgments.supersedes.sha256 !== v1Sha256) err("supersedes-sha", `supersedes.sha256 ${judgments.supersedes.sha256} != actual v1 sha256 ${v1Sha256}`);
  }

  for (const q of judgments.queries) {
    if (!kindOf(q.lane)) { err("lane", `${q.id}: unknown lane ${JSON.stringify(q.lane)}`); continue; }
    if (q.must_hit === true && q.negative !== true) stats.mustHitRows += 1;
    const kind = kindOf(q.lane);
    if (kind === "declaration" && q.params?.mode !== undefined && q.params.mode !== "symbol") err("mode", `${q.id}: ${q.lane} lane with params.mode=${JSON.stringify(q.params.mode)}`);
    if (kind === "semantic" && q.params?.mode !== undefined && q.params.mode !== "semantic") err("mode", `${q.id}: semantic lane with params.mode=${JSON.stringify(q.params.mode)}`);
    if (q.negative === true && (q.expected ?? []).some((e) => e.grade >= 1)) err("negative", `${q.id}: a negative query must have no expected grade>=1 files`);
    if (q.must_hit === true && q.negative !== true && !(q.expected ?? []).some((e) => e.grade >= 1)) err("empty-must-hit", `${q.id}: a must-hit query declares no grade>=1 expectation`);
    const seen = new Set();
    for (const e of q.expected ?? []) {
      if (seen.has(e.path)) err("duplicate", `${q.id}: ${e.path} appears twice in one expected list`);
      seen.add(e.path);
      if (e.grade < 1) continue;
      stats.expectations += 1;
      if (q.must_hit !== true || q.negative === true) continue;
      const text = corpus.text(e.path);
      const exists = corpus.exists(e.path);
      const v = satisfiable(q, e.path, text, exists);
      stats.checked += 1;
      if (!v.ok) err("unsatisfiable", `${q.id} (${q.lane}, ${JSON.stringify(q.query)}): ${e.path} is not satisfiable in its lane — ${v.why}`);
      if (v.kind === "semantic" && exists && !semanticTokens(q.query).some((t) => text.toLowerCase().includes(t))) {
        warnings.push(`${q.id}: ${e.path} shares no distinctive token with the intent ${JSON.stringify(q.query)} (allowed for an intent lane; recorded for review)`);
      }
    }
  }

  for (const r of judgments.removed ?? []) {
    const text = corpus.text(r.path);
    if (text === null) { err("removal-missing", `${r.id}: removed expectation ${r.path} is not in the frozen corpus`); continue; }
    if (!r.why) err("removal-why", `${r.id}: removed expectation ${r.path} has no stated reason`);
    if (!r.evidence || !r.evidence.rg_command) err("removal-evidence", `${r.id}: removed expectation ${r.path} has no rg evidence`);
    const cs = text.split(r.query).length - 1;
    const ci = text.toLowerCase().split(String(r.query).toLowerCase()).length - 1;
    if (r.class === "absent-string") {
      if (cs !== 0 || ci !== 0) err("removal-hides-match", `${r.id}: ${r.path} DOES contain ${JSON.stringify(r.query)} (cs=${cs}, ci=${ci}); an absent-string removal must not hide a match`);
      if (cs !== r.evidence?.occurrences_case_sensitive || ci !== r.evidence?.occurrences_case_insensitive) err("removal-evidence-count", `${r.id}: recorded occurrence counts do not match the corpus (recorded cs=${r.evidence?.occurrences_case_sensitive}, actual ${cs})`);
    } else if (r.class === "content-mention-not-top10") {
      if (cs < 1 && ci < 1) err("removal-not-mention", `${r.id}: ${r.path} does not contain ${JSON.stringify(r.query)}; a window removal must be a real content mention`);
      const probe = r.evidence?.lane_probe;
      if (!probe || !(probe.rank > 10)) err("removal-window", `${r.id}: ${r.path} has no measured rank outside the top 10 (probe: ${JSON.stringify(probe)}); a rank inside the window would make the removal unjustified`);
    } else {
      err("removal-class", `${r.id}: ${r.path} has unknown removal class ${JSON.stringify(r.class)}`);
    }
  }

  if (v1) {
    const v2ById = Object.fromEntries(judgments.queries.map((q) => [q.id, q]));
    const rehomed = new Set((judgments.rehomings ?? []).map((r) => `${r.id}|${r.expected_path}`));
    const removed = new Set((judgments.removed ?? []).map((r) => `${r.id}|${r.path}`));
    for (const q of v1.queries) {
      if (!(q.must_hit === true && q.negative !== true)) continue;
      for (const e of (q.expected ?? []).filter((x) => x.grade >= 1)) {
        const row = v2ById[q.id];
        const kept = (row?.expected ?? []).some((x) => x.path === e.path);
        if (!kept && !rehomed.has(`${q.id}|${e.path}`) && !removed.has(`${q.id}|${e.path}`)) {
          err("unaccounted", `v1 expectation ${q.id}/${e.path} is neither retained, re-homed, nor removed — an expectation must not disappear silently`);
        }
        const rh = (judgments.rehomings ?? []).find((r) => r.id === q.id && r.expected_path === e.path);
        if (rh && rh.grade !== e.grade) err("grade-changed", `${q.id}/${e.path}: grade changed ${e.grade} -> ${rh.grade}; a lane change must not change the relevance judgment`);
        const rm = (judgments.removed ?? []).find((r) => r.id === q.id && r.path === e.path);
        if (rm && rm.grade !== e.grade) err("grade-changed", `${q.id}/${e.path}: removed with grade ${rm.grade}, v1 has ${e.grade}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, stats, corpus: corpus?.root ?? null };
}

// ----------------------------------------------------------------- CLI

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const opt = (n, d = null) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const SET = path.resolve(REPO, opt("set", "bench/judgments/wave1-judgments.v2.json"));
  const CORPUS = findCorpus(opt("corpus"));
  const judgments = JSON.parse(fs.readFileSync(SET, "utf8"));
  const v1Path = path.join(REPO, V1_PATH);
  const v1Bytes = fs.existsSync(v1Path) ? fs.readFileSync(v1Path) : null;
  const v1Sha = v1Bytes ? crypto.createHash("sha256").update(v1Bytes).digest("hex") : null;
  const v1 = v1Bytes ? JSON.parse(v1Bytes.toString("utf8")) : null;
  const result = validateJudgments(judgments, { corpus: corpusReader(CORPUS), v1, v1Sha256: v1Sha });
  const out = {
    set: path.relative(REPO, SET),
    sha256: crypto.createHash("sha256").update(fs.readFileSync(SET)).digest("hex"),
    corpus: CORPUS,
    v1_sha256: v1Sha,
    v1_sha256_matches_recorded: v1Sha === V1_SHA256,
    ...result,
  };
  if (argv.includes("--json")) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`${result.ok ? "VALID" : "INVALID"}  ${out.set}`);
    console.log(`  rows ${result.stats.rows} (must-hit ${result.stats.mustHitRows}) · grade>=1 expectations checked ${result.stats.checked}/${result.stats.expectations} · removed ${result.stats.removed}`);
    for (const e of result.errors) console.log(`  ERROR [${e.code}] ${e.msg}`);
    for (const w of result.warnings) console.log(`  warn  ${w}`);
  }
  process.exit(result.ok ? 0 : 1);
}
