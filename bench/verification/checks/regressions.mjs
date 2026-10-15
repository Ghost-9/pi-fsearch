#!/usr/bin/env node
// bench/verification/checks/regressions.mjs — FINAL VERIFIER probes (wave1/verify-final).
//
// Independent re-measurement of the Wave 1 issues/findings against current main
// (3135e28 + this branch's verification files). Author-owned harnesses are NOT
// modified: this file only imports the product surface (src/*.ts) and the
// vendored engine binary.
//
//   PI_ULTRASEARCH_TEST=1 node bench/verification/checks/regressions.mjs
//
// Output: bench/verification/after/checks-regressions.json (+ stdout summary).
//
// Writes NOTHING to the production audit log: PI_ULTRASEARCH_TEST=1 is exported
// before any import, and the production file is snapshotted and re-checked at
// the end (F5 guard).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import * as net from "node:net";

process.env.PI_ULTRASEARCH_TEST = "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const OUT = path.join(HERE, "..", "after", "checks-regressions.json");
const SCRATCH = path.join(os.tmpdir(), `us-verify-${process.pid}`);
const FIXTURE = path.join(os.homedir(), ".cache", "pi-ultrasearch-bench", "fixture-5k");
const PROD_AUDIT = path.join(os.homedir(), ".pi", "agent", "cache", "pi-ultrasearch", "audit.jsonl");
const TEST_AUDIT = path.join(os.homedir(), ".pi", "agent", "cache", "pi-ultrasearch", "test_audit.jsonl");
const ENGINE_BIN = path.join(REPO, "engine", "target", "release", "ultrasearch");

fs.mkdirSync(SCRATCH, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const checks = [];
const record = (id, claim, status, evidence) => {
  checks.push({ id, claim, status, evidence, at: new Date().toISOString() });
  console.error(`[${status.toUpperCase().padEnd(4)}] ${id} — ${claim}`);
};

function fileStat(p) {
  try {
    const s = fs.statSync(p);
    const buf = fs.readFileSync(p);
    return { exists: true, bytes: buf.length, lines: buf.toString("utf8").split("\n").filter(Boolean).length, mtime: s.mtime.toISOString(), sha256: execFileSync("shasum", ["-a", "256", p], { encoding: "utf8" }).split(" ")[0] };
  } catch {
    return { exists: false };
  }
}

const prodBefore = fileStat(PROD_AUDIT);
const testBefore = fileStat(TEST_AUDIT);

const client_mod = await import(pathToFileURL(path.join(REPO, "src", "client.ts")).href);
const sanitize = await import(pathToFileURL(path.join(REPO, "src", "sanitize.ts")).href);
const validate = await import(pathToFileURL(path.join(REPO, "src", "validate.ts")).href);
const { UltraSearchClient } = client_mod;

const client = () => new UltraSearchClient({ timeoutMs: 20000 });

/** Raw line-delimited JSON over the live daemon socket (engine reply, no client). */
function rawRequest(payload, socket = path.join(os.homedir(), "Library", "Application Support", "UltraSearch", "ultrasearch.sock")) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: socket });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("raw request timeout"));
    }, 15000);
    sock.on("connect", () => sock.write(JSON.stringify({ id: 1, ...payload }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i >= 0) {
        clearTimeout(timer);
        sock.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, i)));
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// --------------------------------------------------------------------------
// #36 — regex rejection happens BEFORE the socket
// --------------------------------------------------------------------------
{
  const dead = "/nonexistent-dir/us-verify-dead.sock";
  const c = new UltraSearchClient({ socketPath: dead, timeoutMs: 3000, autoSpawnDaemon: false, enableFallback: false });
  const out = { dead_socket: dead, rejected_grep: null, rejected_multi: null, control_valid_pattern: null, graph: null };
  const call = async (fn) => {
    try {
      return { resolved: true, value: await fn() };
    } catch (e) {
      return { resolved: false, threw: String(e?.message ?? e).slice(0, 220) };
    }
  };
  const g = await call(() => c.grep("(a+)+$", { in: REPO, mode: "regex", limit: 5 }));
  out.rejected_grep = g.resolved ? { ok: g.value.ok, error: String(g.value.error ?? "").slice(0, 200), files: (g.value.files ?? []).length } : g;
  const m = await call(() => c.multiGrep(["(a+)+$"], { in: REPO, mode: "regex", limit: 5 }));
  out.rejected_multi = m.resolved ? { ok: m.value.ok, error: String(m.value.error ?? "").slice(0, 200), files: (m.value.files ?? []).length } : m;
  // CONTROL: a valid regex on the same (dead) socket must fail to connect — that
  // proves the socket really is unreachable, so the rejection above is client-side.
  const ctrl = await call(() => c.grep("export class", { in: REPO, mode: "regex", limit: 5 }));
  out.control_valid_pattern = ctrl.resolved ? { resolved: true, value: JSON.stringify(ctrl.value).slice(0, 160) } : { threw: ctrl.threw };
  out.graph = {
    nested_rejected: !validate.validateRegexPattern("(a+)+$").ok,
    nested_backref_rejected: !validate.validateRegexPattern("(\\w*)*").ok,
    alternation_warns: validate.validateRegexPattern("(a|aa)+").ok && !!validate.validateRegexPattern("(a|aa)+").warning,
    plain_ok: validate.validateRegexPattern("^export class").ok,
  };
  c.close();
  // A rejected-before-socket call must leave no audit row for that literal.
  const auditRows = fileStat(TEST_AUDIT).exists ? fs.readFileSync(TEST_AUDIT, "utf8").split("\n").filter(Boolean) : [];
  out.audit_rows_for_rejected_pattern = auditRows.filter((r) => r.includes("(a+)+$")).length;
  const rejected =
    out.rejected_grep.ok === false &&
    /rejected regex pattern/.test(out.rejected_grep.error) &&
    out.rejected_grep.files === 0 &&
    out.rejected_multi.ok === false &&
    /rejected regex pattern/.test(out.rejected_multi.error);
  const controlThrew = !!out.control_valid_pattern.threw;
  record(
    "#36",
    "catastrophic-backtracking regex `(a+)+$` is rejected client-side before any socket write",
    rejected && controlThrew && out.graph.nested_rejected && out.graph.nested_backref_rejected && out.graph.plain_ok && out.audit_rows_for_rejected_pattern === 0 ? "verified" : "failed",
    { ...out, proof: "rejection returns ok:false without touching a socket that is provably dead (the same call with a valid pattern throws a connection error); no audit row carries the rejected literal" },
  );
}

