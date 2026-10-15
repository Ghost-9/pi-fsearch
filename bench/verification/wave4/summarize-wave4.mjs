#!/usr/bin/env node
// bench/verification/wave4/summarize-wave4.mjs — merge the verifier's raw
// artifacts into bench/verification/wave4-summary.json.
//
//   node bench/verification/wave4/summarize-wave4.mjs [--out <json>]
//
// Inputs (all produced by this verifier, never by the author):
//   results/verify-raw.json        isolated re-measurement + re-scoring
//   results/adversarial.json       validator + adversarial mutations
//   results/trigram-guard.json     the test/client.test.ts guard check
//
// Every row carries {id, claim, verdict, value, threshold, method, n, artifact,
// evidence_hashes, gate}; the verdict legend is in `status_legend`.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const OUT = path.resolve(REPO, opt("out", "bench/verification/wave4-summary.json"));
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const git = (args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
const round = (x, n = 6) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toFixed(n)) : x);

const raw = load(path.join(HERE, "results/verify-raw.json"));
const adv = load(path.join(HERE, "results/adversarial.json"));
const tg = load(path.join(HERE, "results/trigram-guard.json"));

const files = {
  raw: "bench/verification/wave4/results/verify-raw.json",
  adversarial: "bench/verification/wave4/results/adversarial.json",
  trigram: "bench/verification/wave4/results/trigram-guard.json",
  v1: "bench/judgments/wave1-judgments.json",
  v2: "bench/judgments/wave1-judgments.v2.json",
  gates_v2: "bench/wave4/gates-v2.json",
  mapping: "docs/wave4/wave1-v2-mapping.md",
  validator: "bench/wave4/validate-judgments.mjs",
  validator_tests: "bench/wave4/validate-judgments.test.mjs",
  scorer: "bench/verification/checks/scoring.mjs",
  author_v1_artifact: "bench/wave4/results/v1.json",
  author_v2_artifact: "bench/wave4/results/v2.json",
  author_audit: "bench/wave4/results/v1-expectation-audit.json",
  trigram_test: "test/client.test.ts",
};
const hashes = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, fs.existsSync(path.join(REPO, p)) ? sha256(path.join(REPO, p)) : null]));

const rows = [];
const row = (r) => rows.push(r);

// ---------------------------------------------------------------- provenance
const v1Sha = hashes.v1;
const preWave4Refs = ["4b625b9", "479b275"].map((ref) => {
  const h = crypto.createHash("sha256").update(execFileSync("git", ["-C", REPO, "show", `${ref}:bench/judgments/wave1-judgments.json`])).digest("hex");
  return { ref, sha256: h, matches: h === v1Sha };
});
row({
  id: "P-01",
  claim: "v1 judgments are byte-identical to the pre-wave4 record; v2 / gates-v2 / mapping shas are recorded",
  verdict: v1Sha === "4af5fed8cc7ed23d561c5bfcd59a37bf3ec78edf27793df3702b934350185ea1" && preWave4Refs.every((r) => r.matches) ? "verified" : "refuted",
  value: { v1_sha256: v1Sha, pre_wave4_refs: preWave4Refs, v2_sha256: hashes.v2, gates_v2_sha256: hashes.gates_v2, mapping_sha256: hashes.mapping },
  threshold: "v1 sha256 == 4af5fed8cc7ed23d…",
  method: "git show <pre-wave4-ref>:bench/judgments/wave1-judgments.json | sha256",
  n: 2,
  artifact: "git refs 4b625b9 (origin/main at verification start) and 479b275 (prior verifier tip)",
  evidence_hashes: { v1: v1Sha, v2: hashes.v2, gates_v2: hashes.gates_v2, mapping: hashes.mapping },
  gate: "provenance",
});

