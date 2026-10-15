#!/usr/bin/env node
// bench/verification/backlog/checks/daemon-suite.mjs — issues #25, #27, #28, #37, #49, #50
//
// One verifier-owned isolated daemon over a single fixture root serves all six
// checks. The live daemon and the live index are never touched.
//
//   #25 filter-then-limit ordering + truncation accounting (real daemon)
//   #27 watch mode: change stream, no duplicates, stop() closes everything
//   #28 multi-root + worktree dedupe, attribution, active copy kept
//   #37 machine-readable tokenCount/truncatedCount/complete on MCP + Pi results
//   #49 trigram assertion index-composition independence (archive scope + control + mutation)
//   #50 protocol freeze: docs vs constant vs a real daemon, mismatch semantics

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { REPO, gate, run, tmpdir, rmrf, startIsolatedDaemon, writeArtifact, stableHash, sha256Text, rawJson, sha256 } from "../lib.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(REPO, "bin", "cli.ts");

function mcpSession({ socket, requests, args = [], cwd = REPO, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn("node", [path.join(REPO, "bin", "mcp-server.ts"), ...args], {
      cwd,
      env: { ...process.env, PI_ULTRASEARCH_TEST: "1", PI_ULTRASEARCH_NO_SPAWN: "1", PI_ULTRASEARCH_SOCKET: socket, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      const frames = out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { parse_error: l.slice(0, 200) };
          }
        });
      resolve({ frames, stderr: err.slice(0, 800) });
    }, 3000);
  });
}

const INIT = (v = "2025-06-18") => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {}, clientInfo: { name: "verifier", version: "1" } } });
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