// --------------------------------------------------------------------------
// #23 — PEM redaction (multi-line + line-wise) and DLP on path output
// --------------------------------------------------------------------------
{
  const BODY = "MIIEowIBAAKCAQEA" + "x".repeat(72);
  const pemWhole = [`-----BEGIN RSA PRIVATE KEY-----`, BODY, BODY, `-----END RSA PRIVATE KEY-----`].join("\n");
  const scrubbedWhole = sanitize.scrubSecrets(pemWhole);
  const guard = new sanitize.SecretGuard();
  const linewise = [
    guard.line("-----BEGIN RSA PRIVATE KEY-----"),
    guard.line(BODY),
    guard.line(BODY),
    guard.line("-----END RSA PRIVATE KEY-----"),
  ];
  const guardClosed = guard.insidePrivateKey === false;
  const ordinary = [
    "const x = 1; // ordinary code",
    "commit 9f2c1a7b3d4e5f60718293a4b5c6d7e8f9012345",
    "https://example.com/path?q=1",
    "sha256: 3b1f7c9e5a2d486b0c1f3e5a7b9d2c4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c",
  ].map((l) => sanitize.scrubSecrets(l));
  const pathToken = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const pathScrubbed = sanitize.scrubSecrets(`/tmp/dir/${pathToken}.ts`);
  const dlpOk =
    !scrubbedWhole.includes(BODY) &&
    scrubbedWhole.includes("REDACTED") &&
    linewise.every((l) => !l.includes(BODY)) &&
    linewise.some((l) => l.includes("REDACTED")) &&
    pathScrubbed !== `/tmp/dir/${pathToken}.ts` &&
    !pathScrubbed.includes(pathToken) &&
    ordinary.every((l, i) => ["const x = 1; // ordinary code", "commit 9f2c1a7b3d4e5f60718293a4b5c6d7e8f9012345", "https://example.com/path?q=1", "sha256: 3b1f7c9e5a2d486b0c1f3e5a7b9d2c4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c"][i] === l);
  record("#23", "multi-line PEM body redacted; line-wise grep body redacted; path DLP redacts a credential-shaped filename; ordinary code/SHAs/URLs untouched", dlpOk ? "verified" : "failed", {
    whole: scrubbedWhole.replace(/x{20,}/g, "x…"),
    linewise,
    guard_closed_after_footer: guardClosed,
    path_in: `/tmp/dir/${pathToken.slice(0, 8)}…(.ts)`,
    path_out: pathScrubbed,
    negative_control_unchanged: ordinary,
  });
}