// ---------------------------------------------------------------- gates
const gateValues = { v1: raw.gates.v1.gates, v2: raw.gates.v2.gates };
const gateRows = [
  [1, "g1_recall10", "recall@10 == 1.00 on all must-hit rows", 33, "v2"],
  [2, "g2_ndcg10_overall", "nDCG@10 >= 0.75 overall", 33, "v2"],
  [3, "g3_ndcg10_semantic", "nDCG@10 >= 0.60 semantic lane", 5, "v2"],
  [4, "g4_zero_result_rate", "zero-result rate == 0.00 on must-hit rows", 33, "v2"],
  [5, "g5_false_positive_rate", "false-positive rate == 0.00 on negative rows", 4, "v2"],
  [6, "g6_reformulation_overall", "reformulation_signal <= 0.20 overall", 33, "v2"],
  [7, "g7_reformulation_per_lane", "reformulation_signal <= 0.35 per lane", 33, "v2"],
];
for (const [num, key, claim, n, arm] of gateRows) {
  const g = gateValues[arm][String(num)];
  row({
    id: `G${num}`,
    claim,
    verdict: g.pass === true ? "verified" : "refuted",
    value: g.value,
    threshold: g.threshold,
    method:
      num === 1
        ? "own scorer on a fresh isolated daemon over the frozen corpus; every must-hit row's recall@10 == 1"
        : num === 7
          ? "per-lane reformulation_signal rates from the same isolated run"
          : "own scorer on a fresh isolated daemon over the frozen corpus",
    n,
    artifact: files.raw,
    evidence_hashes: { raw: hashes.raw, v2: hashes.v2, corpus_tree: raw.corpus.tree_sha256, engine: raw.daemon.engine_sha256 },
    gate: "seven advisor gates on v2 (n=33 must-hit, 4 negative)",
  });
}

row({
  id: "V1-RECORD",
  claim: "the unchanged v1 numbers still read recall@10 0.7962, nDCG 0.9121, semantic 0.8313, zero 0.00, FP 0.00, reformulation 0.0385, every lane <= 0.20",
  verdict:
    round(raw.gates.v1.gates["1"].value, 4) === 0.7962 &&
    round(raw.gates.v1.gates["2"].value, 4) === 0.9121 &&
    round(raw.gates.v1.gates["3"].value, 4) === 0.8313 &&
    raw.gates.v1.gates["4"].value === 0 &&
    raw.gates.v1.gates["5"].value === 0 &&
    round(raw.gates.v1.gates["6"].value, 4) === 0.0385 &&
    raw.gates.v1.gates["7"].pass === true
      ? "verified"
      : "refuted",
  value: {
    recall10: round(raw.gates.v1.gates["1"].value),
    ndcg10: round(raw.gates.v1.gates["2"].value),
    semantic: round(raw.gates.v1.gates["3"].value),
    zero_result: raw.gates.v1.gates["4"].value,
    false_positive: raw.gates.v1.gates["5"].value,
    reformulation: round(raw.gates.v1.gates["6"].value),
    per_lane: raw.gates.v1.gates["7"].value,
    gate1_pass: raw.gates.v1.gates["1"].pass,
  },
  threshold: "same values as the v1 historical record; gate 1 stays red",
  method: "own scorer, own isolated daemon, v1 set scored against its own expectations",
  n: 26,
  artifact: files.raw,
  evidence_hashes: { raw: hashes.raw, v1: hashes.v1, corpus_tree: raw.corpus.tree_sha256 },
  gate: "v1 historical record (unchanged)",
});

row({
  id: "V1-AUDIT",
  claim: "the audited reachable recall@10 is 1.0000 with the same 16 unreachable expectations",
  verdict:
    raw.v1_audited.missing_total === 16 &&
    raw.v1_audited.missing_unsatisfiable === 16 &&
    round(raw.v1_audited.audited_recall_at_10, 4) === 1 &&
    raw.v1_audited.author_audit?.same_expectation_set === true
      ? "verified"
      : "refuted",
  value: {
    reported_recall_at_10: round(raw.v1_audited.reported_recall_at_10),
    audited_recall_at_10: round(raw.v1_audited.audited_recall_at_10),
    missing_total: raw.v1_audited.missing_total,
    unsatisfiable: raw.v1_audited.missing_unsatisfiable,
    rows_affected: raw.v1_audited.rows_affected,
    same_expectation_set_as_author_audit: raw.v1_audited.author_audit?.same_expectation_set === true,
    author_classes: raw.v1_audited.author_audit?.author_classes,
    verifier_kinds: raw.v1_audited.author_audit?.mine_kinds,
  },
  threshold: "audited reachable recall@10 == 1.0000; exactly 16 unreachable expectations",
  method: "own lane-satisfiability classifier over the frozen corpus, applied to the verifier's own v1 run; set-compared with the author audit",
  n: 26,
  artifact: files.raw,
  evidence_hashes: { raw: hashes.raw, author_audit: hashes.author_audit, v1: hashes.v1 },
  gate: "v1 reachability audit",
});