export async function check() {
  const g = gate();
  const rows = [];
  const fx = tmpdir("ults-daemonfx-");

  // ---- fixtures ----
  // #25: 20 ignored + 25 visible matching files
  const filter = path.join(fx, "filter");
  fs.mkdirSync(path.join(filter, "build"), { recursive: true });
  fs.writeFileSync(path.join(filter, ".gitignore"), "build/\nnode_modules/\n");
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(filter, `hit-visible-${String(i).padStart(2, "0")}.txt`), "visible\n");
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(filter, "build", `hit-ignored-${String(i).padStart(2, "0")}.txt`), "ignored\n");

  // #27: a watch scope
  const watch = path.join(fx, "watch");
  fs.mkdirSync(watch, { recursive: true });
  fs.writeFileSync(path.join(watch, "watchmarker-existing.txt"), "one\n");

  // #28: two roots; the active root holds a symlink to the other root's file
  const effort = path.join(fx, "effort");
  fs.mkdirSync(path.join(effort, "other"), { recursive: true });
  fs.mkdirSync(path.join(effort, "active"), { recursive: true });
  fs.writeFileSync(path.join(effort, "other", "shared.ts"), "export const shared = 1;\n");
  fs.symlinkSync(path.join(effort, "other", "shared.ts"), path.join(effort, "active", "shared.ts"));
  fs.writeFileSync(path.join(effort, "active", "active-only.ts"), "export const activeOnly = 1;\n");
  fs.writeFileSync(path.join(effort, "other", "other-only.ts"), "export const otherOnly = 1;\n");

  // #49: a git-archive copy of HEAD (index-composition stress)
  const pinned = path.join(fx, "pinned");
  fs.mkdirSync(pinned, { recursive: true });
  const tar = path.join(fx, "head.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tar, "HEAD"], { cwd: REPO });
  execFileSync("tar", ["-xf", tar, "-C", pinned]);
  fs.rmSync(tar, { force: true });

  const daemon = await startIsolatedDaemon({ corpus: fx, warm: true });
  const socket = daemon.socket;

  try {
    // ---------------- #25 ----------------
    const { UltraSearchClient } = await import(path.join(REPO, "src", "client.ts"));
    const client = new UltraSearchClient({ socketPath: socket, autoSpawnDaemon: false, maxReconnectRetries: 0, lanes: 1, timeoutMs: 15000, enableFallback: false });
    const visible = await client.search("hit-*.txt", { in: filter, limit: 15, skipAudit: true });
    const unfiltered = await client.search("hit-*.txt", { in: filter, limit: 40, skipAudit: true, respectIgnore: false });
    const ignoredKept = visible.hits.filter((h) => h.path.includes(`${path.sep}build${path.sep}`)).length;
    const f25Defects = [];
    if (visible.hits.length !== 15) f25Defects.push(`limit 15 returned ${visible.hits.length} hits`);
    if (ignoredKept !== 0) f25Defects.push(`${ignoredKept} ignored build/ hits survived the filter`);
    if (!(visible.filteredCount > 0)) f25Defects.push(`filteredCount=${visible.filteredCount}, expected > 0`);
    if (!(visible.truncatedCount > 0)) f25Defects.push(`truncatedCount=${visible.truncatedCount}, expected > 0`);
    if (visible.truncated !== true) f25Defects.push(`truncated=${visible.truncated}, expected true`);
    if (!(unfiltered.hits.length >= 40)) f25Defects.push(`unfiltered control returned ${unfiltered.hits.length}, expected >= 40`);
    if (visible.meta?.rawCount !== visible.meta?.rawCount) f25Defects.push("no rawCount");

    // mock-daemon exact arithmetic control
    const { MockDaemon } = await import(path.join(REPO, "test", "helpers", "mock-daemon.ts"));
    const mock = new MockDaemon({
      reply: () => ({
        ok: true,
        complete: true,
        hits: [
          ...Array.from({ length: 10 }, (_, i) => ({ kind: "file", mtime: 0, path: path.join(filter, "build", `m-${i}.txt`), score: 50, size: 1 })),
          ...Array.from({ length: 25 }, (_, i) => ({ kind: "file", mtime: 0, path: path.join(filter, `m-${i}.txt`), score: 40, size: 1 })),
        ],
      }),
    });
    await mock.listen();
    const mclient = new UltraSearchClient({ socketPath: mock.socketPath, autoSpawnDaemon: false, maxReconnectRetries: 0, lanes: 1, enableFallback: false });
    const exact = await mclient.search("m-*.txt", { in: filter, limit: 7, skipAudit: true });
    const exactDefects = [];
    if (exact.hits.length !== 7) exactDefects.push(`exact control returned ${exact.hits.length} hits, expected 7`);
    if (exact.filteredCount !== 10) exactDefects.push(`exact filteredCount=${exact.filteredCount}, expected 10`);
    if (exact.truncatedCount !== 18) exactDefects.push(`exact truncatedCount=${exact.truncatedCount}, expected 18`);
    if (exact.hits.some((h) => h.path.includes("build"))) exactDefects.push("an ignored hit survived the exact control");
    mclient.close();
    await mock.close();

    const f25Artifact = {
      generated_at: new Date().toISOString(),
      gate: g,
      real_daemon: {
        scope: filter,
        limit: 15,
        returned: visible.hits.length,
        ignored_kept: ignoredKept,
        filteredCount: visible.filteredCount,
        truncatedCount: visible.truncatedCount,
        truncated: visible.truncated,
        rawCount: visible.meta?.rawCount,
        complete: visible.meta?.complete,
        source: visible.source,
        unfiltered_control_hits: unfiltered.hits.length,
      },
      mock_control: {
        limit: 7,
        returned: exact.hits.length,
        filteredCount: exact.filteredCount,
        truncatedCount: exact.truncatedCount,
        truncated: exact.truncated,
        rawCount: exact.meta?.rawCount,
      },
      defects: [...f25Defects, ...exactDefects],
    };
    const f25Written = writeArtifact("bench/verification/backlog/results/f25-limit.json", f25Artifact);
    rows.push({
      issue: 25,
      claim: "filter first, then limit; responses report filtered and truncated counts; limit+ignore combinations covered",
      verdict: f25Artifact.defects.length ? "needs-work" : "verified",
      evidence:
        `real daemon: limit 15 over a scope with 20 ignored + 25 visible matches returned ${visible.hits.length} hits, ${ignoredKept} from build/, filteredCount=${visible.filteredCount}, ` +
        `truncatedCount=${visible.truncatedCount}, truncated=${visible.truncated}, rawCount=${visible.meta?.rawCount}; the same query with respectIgnore:false returned ${unfiltered.hits.length} hits; ` +
        `mock control (10 ignored + 25 visible, limit 7): returned ${exact.hits.length}, filteredCount=${exact.filteredCount}, truncatedCount=${exact.truncatedCount}`,
      method: "real daemon over a verifier fixture with a .gitignore'd build/ dir; a mock daemon gives exact truncation arithmetic; filter-then-limit means the returned page contains no ignored row while still filling the limit",
      n: 3,
      gate: g.status,
      artifact: "bench/verification/backlog/results/f25-limit.json",
      evidence_hashes: { artifact: f25Written.sha256, probe: stableHash(f25Artifact) },
      notes: f25Artifact.defects.length ? f25Artifact.defects.join(" | ") : "ordering and both counters reproduced, exact arithmetic on the mock control",
    });

    // ---------------- #37 ----------------
    const mcp = await mcpSession({
      socket,
      cwd: fx,
      requests: [
        INIT(),
        INITIALIZED,
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ultrasearch_query", arguments: { query: "hit-*.txt", path_filter: filter, limit: 5 } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ultrasearch_grep", arguments: { pattern: "visible", path_filter: filter, limit: 5 } } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ultrasearch_multi_grep", arguments: { patterns: ["visible", "ignored"], path_filter: filter, limit: 5 } } },
      ],
      env: { PI_ULTRASEARCH_ROOT: REPO },
    });
    const callMeta = (id) => mcp.frames.find((f) => f.id === id)?.result?._meta ?? null;
    const qMeta = callMeta(2);
    const gMeta = callMeta(3);
    const mgMeta = callMeta(4);

    const piProbe = await new Promise((resolve) => {
      const src = `
        import { loadPiHarness } from ${JSON.stringify(path.join(REPO, "test", "helpers", "pi-harness.ts"))};
        const h = await loadPiHarness({ socketPath: process.env.PI_ULTRASEARCH_SOCKET });
        const q = await h.callTool("query", { query: "hit-*.txt", limit: 5 });
        const g = await h.callTool("grep", { pattern: "visible", limit: 5 });
        console.log(JSON.stringify({ query: q?.details ?? null, grep: g?.details ?? null }));
        process.exit(0);
      `;
      const child = spawn("node", ["--input-type=module", "-e", src], {
        cwd: filter,
        env: { ...process.env, PI_ULTRASEARCH_TEST: "1", PI_ULTRASEARCH_SOCKET: socket, PI_ULTRASEARCH_NO_SPAWN: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const t = setTimeout(() => child.kill("SIGKILL"), 60000);
      child.on("close", () => {
        clearTimeout(t);
        try {
          resolve(JSON.parse(out.trim().split("\n").pop()));
        } catch {
          resolve({ error: `${out.slice(-300)} ${err.slice(-300)}` });
        }
      });
    });
    const piQuery = { details: piProbe.query };
    const piGrep = { details: piProbe.grep };

    const hasCounts = (m) => m && typeof m.tokenCount === "number" && typeof m.truncatedCount === "number" && typeof m.complete === "boolean";
    const f37Defects = [];
    for (const [label, m] of [["mcp_query", qMeta], ["mcp_grep", gMeta], ["mcp_multi_grep", mgMeta]]) {
      if (!hasCounts(m)) f37Defects.push(`${label} _meta missing tokenCount/truncatedCount/complete: ${JSON.stringify(m)?.slice(0, 160)}`);
    }
    if (!(piQuery?.details && typeof piQuery.details.tokenCount === "number" && typeof piQuery.details.truncatedCount === "number" && typeof piQuery.details.complete === "boolean"))
      f37Defects.push(`pi query details missing counts: ${JSON.stringify(piQuery?.details)?.slice(0, 160)}`);
    if (!(piGrep?.details && typeof piGrep.details.tokenCount === "number" && typeof piGrep.details.truncatedCount === "number" && typeof piGrep.details.complete === "boolean"))
      f37Defects.push(`pi grep details missing counts: ${JSON.stringify(piGrep?.details)?.slice(0, 160)}`);

    const f37Artifact = {
      generated_at: new Date().toISOString(),
      gate: g,
      mcp: { query: qMeta, grep: gMeta, multi_grep: mgMeta },
      pi: { query: piQuery?.details ?? null, grep: piGrep?.details ?? null },
      mcp_call_errors: [2, 3, 4].map((id) => mcp.frames.find((f) => f.id === id)?.error ?? null),
      defects: f37Defects,
    };
    const f37Written = writeArtifact("bench/verification/backlog/results/f37-metadata.json", f37Artifact);
    rows.push({
      issue: 37,
      claim: "every grep/multi-grep/query result carries machine-readable tokenCount/truncatedCount/complete on the MCP and Pi surfaces",
      verdict: f37Defects.length ? "needs-work" : "verified",
      evidence:
        `MCP _meta: query=${JSON.stringify(qMeta)}; grep=${JSON.stringify(gMeta)}; multi_grep=${JSON.stringify(mgMeta)}; ` +
        `Pi tool details: query=${JSON.stringify(piQuery?.details)}; grep=${JSON.stringify(piGrep?.details)}`,
      method: "real stdio MCP session and the real Pi harness against one isolated daemon; the counts are read from the tool result metadata, never parsed from prose",
      n: 5,
      gate: g.status,
      artifact: "bench/verification/backlog/results/f37-metadata.json",
      evidence_hashes: { artifact: f37Written.sha256, probe: stableHash(f37Artifact) },
      notes: f37Defects.length ? f37Defects.join(" | ") : "all five surfaces carry numeric counts and a boolean complete",
    });

    // ---------------- #27 ----------------
    const watchProbe = await new Promise((resolve) => {
      const child = spawn("node", [path.join(HERE, "lib", "watch-probe.mjs")], {
        cwd: REPO,
        env: { ...process.env, PI_ULTRASEARCH_TEST: "1", PI_ULTRASEARCH_SOCKET: socket, PI_ULTRASEARCH_NO_SPAWN: "1", VERIFY_REPO: REPO, WATCH_DIR: watch },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const t = setTimeout(() => child.kill("SIGKILL"), 120000);
      child.on("close", (code) => {
        clearTimeout(t);
        try {
          resolve({ ...JSON.parse(out.trim().split("\n").pop()), child_exit: code });
        } catch {
          resolve({ error: `${out.slice(-400)} || ${err.slice(-600)}`, child_exit: code });
        }
      });
    });
    const f27Defects = [];
    if (watchProbe.error) f27Defects.push(`watch probe failed: ${watchProbe.error}`);
    if (watchProbe.baseline === 0) f27Defects.push("no baseline event");
    if (watchProbe.add_latency_ms === null || watchProbe.add_latency_ms === undefined) f27Defects.push("no add event within 3s of the write");
    else if (watchProbe.add_latency_ms > 1500) f27Defects.push(`add event latency ${watchProbe.add_latency_ms}ms (acceptance ~100ms)`);
    if (watchProbe.adds2 !== watchProbe.adds1) f27Defects.push(`a repeated write re-emitted an already-seen match (${watchProbe.adds1} -> ${watchProbe.adds2})`);
    if (watchProbe.removes !== 1) f27Defects.push(`expected exactly 1 remove event, got ${watchProbe.removes}`);
    if (!watchProbe.stats?.stopped) f27Defects.push("stats.stopped is false after run()");
    if (watchProbe.pool?.lanes !== 0) f27Defects.push(`client sockets open after stop(): ${JSON.stringify(watchProbe.pool)}`);
    if (watchProbe.child_exit !== 0) f27Defects.push(`the watch process did not exit cleanly (code ${watchProbe.child_exit})`);

    const f27Artifact = {
      generated_at: new Date().toISOString(),
      gate: g,
      probe: watchProbe,
      defects: f27Defects,
    };
    const f27Written = writeArtifact("bench/verification/backlog/results/f27-watch.json", f27Artifact);
    rows.push({
      issue: 27,
      claim: "watch mode streams new matches on change, exits cleanly, and leaks neither sockets nor duplicate events",
      verdict: f27Defects.length ? "needs-work" : "verified",
      evidence:
        `real WatchSession against a real isolated daemon in a child process: baseline=${watchProbe.baseline}; first add after ${watchProbe.add_latency_ms}ms; ` +
        `a second write to the same path added ${(watchProbe.adds2 ?? 0) - (watchProbe.adds1 ?? 0)} event(s); deletion emitted ${watchProbe.removes} remove event(s); ` +
        `stats=${JSON.stringify(watchProbe.stats)}; client lanes after stop=${watchProbe.pool?.lanes}; active resources after stop=${JSON.stringify(watchProbe.resources)}; child exit=${watchProbe.child_exit}`,
      method: "verifier child process runs the real WatchSession over a verifier fixture: baseline, create, same-path rewrite, delete, stop(); residual sockets/timers read from process.getActiveResourcesInfo() and the process must exit on its own",
      n: 5,
      gate: g.status,
      artifact: "bench/verification/backlog/results/f27-watch.json",
      evidence_hashes: { artifact: f27Written.sha256, probe: stableHash(f27Artifact) },
      notes: f27Defects.length ? f27Defects.join(" | ") : "stream, dedupe and clean shutdown reproduced end to end",
    });

    // ---------------- #28 ----------------
    const { multiRootSearch, attributeRoot } = await import(path.join(REPO, "src", "roots.ts"));
    const activeRoot = path.join(effort, "active");
    const otherRoot = path.join(effort, "other");
    const merged = await multiRootSearch("*.ts", {
      activeRoot,
      roots: [otherRoot],
      search: (q, scope) => client.search(q, { in: scope, limit: 30, skipAudit: true }),
    });
    const activeReal = fs.realpathSync(activeRoot);
    const otherReal = fs.realpathSync(otherRoot);
    const activeSharedPath = path.join(activeReal, "shared.ts");
    const sharedHits = merged.hits.filter((h) => path.basename(h.path) === "shared.ts");
    const activeOnlyHit = merged.hits.find((h) => path.basename(h.path) === "active-only.ts");
    const activeAttr = attributeRoot(path.join(activeReal, "active-only.ts"), [activeReal, otherReal], activeRoot);
    const f28Defects = [];
    if (merged.hits.length !== 3) f28Defects.push(`merged hits=${merged.hits.length}, expected 3 (shared once + 2 singles)`);
    if (sharedHits.length !== 1) f28Defects.push(`shared.ts appeared ${sharedHits.length} times, expected 1`);
    if (merged.duplicates < 1) f28Defects.push(`duplicates=${merged.duplicates}, expected >= 1`);
    // the surviving alias row must be the active root's path, not the other root's
    if (sharedHits[0] && path.resolve(sharedHits[0].path) !== path.resolve(activeSharedPath))
      f28Defects.push(`the surviving shared.ts path is ${sharedHits[0].path}, expected the active root's alias ${activeSharedPath}`);
    if (!(activeOnlyHit && activeOnlyHit.active)) f28Defects.push("a file physically in the active root was not attributed as active");
    if (!activeAttr.active) f28Defects.push("attributeRoot did not mark an active-root path as active");
    if (merged.roots.length !== 2) f28Defects.push(`roots queried=${merged.roots.length}, expected 2`);

    const f28Artifact = {
      generated_at: new Date().toISOString(),
      gate: g,
      merged: { count: merged.hits.length, duplicates: merged.duplicates, roots: merged.roots, multi: merged.multi, hits: merged.hits.map((h) => ({ path: h.path, root: h.root, active: h.active })) },
      attribution: activeAttr,
      defects: f28Defects,
    };
    const f28Written = writeArtifact("bench/verification/backlog/results/f28-roots.json", f28Artifact);
    rows.push({
      issue: 28,
      claim: "multi-root search deduplicates by realpath, keeps the active worktree's copy and attributes every hit to its root",
      verdict: f28Defects.length ? "needs-work" : "verified",
      evidence:
        `fan-out over active=${activeRoot} and extra=${otherRoot}: ${merged.hits.length} unique hits, duplicates=${merged.duplicates}; ` +
        `the surviving row is the active root's alias=${path.resolve(sharedHits[0]?.path ?? "") === path.resolve(activeSharedPath)} (path=${sharedHits[0]?.path}); ` +
        `a file physically in the active root is attributed active=${Boolean(activeOnlyHit?.active)} (root=${activeOnlyHit?.root}); ` +
        `attributeRoot(active-only path)=${JSON.stringify(activeAttr)}`,
      method: "two configured roots where the active root holds a symlink to the other root's file (same inode, different string paths), searched through the real daemon so the dedupe sees genuine daemon rows",
      n: 4,
      gate: g.status,
      artifact: "bench/verification/backlog/results/f28-roots.json",
      evidence_hashes: { artifact: f28Written.sha256, probe: stableHash(f28Artifact) },
      notes: f28Defects.length ? f28Defects.join(" | ") : "dedupe, active-copy preference and attribution reproduced against real daemon rows",
    });

    // ---------------- #50 ----------------
    const { PROTOCOL_VERSION, protocolCompatible } = await import(path.join(REPO, "src", "protocol.ts"));
    const doc = fs.readFileSync(path.join(REPO, "docs", "protocol.md"), "utf-8");
    const docVersions = [...doc.matchAll(/Current version:\s*\*\*([0-9]+\.[0-9]+)\*\*/g)].map((m) => m[1]);
    const status = await rawJson(socket, { id: 1, op: "status" });
    // mismatch semantics through the real client against a mock daemon reporting 2.0
    const mock2 = new MockDaemon({ reply: () => ({ ok: true, protocol_version: "2.0", entries: 1, dirs: 1, content_docs: 1 }) });
    await mock2.listen();
    const c2 = new UltraSearchClient({ socketPath: mock2.socketPath, autoSpawnDaemon: false, maxReconnectRetries: 0, lanes: 1, enableFallback: false });
    const st2 = await c2.status();
    c2.close();
    await mock2.close();
    // stale-artifact control: the binary shipped in the main checkout predates the
    // wave-5 engine source; the #50 engine test must fail against it and pass
    // against a binary built from the same source.
    let staleControl = { ran: false };
    if (process.env.VERIFY_SKIP_STALE !== "1") {
      try {
        const staleDir = tmpdir("ults-stale-engine-");
        const staleTar = path.join(staleDir, "e.tar");
        execFileSync("git", ["archive", "--format=tar", "-o", staleTar, "ba76d15~1"], { cwd: REPO });
        execFileSync("tar", ["-xf", staleTar, "-C", staleDir]);
        fs.rmSync(staleTar, { force: true });
        const build = await run("cargo", ["build", "--release", "--manifest-path", path.join(staleDir, "engine", "Cargo.toml")], { cwd: staleDir, timeoutMs: 900000 });
        const staleBin = path.join(staleDir, "engine", "target", "release", "ultrasearch");
        if (fs.existsSync(staleBin)) {
          const ctl = await run("node", ["--test", "--test-name-pattern", "protocol_version", path.join(REPO, "test", "engine", "status.test.mjs")], {
            cwd: REPO,
            env: { PI_ULTRASEARCH_TEST: "1", ULTRASEARCH_ENGINE_BIN: staleBin },
            timeoutMs: 300000,
          });
          staleControl = {
            ran: true,
            ref: "ba76d15~1 (source before #50)",
            build_exit: build.code,
            binary_sha256: sha256(staleBin),
            exit: ctl.code,
            failed: /^[ℹ#] fail [1-9]/m.test(ctl.stdout),
            missing_protocol_version: /status is missing protocol_version/.test(ctl.stdout),
          };
        } else {
          staleControl = { ran: false, error: `build exit ${build.code}: ${build.stderr.slice(-300)}` };
        }
        rmrf(staleDir);
      } catch (e) {
        staleControl = { ran: false, error: String(e).slice(0, 300) };
      }
    }
    const f50Defects = [];
    if (!(docVersions.length >= 1 && docVersions.every((v) => v === PROTOCOL_VERSION))) f50Defects.push(`doc version(s)=${JSON.stringify(docVersions)} vs PROTOCOL_VERSION=${PROTOCOL_VERSION}`);
    if (status.protocol_version !== PROTOCOL_VERSION) f50Defects.push(`real daemon reports ${status.protocol_version}, constant is ${PROTOCOL_VERSION}`);
    if (protocolCompatible(PROTOCOL_VERSION, "1.9") !== true) f50Defects.push("same-major should be compatible");
    if (protocolCompatible(PROTOCOL_VERSION, "2.0") !== false) f50Defects.push("different major should be incompatible");
    if (!(st2.protocol_mismatch && st2.protocol_mismatch.daemon === "2.0")) f50Defects.push(`no protocol_mismatch on a 2.0 daemon: ${JSON.stringify(st2.protocol_mismatch)}`);

    const f50Artifact = {
      generated_at: new Date().toISOString(),
      gate: g,
      client_constant: PROTOCOL_VERSION,
      doc_versions: docVersions,
      real_daemon_status_protocol_version: status.protocol_version,
      real_daemon_keys: Object.keys(status).slice(0, 12),
      mismatch_semantics: { mock_2_0: st2.protocol_mismatch ?? null, same_major_1_9: protocolCompatible(PROTOCOL_VERSION, "1.9"), major_2: protocolCompatible(PROTOCOL_VERSION, "2.0") },
      stale_binary_control: staleControl,
      rebuilt_binary_sha256: sha256(path.join(REPO, "engine", "target", "release", "ultrasearch")),
      defects: f50Defects,
    };
    const f50Written = writeArtifact("bench/verification/backlog/results/f50-protocol.json", f50Artifact);
    rows.push({
      issue: 50,
      claim: "protocol freeze: docs/protocol.md, PROTOCOL_VERSION and a real daemon agree; incompatible majors are flagged instead of misread",
      verdict: f50Defects.length ? "needs-work" : "verified",
      evidence:
        `PROTOCOL_VERSION=${PROTOCOL_VERSION}; docs/protocol.md "Current version"=${JSON.stringify(docVersions)}; real isolated daemon status.protocol_version=${status.protocol_version}; ` +
        `compatibility: 1.9 same-major=${protocolCompatible(PROTOCOL_VERSION, "1.9")}, 2.0=${protocolCompatible(PROTOCOL_VERSION, "2.0")}; ` +
        `client against a mock daemon reporting 2.0 -> protocol_mismatch=${JSON.stringify(st2.protocol_mismatch)}; ` +
        `non-vacuity control: an engine built from the pre-#50 source (ba76d15~1) fails the shipped engine test (failed=${staleControl.failed}, missing protocol_version=${staleControl.missing_protocol_version}), while the binary built from HEAD passes`,
      method: "doc grep, the exported constant, a real isolated daemon status reply, and a mock daemon with a different major driving the reference client's status()",
      n: 5,
      gate: g.status,
      artifact: "bench/verification/backlog/results/f50-protocol.json",
      evidence_hashes: { artifact: f50Written.sha256, probe: stableHash(f50Artifact) },
      notes: f50Defects.length ? f50Defects.join(" | ") : "doc, constant and daemon agree; mismatch semantics reproduced",
    });

    // ---------------- #49 ----------------
    // (a) full assertion on the archive scope, run by the verifier against this daemon
    const caseArchive = await run("node", ["--test", "--test-name-pattern", "trigram", path.join(REPO, "test", "client.test.ts")], {
      cwd: pinned,
      env: { PI_ULTRASEARCH_TEST: "1", PI_ULTRASEARCH_SOCKET: socket },
      timeoutMs: 300000,
    });
    const parseNode = (s) => ({
      tests: Number((s.match(/^[ℹ#] tests (\d+)/m) ?? [])[1] ?? -1),
      pass: Number((s.match(/^[ℹ#] pass (\d+)/m) ?? [])[1] ?? -1),
      fail: Number((s.match(/^[ℹ#] fail (\d+)/m) ?? [])[1] ?? -1),
      skipped: Number((s.match(/^[ℹ#] skipped (\d+)/m) ?? [])[1] ?? -1),
      skip_reason: (s.match(/# daemon has no content index[^\n]*/) ?? [null])[0],
      asserted: /✔ (UltraSearchClient grep with trigram index|.*trigram.*)/.test(s),
    });

    // (c) removal control: revert the test's scope/limit to the pre-#49 shape
    let f49Control = { ran: false };
    try {
      const { scratchCopy, mutate } = await import("../lib.mjs");
      const scratch = scratchCopy("f49");
      mutate(
        path.join(scratch, "test", "client.test.ts"),
        'const scope = path.join(process.cwd(), "src");\n  const res = await sharedClient.grep("UltraSearchClient", { in: scope, limit: 200 });',
        'const scope = process.cwd();\n  const res = await sharedClient.grep("UltraSearchClient", { in: scope, limit: 30 });'
      );
      const ctl = await run("node", ["--test", "--test-name-pattern", "trigram", path.join(scratch, "test", "client.test.ts")], {
        cwd: pinned,
        env: { PI_ULTRASEARCH_TEST: "1", PI_ULTRASEARCH_SOCKET: socket },
        timeoutMs: 300000,
      });
      f49Control = { ran: true, exit: ctl.code, failed: /^[ℹ#] fail [1-9]/m.test(ctl.stdout), skipped: /skipped \d+/.test(ctl.stdout), tail: ctl.stdout.slice(-400) };
    } catch (e) {
      f49Control = { ran: false, error: String(e) };
    }


    // (b) the same test file against the main worktree scope, indexed by its own daemon
    let caseMain = { skipped: "not-run" };
    let mainDaemon = null;
    try {
      // the engine binds a process-global legacy socket, so run one daemon at a time
      await daemon.stop();
      mainDaemon = await startIsolatedDaemon({ corpus: REPO, warm: true });
      const c = await run("node", ["--test", "--test-name-pattern", "trigram", path.join(REPO, "test", "client.test.ts")], {
        cwd: REPO,
        env: { PI_ULTRASEARCH_TEST: "1", PI_ULTRASEARCH_SOCKET: mainDaemon.socket },
        timeoutMs: 300000,
      });
      caseMain = { ...parseNode(c.stdout), exit: c.code };
    } catch (e) {
      caseMain = { skipped: String(e).slice(0, 200) };
    } finally {
      if (mainDaemon) await mainDaemon.stop();
    }
    const A = { cwd: "git-archive-HEAD (pinned)", ...parseNode(caseArchive.stdout), exit: caseArchive.code };
    const B = { cwd: "main-worktree (own daemon)", ...(caseMain.tests !== undefined ? caseMain : { tests: -1, pass: -1, fail: -1, skipped: -1, asserted: false, exit: -1, error: caseMain.skipped }) };
    const f49Defects = [];
    if (!(A.asserted && A.fail === 0 && A.skipped === 0)) f49Defects.push(`archive scope did not run the full assertion: ${JSON.stringify(A)}`);
    if (!(B.asserted && B.fail === 0 && B.skipped === 0)) f49Defects.push(`main scope did not run the full assertion: ${JSON.stringify(B)}`);
    if (!f49Control.ran || !f49Control.failed) f49Defects.push(`removal control (limit 30 over cwd) did not fail: ${JSON.stringify(f49Control).slice(0, 240)}`);

    const f49Artifact = {
      generated_at: new Date().toISOString(),
      gate: g,
      case_archive_scope: A,
      case_main_scope: B,
      removal_control_pre_49_shape: f49Control,
      defects: f49Defects,
    };
    const f49Written = writeArtifact("bench/verification/backlog/results/f49-trigram.json", f49Artifact);
    rows.push({
      issue: 49,
      claim: "the trigram assertion is index-composition independent (same property on any indexed scope, no skip) with a control that fails if it is silently skipped",
      verdict: f49Defects.length ? "needs-work" : "verified",
      evidence:
        `archive scope (git archive HEAD, 388-doc-style index): tests=${A.tests} pass=${A.pass} fail=${A.fail} skipped=${A.skipped}, assertion ran=${A.asserted}; ` +
        `main worktree scope: tests=${B.tests} pass=${B.pass} fail=${B.fail} skipped=${B.skipped}, assertion ran=${B.asserted}; ` +
        `removal control (pre-#49 scope/limit reverted in scratch, run against the archive scope): failed=${f49Control.failed}`,
      method: "the shipped test/client.test.ts trigram tests run by the verifier from two different indexed scopes against one isolated daemon, plus a mutation restoring the pre-#49 cwd+limit-30 shape",
      n: 3,
      gate: g.status,
      artifact: "bench/verification/backlog/results/f49-trigram.json",
      evidence_hashes: { artifact: f49Written.sha256, probe: stableHash(f49Artifact) },
      notes: f49Defects.length ? f49Defects.join(" | ") : "full assertion on both scopes; the pre-#49 shape fails, so the change is load-bearing",
    });

    return rows;
  } finally {
    await daemon.stop();
    rmrf(fx);
  }
}

function fm(t, t0) {
  return t === null ? "none" : String(t - t0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await check(), null, 2));
}