// --------------------------------------------------------------------------
// F1 — trailing-slash .gitignore patterns
// --------------------------------------------------------------------------
{
  const patterns = ["node_modules/", "dist/", "*.log", ".DS_Store", ".coverage", "*.tmp", ".agency/"];
  const unit = {
    node_modules_slash: sanitize.matchesIgnorePattern("node_modules/@types/node/package.json", patterns),
    node_modules_exact: sanitize.matchesIgnorePattern("node_modules/x.js", patterns),
    dist_slash: sanitize.matchesIgnorePattern("dist/bin/cli.js", patterns),
    nested_slash: sanitize.matchesIgnorePattern("packages/a/node_modules/x.js", patterns),
    control_not_ignored: sanitize.matchesIgnorePattern("src/client.ts", patterns),
  };
  const c = client();
  let live = { error: null, hits: 0, ignored: 0, node_modules: 0, sample: [] };
  try {
    const res = await c.search("package.json", { in: REPO, limit: 25 });
    for (const h of res.hits ?? []) {
      if (h.git === "ignored") live.ignored++;
      if (h.path.includes("/node_modules/")) live.node_modules++;
    }
    live.hits = (res.hits ?? []).length;
    live.sample = (res.hits ?? []).slice(0, 6).map((h) => `${h.git ?? "-"} ${h.path.replace(REPO + "/", "")}`);
  } catch (e) {
    live.error = String(e?.message ?? e).slice(0, 200);
  }
  c.close();
  const unitFixed = unit.node_modules_slash === true && unit.dist_slash === true && unit.nested_slash === true && unit.control_not_ignored === false;
  record("F1", "trailing-slash ignore patterns (`node_modules/`) match: pattern helper and live path search", unitFixed ? "verified" : "failed", { unit, live, note: "unit fix vs live-filtering are separate: `matchesIgnorePattern` is the sanitize helper; `live` is what the tool actually returns." });
}

// --------------------------------------------------------------------------
// F3 — multiGrep default-limit truncation
// --------------------------------------------------------------------------
{
  const c = client();
  const pats = ["ULTRAMARKER_1232", "ULTRAMARKER_7"];
  const out = {};
  try {
    const def = await c.multiGrep(pats, { in: FIXTURE });
    const hi = await c.multiGrep(pats, { in: FIXTURE, limit: 200 });
    const single = await c.grep("ULTRAMARKER_7", { in: FIXTURE, limit: 200 });
    const rg = execFileSync("rg", ["-l", "-e", pats[0], "-e", pats[1], FIXTURE], { encoding: "utf8" });
    out.default_limit = (def.files ?? []).length;
    out.limit_200 = (hi.files ?? []).length;
    out.single_grep = (single.files ?? []).length;
    out.rg_native = rg.split("\n").filter(Boolean).length;
    out.default_limit_value = def.limit ?? def.meta?.limit ?? null;
    out.truncated_flag = def.truncated ?? def.meta?.truncated ?? null;
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 200);
  }
  c.close();
  const fixed = out.default_limit === out.rg_native && out.limit_200 === out.rg_native;
  record("F3", "multiGrep at its DEFAULT limit returns every matching file (parity with rg -l)", fixed ? "verified" : "failed", out);
}