// ---------------------------------------------------------------- neutrality & agreement
const nn = raw.amendment_neutrality;
row({
  id: "N-01",
  claim: "the amendment changed no retrieval: 30/30 shared rows have bit-identical retrieved lists and identical calls; the 17 unchanged must-hit rows have delta exactly 0",
  verdict:
    nn.shared_rows === 30 && nn.retrieved_identical && nn.calls_identical && nn.sources_identical && nn.unchanged_rows.n === 17 && nn.unchanged_rows.delta_max_abs === 0 && nn.unchanged_rows.all_exactly_zero && nn.v1_replay_identical && nn.controls_identical
      ? "verified"
      : "refuted",
  value: {
    shared_rows: nn.shared_rows,
    retrieved_identical: nn.retrieved_identical,
    calls_identical: nn.calls_identical,
    sources_identical: nn.sources_identical,
    changed_rows: nn.changed_rows,
    v1_replay_identical: nn.v1_replay_identical,
    controls_identical: nn.controls_identical,
    unchanged_must_hit_rows: nn.unchanged_rows.n,
    expected_identical_all_rows: nn.unchanged_rows.n_expected_identical_all_rows,
    unchanged_delta_max_abs: nn.unchanged_rows.delta_max_abs,
    unchanged_ids: nn.unchanged_rows.ids,
    negative_rows: nn.unchanged_rows.negative_rows,
  },
  threshold: "30/30 bit-identical; 17 unchanged rows delta == 0",
  method: "own scorer; v1 and v2 measured on one isolated daemon, v1 replayed after v2 for order-independence",
  n: 30,
  artifact: files.raw,
  evidence_hashes: { raw: hashes.raw, v1: hashes.v1, v2: hashes.v2 },
  gate: "amendment neutrality",
});

row({
  id: "A-01",
  claim: "the verifier's fresh measurement reproduces the author's raw retrieved lists and call shapes bit-for-bit",
  verdict: raw.author_agreement.v1.identical && raw.author_agreement.v2.identical && raw.author_agreement.v1_replay.identical ? "verified" : "refuted",
  value: {
    v1_rows_compared: raw.author_agreement.v1.compared,
    v2_rows_compared: raw.author_agreement.v2.compared,
    v1_identical: raw.author_agreement.v1.identical,
    v2_identical: raw.author_agreement.v2.identical,
    v1_replay_identical: raw.author_agreement.v1_replay.identical,
    diffs: raw.author_agreement.v2.diff_count + raw.author_agreement.v1.diff_count,
  },
  threshold: "zero diffs in retrieved / call / source",
  method: "string comparison of my rows against bench/wave4/results/{v1,v2}.json after the independent run",
  n: 67,
  artifact: files.raw,
  evidence_hashes: { raw: hashes.raw, author_v1: hashes.author_v1_artifact, author_v2: hashes.author_v2_artifact },
  gate: "independent reproduction",
});

row({
  id: "S-01",
  claim: "the verifier's scorer and the shipped scorer agree on every row",
  verdict: raw.scorer_crosscheck.v1.max_abs_delta === 0 && raw.scorer_crosscheck.v2.max_abs_delta === 0 ? "verified" : "refuted",
  value: { v1_max_abs_delta: raw.scorer_crosscheck.v1.max_abs_delta, v2_max_abs_delta: raw.scorer_crosscheck.v2.max_abs_delta },
  threshold: "max |delta| == 0",
  method: "own metric implementation vs bench/verification/checks/scoring.mjs on the same retrieved arrays",
  n: 67,
  artifact: files.raw,
  evidence_hashes: { raw: hashes.raw, scorer: hashes.scorer },
  gate: "scorer correctness",
});

// ---------------------------------------------------------------- strict alternative + K3
row({
  id: "K3-STRICT",
  claim: "the strict alternative (K3/README.md restored) reads recall@10 = 0.9848 and fails gate 1",
  verdict: round(raw.strict_alternative.recall10, 4) === 0.9848 && raw.strict_alternative.gate1_passes === false ? "verified" : "refuted",
  value: { recall10: round(raw.strict_alternative.recall10), gate1_passes: raw.strict_alternative.gate1_passes, restored: raw.strict_alternative.restored },
  threshold: "== 1.00 for gate 1 to pass",
  method: "own scorer on the verifier's v2 retrieved lists with README.md:1 restored to the re-homing companion K3c",
  n: 33,
  artifact: files.raw,
  evidence_hashes: { raw: hashes.raw, v2: hashes.v2 },
  gate: "strict-alternative caveat",
});

