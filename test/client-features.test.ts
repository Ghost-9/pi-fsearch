process.env.PI_ULTRASEARCH_TEST = "1";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UltraSearchClient } from "../src/client.ts";
import { validateRegexPattern } from "../src/validate.ts";
import { matchesIgnorePattern } from "../src/sanitize.ts";
import { MockDaemon } from "./helpers/mock-daemon.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ults-features-"));
const openClients: UltraSearchClient[] = [];
const openDaemons: MockDaemon[] = [];

after(async () => {
  // Failing assertions must not leak daemon servers or client sockets.
  for (const c of openClients) {
    try { c.close(); } catch {}
  }
  for (const d of openDaemons) {
    try { await d.close(); } catch {}
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

async function newMock(options: ConstructorParameters<typeof MockDaemon>[0]): Promise<MockDaemon> {
  const daemon = new MockDaemon(options);
  openDaemons.push(daemon);
  await daemon.listen();
  return daemon;
}

function makeRepo(name: string, files: string[], gitignore?: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), `content of ${f}\n`);
  if (gitignore !== undefined) fs.writeFileSync(path.join(dir, ".gitignore"), gitignore);
  return dir;
}

function hit(filePath: string, score = 100) {
  return { kind: "file" as const, mtime: 0, path: filePath, score, size: 0 };
}

function file(filePath: string, text: string, line = 1) {
  return { path: filePath, matches: [{ line, text }] };
}

function openClient(daemon: MockDaemon, extra: Record<string, unknown> = {}): UltraSearchClient {
  const client = new UltraSearchClient({ socketPath: daemon.socketPath, autoSpawnDaemon: false, maxReconnectRetries: 0, ...extra });
  openClients.push(client);
  return client;
}

// ---------------------------------------------------------------------------
// #16 budget_ms / complete normalisation
// ---------------------------------------------------------------------------

test("grep: engine complete:false is preserved and mirrored into meta", async () => {
  const daemon = await newMock({ reply: () => ({ ok: true, complete: false, candidates: 900, files: [file("/tmp/a.ts", "x")] }) });
  const client = openClient(daemon);
  const res = await client.grep("x", { in: tmpRoot, limit: 5, budget_ms: 100, skipAudit: true });
  assert.equal(res.ok, true);
  assert.equal(res.complete, false);
  assert.equal(res.meta?.complete, false);
  assert.equal(res.meta?.budgetMs, 100);
  assert.equal(daemon.lastOp("grep").budget_ms, 100);
  client.close();
  await daemon.close();
});

test("search: a response without an explicit complete is treated as complete:false", async () => {
  const daemon = await newMock({ reply: () => ({ ok: true, hits: [hit("/tmp/a.ts")] }) });
  const client = openClient(daemon);
  const res = await client.search("a.ts", { in: tmpRoot, limit: 5, skipAudit: true });
  assert.equal(res.complete, false);
  assert.equal(res.meta?.complete, false);
  client.close();
  await daemon.close();
});

test("search: explicit complete:true survives normalisation", async () => {
  const daemon = await newMock({ reply: () => ({ ok: true, complete: true, hits: [hit("/tmp/a.ts")] }) });
  const client = openClient(daemon);
  const res = await client.search("a.ts", { in: tmpRoot, limit: 5, skipAudit: true });
  assert.equal(res.complete, true);
  assert.equal(res.meta?.complete, true);
  client.close();
  await daemon.close();
});

test("grep: client-side deadline fires and returns a partial, not a hang", async () => {
  const daemon = await newMock({ delayMs: 600, reply: () => ({ ok: true, complete: true, files: [file("/tmp/a.ts", "x")] }) });
  const client = openClient(daemon, { deadlineSlackMs: 50 });
  const started = performance.now();
  const res = await client.grep("x", { in: tmpRoot, limit: 5, budget_ms: 100, skipAudit: true });
  const elapsed = performance.now() - started;
  assert.equal(res.ok, true);
  assert.equal(res.complete, false);
  assert.equal(res.meta?.deadlineExceeded, true);
  assert.ok(elapsed < 450, `expected the deadline to fire early, took ${elapsed.toFixed(1)}ms`);
  client.close();
  await daemon.close();
});

test("search: client-side deadline marks deadlineExceeded and returns ok with no hits", async () => {
  const daemon = await newMock({ delayMs: 600, reply: () => ({ ok: true, complete: true, hits: [hit("/tmp/a.ts")] }) });
  const client = openClient(daemon, { deadlineSlackMs: 50 });
  const res = await client.search("a.ts", { in: tmpRoot, limit: 5, budget_ms: 100, skipAudit: true });
  assert.equal(res.ok, true);
  assert.deepEqual(res.hits, []);
  assert.equal(res.meta?.deadlineExceeded, true);
  assert.equal(res.meta?.complete, false);
  assert.equal(daemon.lastOp("search").budget_ms, 100);
  client.close();
  await daemon.close();
});

// ---------------------------------------------------------------------------
// #25 filter-then-limit ordering + truncation accounting
// ---------------------------------------------------------------------------

test("grep: ignore filtering runs before limit and reports filtered/truncated counts", async () => {
  const dir = makeRepo("limit-grep", ["a.txt", "b.txt", "c.txt", "secret-1.txt", "secret-2.txt"], "secret-*\n");
  const order = ["a.txt", "secret-1.txt", "secret-2.txt", "b.txt", "c.txt"];
  const daemon = await newMock({
    reply: (req) => ({ ok: true, complete: true, files: order.slice(0, req.limit).map((f) => file(path.join(dir, f), "txt")) }),
  });
  const client = openClient(daemon);
  const res = await client.grep("txt", { in: dir, limit: 2, skipAudit: true });

  assert.ok(daemon.lastOp("grep").limit > 2, "client must over-fetch so filtering cannot shrink below limit");
  assert.deepEqual(
    (res.files ?? []).map((f) => path.basename(f.path)),
    ["a.txt", "b.txt"],
    "filter must run before limit (old behaviour returned a.txt only)"
  );
  assert.equal(res.filteredCount, 2);
  assert.equal(res.meta?.filteredCount, 2);
  assert.equal(res.meta?.rawCount, 5);
  assert.equal(res.meta?.truncatedCount, 1);
  assert.equal(res.truncated, true);
  client.close();
  await daemon.close();
});

test("search: ignore filtering runs before limit and reports counts", async () => {
  const dir = makeRepo("limit-search", ["a.json", "b.json", "secret.json"], "secret*\n");
  const daemon = await newMock({
    reply: (req) => ({ ok: true, hits: ["a.json", "secret.json", "b.json"].slice(0, req.limit).map((f) => hit(path.join(dir, f))) }),
  });
  const client = openClient(daemon);
  const res = await client.search("*.json", { in: dir, limit: 2, skipAudit: true });
  assert.deepEqual((res.hits ?? []).map((h) => path.basename(h.path)), ["a.json", "b.json"]);
  assert.equal(res.filteredCount, 1);
  assert.equal(res.meta?.truncated, false);
  assert.equal(res.meta?.complete, false);
  client.close();
  await daemon.close();
});

test("symlinked scope (/tmp -> /private/tmp) still applies ignore rules", async () => {
  // os.tmpdir() on macOS is /var/folders/... but the shell-style /tmp symlink is
  // the historical failure mode: scope text and result path text disagree.
  const real = fs.mkdtempSync("/tmp/ults-ignore-");
  fs.writeFileSync(path.join(real, "visible.txt"), "v\n");
  fs.writeFileSync(path.join(real, "secret-abc.txt"), "s\n");
  fs.writeFileSync(path.join(real, ".gitignore"), "secret-*\n");
  const daemon = await newMock({
    reply: () => ({ ok: true, hits: [hit(fs.realpathSync(path.join(real, "visible.txt"))), hit(fs.realpathSync(path.join(real, "secret-abc.txt")))] }),
  });
  const client = openClient(daemon);
  const res = await client.search("*.txt", { in: real, limit: 10, skipAudit: true });
  assert.deepEqual((res.hits ?? []).map((h) => path.basename(h.path)), ["visible.txt"]);
  assert.equal(res.filteredCount, 1);
  client.close();
  await daemon.close();
  fs.rmSync(real, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// #37 machine-readable metadata
// ---------------------------------------------------------------------------

test("metadata: every result carries tokenCount/truncatedCount/complete", async () => {
  const dir = makeRepo("meta", ["a.ts", "b.ts"]);
  const daemon = await newMock({
    reply: (req) => {
      if (req.op === "grep") return { ok: true, files: [file(path.join(dir, "a.ts"), "export const a = 1;")] };
      if (req.op === "multi_grep") return { ok: true, files: [file(path.join(dir, "a.ts"), "export const a = 1;")] };
      return { ok: true, hits: [hit(path.join(dir, "a.ts")), hit(path.join(dir, "b.ts"))] };
    },
  });
  const client = openClient(daemon);

  const grep = await client.grep("a", { in: dir, limit: 5, skipAudit: true });
  assert.equal(typeof grep.meta?.tokenCount, "number");
  assert.equal(grep.meta?.tokenCount, Math.ceil((grep.meta?.charCount ?? 0) / 4));
  assert.equal(typeof grep.meta?.truncatedCount, "number");
  assert.equal(typeof grep.meta?.complete, "boolean");
  assert.equal(grep.meta?.source, "index");

  const search = await client.search("*.ts", { in: dir, limit: 5, skipAudit: true });
  assert.equal(typeof search.meta?.tokenCount, "number");
  assert.equal(search.meta?.complete, false);

  const multi = await client.multiGrep(["a", "b"], { in: dir, limit: 5, skipAudit: true });
  assert.equal(typeof multi.meta?.tokenCount, "number");
  assert.equal(multi.meta?.complete, false);

  client.close();
  await daemon.close();
});

// ---------------------------------------------------------------------------
// #36 client-side regex validation
// ---------------------------------------------------------------------------

test("regex validation: invalid and empty patterns never reach the socket", async () => {
  const daemon = await newMock({ reply: () => ({ ok: true, files: [] }) });
  const client = openClient(daemon);

  const invalid = await client.grep("a(", { in: tmpRoot, mode: "regex", limit: 5, skipAudit: true });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error ?? "", /invalid regex/i);
  assert.equal(invalid.complete, false);

  const empty = await client.grep("   ", { in: tmpRoot, mode: "regex", limit: 5, skipAudit: true });
  assert.equal(empty.ok, false);
  assert.match(empty.error ?? "", /empty/i);

  assert.equal(daemon.countOps("grep"), 0, "invalid regex must never reach the daemon");

  // Verifier R3: nested-quantifier patterns must be rejected before dispatch.
  const nested = await client.grep("(a+)+$", { in: tmpRoot, mode: "regex", limit: 5, skipAudit: true });
  assert.equal(nested.ok, false);
  assert.match(nested.error ?? "", /nested|inner quantifier|backtrack/i);
  assert.equal(daemon.countOps("grep"), 0, "nested-quantifier regex must never reach the daemon");

  const safe = await client.grep("class\\s+\\w+", { in: tmpRoot, mode: "regex", limit: 5, skipAudit: true });
  assert.equal(safe.ok, true);
  assert.equal(daemon.countOps("grep"), 1);

  client.close();
  await daemon.close();
});

test("regex validator: direct unit checks", () => {
  assert.equal(validateRegexPattern("").ok, false);
  assert.equal(validateRegexPattern("a(").ok, false);
  assert.equal(validateRegexPattern("class\\s+\\w+").ok, true);
  const nested = validateRegexPattern("(\\w+)+");
  assert.equal(nested.ok, false);
  assert.match(nested.ok === false ? nested.error : "", /inner quantifier/i);
  const alternation = validateRegexPattern("(cat|dog)+");
  assert.equal(alternation.ok, true);
  assert.ok("warning" in alternation && alternation.warning);
});

// ---------------------------------------------------------------------------
// SearchOptions.sort forwarding (advisor finding #4)
// ---------------------------------------------------------------------------

test("sort is forwarded on the wire when provided and omitted when not", async () => {
  const daemon = await newMock({ reply: () => ({ ok: true, hits: [] }) });
  const client = openClient(daemon);

  await client.search("a", { in: tmpRoot, limit: 5, sort: "mtime", skipAudit: true });
  assert.equal(daemon.lastOp("search").sort, "mtime");

  await client.search("a", { in: tmpRoot, limit: 5, skipAudit: true });
  assert.equal("sort" in daemon.lastOp("search"), false);

  client.close();
  await daemon.close();
});

// ---------------------------------------------------------------------------
// Proximity double-ranking (advisor finding #7)
// ---------------------------------------------------------------------------

test("proximity: daemon-backed results are not re-ranked, fallback results are", async () => {
  const deep = "/tmp/prox/deep/nested/file.ts";
  const near = "/tmp/prox/src/components/card.ts";
  const component = "/tmp/prox/src/components/button.ts";

  const daemon = await newMock({
    reply: (req) => ({ ok: true, source: req.__source ?? "index", hits: [hit(deep, 100), hit(component, 100)] }),
  });
  const client = openClient(daemon);

  const indexRes = await client.search("*.ts", { in: tmpRoot, near, skipAudit: true });
  assert.deepEqual(
    (indexRes.hits ?? []).map((h) => h.path),
    [deep, component],
    "daemon-backed results must keep the engine's order (no client double-ranking)"
  );

  const daemon2 = await newMock({ reply: () => ({ ok: true, source: "native_fallback", hits: [hit(deep, 100), hit(component, 100)] }) });
  const client2 = openClient(daemon2);
  const fallbackRes = await client2.search("*.ts", { in: tmpRoot, near, skipAudit: true });
  assert.deepEqual(
    (fallbackRes.hits ?? []).map((h) => h.path),
    [component, deep],
    "native fallback results still get client proximity ranking"
  );

  client.close();
  client2.close();
  await daemon.close();
  await daemon2.close();
});

// ---------------------------------------------------------------------------
// F1: ignore matcher must honour trailing-slash directory patterns + negation
// ---------------------------------------------------------------------------

test("ignore matcher: directory patterns cover dir and contents; negation re-includes", () => {
  assert.equal(matchesIgnorePattern("/project/node_modules/pkg/index.js", ["node_modules/"]), true);
  assert.equal(matchesIgnorePattern("/project/build/out/app.js", ["build/"]), true);
  assert.equal(matchesIgnorePattern("/project/dist/assets/app.css", ["dist/"]), true);
  assert.equal(matchesIgnorePattern("packages/a/node_modules/x/y.js", ["node_modules/"]), true);
  assert.equal(matchesIgnorePattern("/project/src/rebuild/app.js", ["build/"]), false);
  assert.equal(matchesIgnorePattern("/project/src/app.ts", ["node_modules/", "build/", "dist/"]), false);

  // Ordered gitignore semantics: a later negation wins.
  assert.equal(matchesIgnorePattern("logs/keep.log", ["*.log", "!keep.log"]), true === false ? true : false);
  assert.equal(matchesIgnorePattern("logs/keep.log", ["logs/", "!logs/keep.log"]), false);
  assert.equal(matchesIgnorePattern("logs/other.log", ["logs/", "!logs/keep.log"]), true);
});

// ---------------------------------------------------------------------------
// F3: multi-grep truncation vs limit
// ---------------------------------------------------------------------------

test("multiGrep: returns every match up to the requested limit (no default truncation)", async () => {
  const dir = makeRepo("multi-limit", ["a.ts"], "nothing-*.tmp\n");
  const all = Array.from({ length: 19 }, (_, i) => file(path.join(dir, `f${String(i).padStart(2, "0")}.ts`), "hit"));
  const daemon = await newMock({
    reply: (req) => ({ ok: true, files: all.slice(0, req.limit) }),
  });
  const client = openClient(daemon);

  const wide = await client.multiGrep(["hit"], { in: dir, limit: 200, skipAudit: true });
  assert.ok(daemon.lastOp("multi_grep").limit >= 200, "requested limit must reach the engine");
  assert.equal((wide.files ?? []).length, 19);
  assert.equal(wide.meta?.truncated, false);

  // A scope with ignore rules gets a bounded over-fetch (limit 10 -> 20), so the
  // true dropped count is reported instead of the old silent truncation at the
  // engine's requested limit.
  const narrow = await client.multiGrep(["hit"], { in: dir, limit: 10, skipAudit: true });
  assert.equal(daemon.lastOp("multi_grep").limit, 15, "first call in a rule-bearing scope: bounded over-fetch (+5)");
  assert.equal((narrow.files ?? []).length, 10);
  assert.equal(narrow.meta?.truncatedCount, 5);
  assert.equal(narrow.truncated, true);

  // Without ignore rules there is nothing to filter, so the request is exact and
  // the engine-capped signal carries the "more may exist" information.
  const bare = makeRepo("multi-limit-bare", ["a.ts"]);
  const daemon2 = await newMock({ reply: (req) => ({ ok: true, files: all.map((f) => ({ ...f, path: f.path.replace(dir, bare) })).slice(0, req.limit) }) });
  const client2 = openClient(daemon2);
  const exact = await client2.multiGrep(["hit"], { in: bare, limit: 10, skipAudit: true });
  assert.equal(daemon2.lastOp("multi_grep").limit, 10, "no over-fetch without declared rules");
  assert.equal(exact.meta?.engineCapped, true);
  assert.equal(exact.meta?.truncatedCount, 0);

  client.close();
  client2.close();
  await daemon.close();
  await daemon2.close();
});

test("grep: over-fetch is skipped once the scope's ignore density is high", async () => {
  const dir = makeRepo("density", ["a.txt"], "secret-*\n");
  const visible = Array.from({ length: 10 }, (_, i) => file(path.join(dir, `v${String(i).padStart(2, "0")}.txt`), "x"));
  const secret = Array.from({ length: 6 }, (_, i) => file(path.join(dir, `secret-${i}.txt`), "x"));
  // Interleaved so a smaller response still contains ignored files (a realistic
  // index ordering); otherwise the short request would look clean by luck.
  const all = visible.flatMap((v, i) => (i < secret.length ? [v, secret[i]] : [v]));
  const daemon = await newMock({ reply: (req) => ({ ok: true, files: all.slice(0, req.limit) }) });
  const client = openClient(daemon);

  // First call: density unknown, so a bounded margin is requested.
  await client.grep("x", { in: dir, limit: 10, skipAudit: true });
  assert.equal(daemon.lastOp("grep").limit, 15);

  // The observed density is 6/15 = 0.4 > 0.25, so a wider request would not fill
  // the limit: stop paying for it and report the filtered count instead.
  const short = await client.grep("x", { in: dir, limit: 10, skipAudit: true });
  assert.equal(daemon.lastOp("grep").limit, 10, "high ignore density must not trigger an over-fetch");
  assert.equal((short.files ?? []).length, 5);
  assert.equal(short.meta?.filteredCount, 5, "the filtered count is the honest signal when the result stays short");
  assert.equal(short.meta?.truncated, false);

  client.close();
  await daemon.close();
});