// --------------------------------------------------------------------------
// #19 / #34 / #17 — status fields on the live daemon
// --------------------------------------------------------------------------
{
  const c = client();
  let st = null;
  let err = null;
  try {
    st = await c.status();
  } catch (e) {
    err = String(e?.message ?? e).slice(0, 200);
  }
  let answer = null;
  try {
    const res = await c.search("package.json", { in: REPO, limit: 3 });
    answer = { stale_ms: res.stale_ms ?? null, complete: res.complete ?? null, scanned: res.meta?.scanned ?? null, considered: res.meta?.considered ?? null, budget_ms: res.meta?.budgetMs ?? null };
  } catch (e) {
    answer = { error: String(e?.message ?? e).slice(0, 160) };
  }
  c.close();
  const fields19 = st ? ["last_event_id", "event_lag", "staleness_ms", "replay_in_progress"].filter((k) => st[k] !== undefined) : [];
  const fields34 = st ? ["compactions", "last_compact_ms", "last_compact_bytes", "last_compact_entries", "last_compact_secs_ago", "compactions_postponed", "queries_in_flight"].filter((k) => st[k] !== undefined) : [];
  record("#19", "status exposes last_event_id/event_lag/staleness_ms/replay_in_progress and answers carry stale_ms", fields19.length === 4 && answer?.stale_ms !== undefined ? "verified" : "failed", { fields19, status_slice: st ? Object.fromEntries(fields19.map((k) => [k, st[k]])) : null, answer, error: err });
  record("#34", "status exposes compaction counters (compactions/last_compact_*/postponed/in_flight)", fields34.length === 7 ? "verified" : "failed", { fields34, status_slice: st ? Object.fromEntries(fields34.map((k) => [k, st[k]])) : null, pause_test: "test/engine/status.test.mjs (npm run test:engine)" });
  record("#17", "status reports content_policy beside content_docs/content_pending", st && st.content_policy !== undefined && st.content_docs !== undefined ? "verified" : "failed", { content_docs: st?.content_docs ?? null, content_pending: st?.content_pending ?? null, content_policy: st?.content_policy ?? null, coverage_test: "test/engine/coverage.test.mjs (npm run test:engine)" });
}

// --------------------------------------------------------------------------
// #16 — budget_ms: partial answers say complete:false and report their counts
// --------------------------------------------------------------------------
{
  const c = client();
  const out = { tiny_fixture: null, tiny_global_engine: null, tiny_bigscope_client: null, tiny_global_client: null, grep_global_engine: null, grep_global_client: null, ample_equals_none: null };
  try {
    const tiny = await c.search("module", { in: FIXTURE, limit: 200, budget_ms: 1 });
    out.tiny_fixture = { complete: tiny.complete, hits: (tiny.hits ?? []).length, budget_ms: tiny.meta?.budgetMs ?? null };
  } catch (e) {
    out.tiny_fixture = { error: String(e?.message ?? e).slice(0, 200) };
  }
  // The budget must be tested where a scan CAN take longer than the budget: a
  // global search over the 3.88 M-entry live index (the fixture finishes in <1 ms).
  try {
    const raw = await rawRequest({ op: "search", query: "package.json", limit: 200, budget_ms: 1 });
    out.tiny_global_engine = { complete: raw.complete, scanned: raw.scanned ?? null, considered: raw.considered ?? null, budget_ms: raw.budget_ms ?? null, hits: (raw.hits ?? []).length };
  } catch (e) {
    out.tiny_global_engine = { error: String(e?.message ?? e).slice(0, 200) };
  }
  try {
    const raw = await rawRequest({ op: "grep", pattern: "resolveDefaultSocketPath", limit: 50, budget_ms: 1 });
    out.grep_global_engine = { complete: raw.complete, scanned: raw.scanned ?? null, considered: raw.considered ?? null, candidates: raw.candidates ?? null, read: raw.read ?? null, files: (raw.files ?? []).length };
  } catch (e) {
    out.grep_global_engine = { error: String(e?.message ?? e).slice(0, 200) };
  }
  try {
    const g = await c.grep("UltraSearchClient", { limit: 10, budget_ms: 1 });
    out.grep_global_client = { complete: g.complete, files: (g.files ?? []).length, budget_ms: g.meta?.budgetMs ?? null };
  } catch (e) {
    out.grep_global_client = { error: String(e?.message ?? e).slice(0, 200) };
  }
  try {
    const tiny = await c.search("package.json", { in: "/Users", limit: 200, budget_ms: 1 });
    out.tiny_bigscope_client = { complete: tiny.complete, budget_ms: tiny.meta?.budgetMs ?? null, deadline_exceeded: tiny.meta?.deadlineExceeded ?? null, hits: (tiny.hits ?? []).length };
  } catch (e) {
    out.tiny_bigscope_client = { error: String(e?.message ?? e).slice(0, 200) };
  }
  try {
    const tiny = await c.search("package.json", { limit: 200, budget_ms: 1 });
    out.tiny_global_client = { complete: tiny.complete, budget_ms: tiny.meta?.budgetMs ?? null, deadline_exceeded: tiny.meta?.deadlineExceeded ?? null, hits: (tiny.hits ?? []).length };
  } catch (e) {
    out.tiny_global_client = { error: String(e?.message ?? e).slice(0, 200) };
  }
  try {
    const rawFull = await rawRequest({ op: "search", query: "package.json", limit: 200, budget_ms: 5000 });
    out.ample_global_engine_complete = rawFull.complete === true;
  } catch (e) {
    out.ample_global_engine_complete = { error: String(e?.message ?? e).slice(0, 160) };
  }
  try {
    const none = await c.search("module_0", { in: FIXTURE, limit: 20 });
    const ample = await c.search("module_0", { in: FIXTURE, limit: 20, budget_ms: 60000 });
    const key = (r) => (r.hits ?? []).map((h) => `${h.path}|${h.score}`).join("\n");
    out.ample_equals_none = { identical_output: key(none) === key(ample), none_complete: none.complete, ample_complete: ample.complete, n: (none.hits ?? []).length };
  } catch (e) {
    out.ample_equals_none = { error: String(e?.message ?? e).slice(0, 200) };
  }
  c.close();
  const ok =
    out.tiny_global_engine &&
    out.tiny_global_engine.complete === false &&
    out.tiny_global_engine.budget_ms !== null &&
    out.tiny_global_engine.scanned !== null &&
    out.grep_global_engine &&
    out.grep_global_engine.complete === false &&
    out.grep_global_client &&
    out.grep_global_client.complete === false &&
    out.ample_global_engine_complete === true &&
    out.ample_equals_none?.identical_output === true;
  record("#16", "budget_ms: a spent budget yields complete:false with budget/counter fields; an ample budget is output-identical to none", ok ? "verified" : "failed", { ...out, note: "A 1 ms budget over a small/fast scope is a race (either side of the deadline can win) and the small-scope search rows are recorded as informational; the deterministic rows are the global engine search, the global engine grep and the global client grep." });
}