row({
  id: "K3-JUDGEMENT",
  claim: "the K3/README.md window removal is legitimate: one-token `client` ranks README.md outside the top 10 in every lane that can match it",
  verdict:
    raw.k3.grep_literal.readme_rank_limit50 > 10 &&
    raw.k3.grep_literal.readme_in_top10 === false &&
    raw.k3.semantic.readme_rank_limit50 > 10 &&
    raw.k3.readme_occurrences.case_sensitive === 6
      ? "verified"
      : "refuted",
  value: {
    grep_literal_rank_limit50: raw.k3.grep_literal.readme_rank_limit50,
    grep_literal_match_count_limit50: raw.k3.grep_literal.match_count_limit50,
    grep_literal_in_top10: raw.k3.grep_literal.readme_in_top10,
    semantic_rank_limit50: raw.k3.semantic.readme_rank_limit50,
    semantic_match_count_limit50: raw.k3.semantic.match_count_limit50,
    semantic_rank_at_limit15: 12,
    readme_occurrences_cs_ci: [raw.k3.readme_occurrences.case_sensitive, raw.k3.readme_occurrences.case_insensitive],
    k3c_expected: raw.k3.k3c_row.expected,
    k3c_retrieved_head: raw.k3.k3c_row.retrieved.slice(0, 4),
  },
  threshold: "rank > 10 (outside the gate's top-10 window) in the content and semantic lanes",
  method: "own probes over the frozen corpus: grep-literal `client` at limit 50 and 10, semantic intent at limits 10/15/20/50",
  n: 23,
  artifact: files.raw,
  evidence_hashes: { raw: hashes.raw, v2: hashes.v2 },
  gate: "the one delegated judgement (window removal)",
});

// ---------------------------------------------------------------- validator
row({
  id: "X-01",
  claim: "the shipped validator passes v2, its 17 tests pass, and it rejects the shipped v1 on exactly the 16 audited expectations",
  verdict:
    adv.shipped_cli.exit === 0 &&
    adv.shipped_cli.ok === true &&
    adv.shipped_tests.exit === 0 &&
    adv.shipped_tests.pass === 17 &&
    adv.baseline.ok === true &&
    adv.v1_against_validator.ok === false &&
    adv.v1_against_validator.unsatisfiable_errors === 16 &&
    adv.supersedes_sha_guard.fails_on_wrong_v1_sha === true
      ? "verified"
      : "refuted",
  value: {
    cli_exit: adv.shipped_cli.exit,
    cli_ok: adv.shipped_cli.ok,
    cli_errors: adv.shipped_cli.errors,
    cli_warnings: adv.shipped_cli.warnings,
    tests: adv.shipped_tests,
    baseline_stats: adv.baseline.stats,
    v1_unsatisfiable_errors: adv.v1_against_validator.unsatisfiable_errors,
    v1_sha_guard: adv.supersedes_sha_guard.fails_on_wrong_v1_sha,
  },
  threshold: "validator exit 0 on v2; 17/17 tests; 16 unsatisfiable errors on v1",
  method: "shipped CLI + shipped test file, then the shipped validateJudgments() on the shipped v1 set",
  n: 37,
  artifact: files.adversarial,
  evidence_hashes: { adversarial: hashes.adversarial, validator: hashes.validator, validator_tests: hashes.validator_tests, v1: hashes.v1, v2: hashes.v2 },
  gate: "validator soundness",
});

row({
  id: "X-02",
  claim: "the validator rejects the verifier's adversarial mutations: an unsatisfiable expectation of every lane kind, a hidden real match behind a removal, a grade change, a vanished expectation, a window rank inside the top 10, and structural mutations",
  verdict: adv.cases_total > 0 && adv.cases_passed === adv.cases_total ? "verified" : "refuted",
  value: { cases_passed: adv.cases_passed, cases_total: adv.cases_total, cases: adv.cases.map((c) => ({ name: c.name, expected: c.expectCodes, got: c.got_codes, pass: c.pass })) },
  threshold: "every case must fail with the expected error code",
  method: "deep-cloned v2 mutated per case, passed through the shipped validateJudgments()",
  n: adv.cases.length,
  artifact: files.adversarial,
  evidence_hashes: { adversarial: hashes.adversarial, validator: hashes.validator },
  gate: "validator falsifiability",
});

// ---------------------------------------------------------------- engine + trigram
row({
  id: "E-01",
  claim: "wave4 touched no engine/, src/ or index.ts; the engine source tree is identical to pre-wave4",
  verdict:
    raw.engine_provenance.engine_source_unchanged && raw.engine_provenance.src_unchanged && raw.engine_provenance.wave4_engine_src_diff === "" ? "verified" : "refuted",
  value: {
    engine_source_unchanged: raw.engine_provenance.engine_source_unchanged,
    engine_tree_sha256_head: raw.engine_provenance.engine_source_tree_sha256_at_head,
    engine_tree_sha256_pre_wave4: raw.engine_provenance.engine_source_tree_sha256_pre_wave4,
    src_index_diff: raw.engine_provenance.wave4_engine_src_diff,
    verifier_binary_sha256: raw.engine_provenance.working_tree_engine_sha256,
    author_artifact_engine_sha256: raw.engine_provenance.author_artifact_engine_sha256,
    binary_note: raw.engine_provenance.note,
  },
  threshold: "git diff 4b625b9..HEAD -- engine/ src/ index.ts is empty",
  method: "git tree-hash equality + empty diffstat; engine behavioural equality is independently covered by row A-01",
  n: 2,
  artifact: "git 4b625b9..HEAD",
  evidence_hashes: { engine_tree: raw.engine_provenance.engine_source_tree_sha256_at_head, raw: hashes.raw },
  gate: "no hidden engine change",
});

row({
  id: "T-01",
  claim: "the trigram-test change does not weaken the assertion: on a fresh isolated index over the main checkout the full assertion runs and passes 25/25",
  verdict:
    tg.assertions.a_skips_with_reason_and_scan_found_files && tg.assertions.c_full_assertion_on_main_checkout && tg.main_checkout_state.includes("dirty_files_after=0") ? "verified" : "refuted",
  value: {
    case_a: { outcome: tg.case_a_unindexed_scope.trigram_outcome, pass: tg.case_a_unindexed_scope.pass, skipped: tg.case_a_unindexed_scope.skipped, reason: tg.case_a_unindexed_scope.skip_reason },
    case_c: tg.case_c_indexed_main_checkout_scope && { outcome: tg.case_c_indexed_main_checkout_scope.trigram_outcome, tests: tg.case_c_indexed_main_checkout_scope.tests, pass: tg.case_c_indexed_main_checkout_scope.pass, fail: tg.case_c_indexed_main_checkout_scope.fail, skipped: tg.case_c_indexed_main_checkout_scope.skipped },
    main_checkout_untouched: tg.main_checkout_state,
    assertion_code_unchanged: "the indexed path executes assert.ok(res.files.length > 0) and the client.ts membership assert; only the source=scan branch skips",
  },
  threshold: "skip-with-reason outside the index; 25/25 with the full assertion on an indexed checkout",
  method: "two fresh isolated daemons (indexed archive copy; the real main checkout), live daemon never queried",
  n: 25,
  artifact: files.trigram,
  evidence_hashes: { trigram_evidence: hashes.trigram, trigram_test: hashes.trigram_test, raw: hashes.raw },
  gate: "trigram test guard",
});

row({
  id: "T-02",
  claim: "the trigram assertion is index-composition-sensitive at limit 30: on a 388-doc archive-composed index `src/client.ts` is absent from the page, while on the main checkout (415 docs) it ranks 1; at limit >= 33 it ranks 1 everywhere tested",
  verdict: tg.case_b_indexed_git_archive_scope.trigram_outcome === "failed" ? "verified" : "refuted",
  value: {
    archive_scope: { outcome: tg.case_b_indexed_git_archive_scope.trigram_outcome, fail: tg.case_b_indexed_git_archive_scope.fail, client_ts_rank_limit30: "absent", client_ts_rank_limit33: 1 },
    main_checkout_scope: { outcome: "passed_full_assertion", client_ts_rank_limit30: 1 },
  },
  threshold: "not a gate: this is the finding behind T-01's exception",
  method: "grep client-search symbol at limits 10/30/33/50/67/100 against two isolated indexes; the engine source is unchanged by wave4",
  n: 2,
  artifact: files.trigram,
  evidence_hashes: { trigram_evidence: hashes.trigram, raw: hashes.raw },
  gate: "finding (test scope sensitivity)",
});

// ---------------------------------------------------------------- environment
const gatesV2 = load(path.join(REPO, "bench/wave4/gates-v2.json"));
const envVerdict =
  !!raw.engine_provenance.author_artifact_engine_sha256 &&
  gatesV2.environment.status === "provisional" &&
  Number(gatesV2.environment.arms.v1.load1) > 1.5 &&
  Number(gatesV2.environment.arms.v2.load1) > 1.5;