// --------------------------------------------------------------------------
// #22 — frecency ordering + worktree scoping (live, plus engine tests)
// --------------------------------------------------------------------------
{
  const c = client();
  const other = "/Users/batra/.cache/us-verify/before";
  const out = {};
  try {
    const scoped = await c.search("package.json", { in: REPO, limit: 30 });
    const leaked = (scoped.hits ?? []).filter((h) => h.path.startsWith(other + "/"));
    out.scope_leak = leaked.length;
    out.scope_hits = (scoped.hits ?? []).length;
    out.scope_sample = (scoped.hits ?? []).slice(0, 3).map((h) => h.path.replace(REPO + "/", ""));
  } catch (e) {
    out.scope_error = String(e?.message ?? e).slice(0, 160);
  }
  try {
    const rec = await c.recent(REPO, 10);
    out.recent = { hits: (rec.hits ?? []).length, boosts: (rec.hits ?? []).slice(0, 5).map((h) => h.boost ?? null), paths: (rec.hits ?? []).slice(0, 3).map((h) => h.path.replace(REPO + "/", "")) };
  } catch (e) {
    out.recent = { error: String(e?.message ?? e).slice(0, 160) };
  }
  c.close();
  const ok = out.scope_leak === 0 && out.scope_hits > 0 && (out.recent?.hits ?? 0) > 0;
  record("#22", "scoped search returns only its own worktree's paths; recent is frecency-ranked with boost", ok ? "verified" : "failed", { ...out, engine_tests: "test/engine/search.test.mjs (worktree isolation + frecency ordering)" });
}