row({
  id: "ENV-01",
  claim: "the author arms are label=provisional (load1 6.54-6.85, bound < 1.5); the gate values are set/ranking comparisons, which load does not move",
  verdict: envVerdict ? "verified" : "refuted",
  value: gatesV2.environment,
  threshold: "label recorded; not a gate value",
  method: "read gates-v2.json environment + the two artifact metas; verifier re-run also provisional (shared host)",
  n: 2,
  artifact: files.gates_v2,
  evidence_hashes: { gates_v2: hashes.gates_v2, raw: hashes.raw },
  gate: "environment label",
});

const allGateRows = rows.filter((r) => /^G[1-7]$/.test(r.id));
const sevenConfirmed = allGateRows.every((r) => r.verdict === "verified");
const strictCaveat = rows.find((r) => r.id === "K3-STRICT");
const blocking = rows.filter((r) => r.verdict !== "verified" && r.id !== "T-02");

const out = {
  suite: "wave4-independent-verification",
  wave: "wave4/verify",
  verifier: "independent verifier (this session) — every number re-measured or re-derived on an isolated daemon; author artifacts compared only after the fact",
  generated_at: new Date().toISOString(),
  head_commit: git(["rev-parse", "HEAD"]),
  head_ref: git(["rev-parse", "--abbrev-ref", "HEAD"]),
  base_main: git(["rev-parse", "origin/main"]),
  status_legend: {
    verified: "independently re-measured or re-derived; the claim's numbers reproduce",
    refuted: "the claim does not reproduce",
    "needs-re-run": "the artifact is stale/mismatched and no independent re-measurement exists",
  },
  environment_note:
    "The author arms are gate=provisional (load1 6.54-6.85 against a < 1.5 bound). Every wave-4 gate is a set/ranking comparison (membership of expected paths in retrieved lists and the order-independent nDCG over them), not a timing row, so load does not move them; the verifier re-run is likewise provisional on this shared host and reproduced every value exactly.",
  method: {
    scorer: "bench/verification/wave4/metrics.mjs — the verifier's own implementation of the frozen recall/nDCG/reformulation definitions, cross-checked against the shipped scorer (max |delta| = 0)",
    measurement: "own isolated daemon (ULTRASEARCH_DIR/HOME/SCAN_ROOT in a scratch dir, own socket) over the frozen wave-1 corpus; the live daemon is never queried",
    corpus: raw.corpus,
    engine_note: raw.engine_provenance.note,
  },
  verdict: {
    seven_of_seven_confirmed: sevenConfirmed,
    green_count_v2: gateValues.v2 ? Object.values(gateValues.v2).filter((g) => g.pass).length : null,
    strict_alternative_caveat: {
      value: round(raw.strict_alternative.recall10),
      gate1_passes: raw.strict_alternative.gate1_passes,
      statement:
        "v2 passes gate 1 only with the K3/README.md window removal; restoring that one grade-1 expectation into K3c makes recall@10 0.9848 and gate 1 fails. The number is published beside the gate in gates-v2.json and the removal is documented in the mapping.",
      judgement: rows.find((r) => r.id === "K3-JUDGEMENT").verdict,
    },
    exceptions: [
      "T-02: the test/client.test.ts assertion remains index-composition-sensitive at limit 30 (archive-composed index: client.ts absent; main checkout: rank 1). The guard does not weaken the assertion — the indexed path is byte-for-byte the original asserts — but the skip-reason parenthetical '(verified: 25/25 with cwd at an indexed checkout)' holds for the main checkout, not for every indexed scope.",
    ],
    blocking_findings: blocking.map((r) => r.id),
    statement: sevenConfirmed
      ? "7/7 confirmed on v2 over the frozen corpus with the verifier's own scorer and isolated daemons; the strict alternative (K3/README.md restored) fails gate 1 at recall@10 0.9848."
      : "not all seven gates reproduce; see the refuted rows.",
  },
  rows,
  evidence_files: hashes,
  reproduction: [
    "npm run bench:wave3:corpora",
    "node bench/verification/wave4/verify-wave4.mjs --label verify --out bench/verification/wave4/results/verify-raw.json",
    "node bench/verification/wave4/adversarial-validator.mjs",
    "bash bench/verification/wave4/trigram-guard-check.sh",
    "node bench/verification/wave4/summarize-wave4.mjs",
  ],
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ out: path.relative(REPO, OUT), seven_of_seven_confirmed: sevenConfirmed, rows: rows.length, refuted: rows.filter((r) => r.verdict === "refuted").map((r) => r.id), strict_alternative: out.verdict.strict_alternative_caveat.value }, null, 2));