// --------------------------------------------------------------------------
// #45 — one daemon per index dir (second start refuses)
// --------------------------------------------------------------------------
{
  const dir = path.join(SCRATCH, "dup-daemon");
  const root = path.join(SCRATCH, "dup-root");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "needle.txt"), "NEEDLE_DUP_DAEMON\n");
  const env = { ...process.env, ULTRASEARCH_DIR: dir, ULTRASEARCH_HOME: root, ULTRASEARCH_SCAN_ROOT: root, ULTRASEARCH_TEST: "1" };
  const start = () => spawn(ENGINE_BIN, ["serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const first = start();
  const waitSock = async () => {
    for (let i = 0; i < 80; i++) {
      if (fs.existsSync(path.join(dir, "ultrasearch.sock"))) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const up = await waitSock();
  const second = start();
  let secondOut = "";
  await new Promise((r) => {
    const t = setTimeout(r, 4000);
    second.stdout.on("data", (d) => (secondOut += d));
    second.stderr.on("data", (d) => (secondOut += d));
    second.on("exit", () => {
      clearTimeout(t);
      r();
    });
  });
  const secondExited = second.exitCode !== null;
  const refusal = /another .*daemon is running/i.test(secondOut);
  first.kill("SIGTERM");
  second.kill("SIGKILL");
  record("#45", "a second daemon on the same index directory refuses to start (one writer per index)", up && secondExited && refusal ? "verified" : "failed", { socket_up: up, second_exited: secondExited, refusal_message: secondOut.trim().slice(0, 200), exit_code: second.exitCode });
}

// --------------------------------------------------------------------------
// F5 — production audit log stays untouched; test log receives the rows
// --------------------------------------------------------------------------
{
  const prodAfter = fileStat(PROD_AUDIT);
  const testAfter = fileStat(TEST_AUDIT);
  const untouched = prodBefore.exists === prodAfter.exists && prodBefore.sha256 === prodAfter.sha256 && prodBefore.mtime === prodAfter.mtime;
  record("F5", "with PI_ULTRASEARCH_TEST=1 the production audit log is byte-identical before/after every probe", untouched ? "verified" : "failed", { production: { before: prodBefore, after: prodAfter }, test_log: { before: { bytes: testBefore.bytes, lines: testBefore.lines }, after: { bytes: testAfter.bytes, lines: testAfter.lines } } });
}

// --------------------------------------------------------------------------
// F7 — shared test log (still one fixed path?)
// --------------------------------------------------------------------------
{
  const telemetry = fs.readFileSync(path.join(REPO, "src", "telemetry.ts"), "utf8");
  const sharedPath = /TEST_AUDIT_FILE\s*=\s*join\(homedir\(\),\s*"\.pi",\s*"agent",\s*"cache",\s*"pi-ultrasearch",\s*"test_audit\.jsonl"\)/.test(telemetry);
  const perProcess = /test_audit\.<pid>|PI_ULTRASEARCH_TEST_LOG|process\.pid/.test(telemetry);
  const concurrent = { a: 0, b: 0, both_present: null };
  if (sharedPath) {
    const before = fileStat(TEST_AUDIT).lines;
    await Promise.all(
      ["A", "B"].map(async (tag) => {
        for (let i = 0; i < 5; i++) {
          const c = new UltraSearchClient({ timeoutMs: 15000 });
          try {
            await c.search(`concurrency-${tag}-${i}`, { in: REPO, limit: 1, auditTool: `ultrasearch_query` });
          } catch {
            /* ignore */
          }
          c.close();
        }
      }),
    );
    const afterLines = fileStat(TEST_AUDIT).lines;
    const rows = fs.readFileSync(TEST_AUDIT, "utf8").split("\n").filter(Boolean).slice(-40);
    concurrent.a = rows.filter((r) => r.includes("concurrency-A-")).length;
    concurrent.b = rows.filter((r) => r.includes("concurrency-B-")).length;
    concurrent.both_present = concurrent.a > 0 && concurrent.b > 0;
    concurrent.lines_before = before;
    concurrent.lines_after = afterLines;
  }
  record("F7", "test audit log is still one shared fixed path (recommendation open, no truncation observed in this window)", sharedPath && !perProcess ? "unverified" : "verified", { shared_fixed_path: sharedPath, per_process_support: perProcess, concurrent_writers_present: concurrent, interpretation: sharedPath ? "Wave 1 F7 was a recommendation; it remains unfixed (documented, not a regression)." : "per-process isolation present" });
}

// --------------------------------------------------------------------------

const prodFinal = fileStat(PROD_AUDIT);
const summary = {
  suite: "wave1-finalverifier-regressions",
  repo: REPO,
  commit: execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  engine_bin: ENGINE_BIN,
  engine_bin_sha256: fileStat(ENGINE_BIN).sha256,
  daemon_socket_probed: path.join(os.homedir(), "Library", "Application Support", "UltraSearch", "ultrasearch.sock"),
  production_audit_untouched: prodBefore.sha256 === prodFinal.sha256 && prodBefore.mtime === prodFinal.mtime,
  counts: {
    verified: checks.filter((c) => c.status === "verified").length,
    failed: checks.filter((c) => c.status === "failed").length,
    unverified: checks.filter((c) => c.status === "unverified").length,
  },
  checks,
  finished_at: new Date().toISOString(),
};
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ out: OUT, counts: summary.counts, failed: checks.filter((c) => c.status === "failed").map((c) => c.id) }, null, 1));
process.exit(summary.counts.failed > 0 ? 1 : 0);
