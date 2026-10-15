#!/usr/bin/env node
/**
 * Harness capability matrix generator (issue #52).
 *
 * Reads the smoke artifacts under `bench/harness-smoke/` and renders
 * `docs/harness-matrix.md`. Every row is either backed by an artifact from a
 * real run or explicitly `skipped`/`inherited` — a missing artifact is an
 * error, never an implied pass.
 *
 * Usage:
 *   node bench/harness-matrix.mjs [--dir bench/harness-smoke] [--out docs/harness-matrix.md]
 *                                 [--check] [--require-fresh] [--json] [--print]
 *
 *   --check          validate every row and exit 1 on any problem
 *   --require-fresh  also fail when an artifact was generated on a dirty tree,
 *                    from a non-ancestor commit, or before an MCP-surface change
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HARNESSES } from "../src/harness-registry.ts";
import { SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp.ts";
import { canonicalToolNames } from "../src/tool-schema.ts";

export const SMOKE_SCHEMA = "ultrasearch/harness-smoke@1";

/**
 * Files that can change what a harness smoke observes. Freshness under
 * `--require-fresh` is judged by whether any of these differ between the
 * artifact's commit and HEAD — not by strict equality with HEAD, which no
 * committed artifact could ever satisfy once HEAD moves past it.
 */
export const MCP_SURFACE_PATHS = [
  "src/tool-schema.ts",
  "src/mcp.ts",
  "bin/mcp-server.ts",
  "src/harness-registry.ts",
  "package.json",
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// loading and validation
// ---------------------------------------------------------------------------

export function loadArtifacts(dir) {
  const artifacts = new Map();
  const problems = [];
  if (!fs.existsSync(dir)) return { artifacts, problems: [`artifact directory missing: ${dir}`] };
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const id = name.slice(0, -".json".length);
    try {
      artifacts.set(id, JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (err) {
      problems.push(`${name}: unreadable artifact (${err?.message ?? err})`);
    }
  }
  return { artifacts, problems };
}

function shortCommit(commit) {
  return typeof commit === "string" && commit.length >= 7 ? commit.slice(0, 7) : String(commit ?? "unknown");
}

function canonicMatch(names) {
  const expected = canonicalToolNames();
  return Array.isArray(names) && names.length === expected.length && names.every((n, i) => n === expected[i]);
}

/**
 * Validate one artifact against its registry row. Pure; returns problems.
 */
export function validateArtifact(spec, artifact, { headCommit, staleCheck } = {}) {
  const problems = [];
  const prefix = `${spec.id}:`;
  if (!artifact) return [`${prefix} no smoke artifact`];
  if (artifact.schema !== SMOKE_SCHEMA) problems.push(`${prefix} schema ${JSON.stringify(artifact.schema)} != ${SMOKE_SCHEMA}`);
  if (artifact.id !== spec.id) problems.push(`${prefix} artifact id ${JSON.stringify(artifact.id)} != registry id`);
  if (artifact.serverVersion !== SERVER_VERSION) problems.push(`${prefix} artifact serverVersion ${artifact.serverVersion} != ${SERVER_VERSION}`);

  const protocol = artifact.arms?.protocol;
  const native = artifact.arms?.native;
  if (!protocol) problems.push(`${prefix} missing protocol arm`);
  if (!native) problems.push(`${prefix} missing native arm`);

  if (spec.surface === "pi-derived") {
    if (protocol?.status !== "skipped" || native?.status !== "skipped") {
      problems.push(`${prefix} a Pi-derived row must be explicitly skipped`);
    }
    if (!String(native?.reason ?? "").startsWith("skipped:")) problems.push(`${prefix} derived row needs a skipped: reason`);
  } else if (protocol) {
    if (protocol.status !== "pass") {
      problems.push(`${prefix} protocol arm is ${protocol.status}${protocol.failures?.length ? `: ${protocol.failures[0]}` : ""}`);
    } else {
      if (protocol.toolCount !== 6) problems.push(`${prefix} protocol arm saw ${protocol.toolCount} tools, expected 6`);
      if (!canonicMatch(protocol.toolNames)) problems.push(`${prefix} protocol arm tool names are not the canonical six`);
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocol.negotiatedProtocolVersion)) {
        problems.push(`${prefix} negotiated protocol ${protocol.negotiatedProtocolVersion} is not supported`);
      }
      if (artifact.harness?.declaredProtocolSupported === false && protocol.negotiatedProtocolVersion !== SUPPORTED_PROTOCOL_VERSIONS[0]) {
        problems.push(`${prefix} declared protocol is newer than the server; the newest supported revision must be negotiated`);
      }
      if (!protocol.toolCall || protocol.toolCall.isError) problems.push(`${prefix} tools/call did not succeed`);
    }
  }

  if (native) {
    if (native.status === "fail") problems.push(`${prefix} native arm failed${native.failures?.length ? `: ${native.failures[0]}` : ""}`);
    else if (native.status === "skipped" && !String(native.reason ?? "").startsWith("skipped:")) {
      problems.push(`${prefix} a skipped native arm must carry a skipped:<reason>`);
    }
  }

  if (artifact.harness?.declaredProtocolVersionSource === "measured" && native?.mode === "harness-cli" && native.status === "pass") {
    if (!native.measuredProtocolVersion) problems.push(`${prefix} a measured row must record the measured protocol version`);
  }

  if (staleCheck) {
    const verdict = staleCheck(artifact);
    if (verdict?.stale) problems.push(`stale:${prefix} ${verdict.reason ?? "artifact is stale"}`);
  } else if (headCommit && artifact.commit !== headCommit) {
    problems.push(`stale:${prefix} artifact is from ${shortCommit(artifact.commit)}, HEAD is ${shortCommit(headCommit)}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// matrix rendering
// ---------------------------------------------------------------------------

function cell(value) {
  return String(value ?? "—").replace(/\|/g, "\\|");
}

function protoCell(artifact) {
  const protocol = artifact.arms?.protocol;
  if (!protocol) return "missing";
  if (protocol.status !== "pass") return `${protocol.status}${protocol.reason ? ` (${protocol.reason})` : ""}`;
  const negotiated = protocol.negotiatedProtocolVersion;
  const requested = protocol.requestedProtocolVersion;
  return negotiated === requested ? `pass · ${negotiated}` : `pass · ${requested} → ${negotiated}`;
}

function nativeCell(artifact) {
  const native = artifact.arms?.native;
  if (!native) return "missing";
  if (native.status === "pass") {
    const measured = native.measuredProtocolVersion ? `, client ${native.measuredProtocolVersion}` : "";
    return `pass · ${native.mode}${measured}`;
  }
  return `${native.status} · ${native.reason ?? "no reason"}`;
}

const STATUS_ORDER = { fail: 0, partial: 1, skipped: 2, pass: 3 };

export function buildMatrix({ specs = HARNESSES, artifacts, headCommit, generatedAt = new Date().toISOString(), requireFresh = false, staleCheck } = {}) {
  const generatedDate = String(generatedAt).slice(0, 10);
  const problems = [];
  const rows = [];
  for (const spec of specs) {
    const artifact = artifacts.get(spec.id);
    const rowProblems = validateArtifact(spec, artifact, requireFresh ? { headCommit, staleCheck } : {});
    problems.push(...rowProblems);
    const stale = staleCheck
      ? Boolean(artifact && staleCheck(artifact)?.stale)
      : Boolean(headCommit && artifact && artifact.commit !== headCommit);
    rows.push({
      spec,
      artifact,
      stale,
      problems: rowProblems.filter((p) => !p.startsWith("stale:")),
      status: artifact?.status ?? "missing",
      protocol: artifact?.arms?.protocol ?? null,
      native: artifact?.arms?.native ?? null,
    });
  }
  const extra = [...artifacts.keys()].filter((id) => !specs.some((s) => s.id === id));
  for (const id of extra) problems.push(`${id}: artifact has no registry row`);

  const ordered = [...rows].sort((a, b) => {
    const delta = (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0);
    return delta !== 0 ? delta : a.spec.id.localeCompare(b.spec.id);
  });

  const lines = [];
  lines.push("# Harness capability matrix");
  lines.push("");
  lines.push("<!-- GENERATED by `npm run matrix:harness` (bench/harness-matrix.mjs). Do not edit by hand. -->");
  lines.push("");
  lines.push(
    `Generated ${generatedDate} · commit \`${shortCommit(headCommit)}\` · server \`${SERVER_VERSION}\` · ` +
      `protocol revisions supported: ${SUPPORTED_PROTOCOL_VERSIONS.map((v) => `\`${v}\``).join(", ")}`
  );
  lines.push("");
  lines.push("Regenerate with:");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run smoke:harness      # runs the protocol arm everywhere; native arms where installed");
  lines.push("npm run matrix:harness     # renders this file from bench/harness-smoke/*.json");
  lines.push("```");
  lines.push("");
  lines.push("Status vocabulary — **pass**: a recorded artifact proves every check; **partial**: the protocol arm passed and the harness-native arm is explicitly `skipped:<reason>`; **skipped**: the row is derived (`inherits Pi`) and its evidence lives in another row; **fail**: at least one arm failed and must be fixed before claiming the row.");
  lines.push("");
  lines.push("| Harness | Surface | Config | Declared protocol | Protocol arm | Native arm | Tools | Entry shapes | Artifact |");
  lines.push("|:--|:--|:--|:--|:--|:--|--:|:--|:--|");
  for (const row of ordered) {
    const { spec, artifact } = row;
    const harness = artifact?.harness ?? {};
    const declared = `${spec.protocolVersion}${spec.protocolVersionSource === "assumed" ? " (assumed)" : " (measured)"}`;
    const tools = artifact?.arms?.protocol?.toolCount ?? "—";
    const flag = row.status === "fail" ? " ❌" : row.status === "pass" ? " ✅" : "";
    // Only the check mode tags staleness; a committed artifact always refers
    // to the commit it was produced from, which is one commit behind the doc.
    const stale = requireFresh && row.stale ? " *(stale)*" : "";
    const dirty = artifact?.worktreeDirty ? " *(dirty tree)*" : "";
    lines.push(
      `| **${cell(spec.label)}** \`${cell(spec.id)}\` | ${cell(spec.surface)} | \`${cell(spec.configPath.darwin)}\` (${cell(spec.format)}, \`${cell(spec.serverKey.join("."))}\`) | ${cell(declared)} | ${cell(protoCell(artifact ?? {}))}${flag} | ${cell(nativeCell(artifact ?? {}))} | ${cell(tools)} | ${cell(spec.entryShapeSource)} | \`${cell(shortCommit(artifact?.commit))}\`${stale} |`
    );
  }
  lines.push("");
  lines.push("### Explicitly unsupported / skipped");
  lines.push("");
  lines.push("No row below is implied to work; each names what actually ran and what did not.");
  lines.push("");
  lines.push("| Harness | Not run | Reason | Covered by |");
  lines.push("|:--|:--|:--|:--|");
  for (const row of ordered) {
    const native = row.native;
    if (!native || native.status !== "skipped") continue;
    const covered =
      row.spec.surface === "pi-derived"
        ? "`pi` row (native extension interop suite)"
        : "protocol arm on this row (stdin MCP handshake)";
    lines.push(`| \`${cell(row.spec.id)}\` | native harness client | \`${cell(native.reason ?? "skipped:unspecified")}\` | ${covered} |`);
  }
  lines.push("");
  lines.push("### How the arms work");
  lines.push("");
  lines.push("- **protocol arm** starts the server with the command that harness is configured with (falling back to the resolved `ultrasearch-mcp`), sends `initialize` at the harness's declared revision, `notifications/initialized`, `tools/list` and one `tools/call`. The daemon behind it is a hermetic mock over a temp socket (`daemon: mock` in each artifact), so the arm proves the MCP surface, not daemon behaviour — the engine suite covers that.");
  lines.push("- **native arm** runs the harness's own CLI where one exists: `claude mcp list` (Claude Code) and `codex mcp list` / `codex mcp get` (Codex CLI) are executed against a temp HOME/`CODEX_HOME`, so no live config is touched. Claude Code is pointed at a recording proxy (`bench/harness-smoke/probe-server.mjs`) so the artifact carries the harness's *measured* `protocolVersion` and `clientInfo`.");
  lines.push("- **CI** runs the protocol arm plus the matrix check; native arms run where the harness is installed and otherwise record `skipped:<reason>`.");
  lines.push("- The **Artifact** column is the commit the smoke ran against; `(dirty tree)` marks evidence produced with uncommitted changes present, and `--require-fresh` rejects artifacts from any commit other than HEAD.");
  lines.push("");
  if (problems.length) {
    lines.push("### Problems");
    lines.push("");
    for (const problem of problems) lines.push(`- ${problem}`);
    lines.push("");
  }
  return { markdown: lines.join("\n"), problems, rows: ordered };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dir: path.join(repoRoot, "bench", "harness-smoke"),
    out: path.join(repoRoot, "docs", "harness-matrix.md"),
    check: false,
    requireFresh: false,
    json: false,
    print: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--dir" && value) {
      opts.dir = path.resolve(value);
      i++;
    } else if (arg.startsWith("--dir=")) opts.dir = path.resolve(arg.slice("--dir=".length));
    else if (arg === "--out" && value) {
      opts.out = path.resolve(value);
      i++;
    } else if (arg.startsWith("--out=")) opts.out = path.resolve(arg.slice("--out=".length));
    else if (arg === "--check") opts.check = true;
    else if (arg === "--require-fresh") opts.requireFresh = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--print") opts.print = true;
    else {
      process.stderr.write(`harness-matrix: unknown option ${JSON.stringify(arg)}\n`);
      process.exit(2);
    }
  }
  return opts;
}

function headCommit() {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "unknown";
}

/**
 * Freshness rule: an artifact is fresh when it was generated on a clean tree,
 * its commit is an ancestor of HEAD, and none of the MCP-surface files changed
 * between that commit and HEAD. A non-ancestor commit or a changed surface is
 * stale; a dirty tree at generation time is stale because the recorded commit
 * then does not identify the tree that was exercised.
 */
function makeStaleCheck(head) {
  return (artifact) => {
    if (!artifact?.commit) return { stale: true, reason: "artifact has no commit" };
    if (artifact.worktreeDirty === true) return { stale: true, reason: "artifact was generated on a dirty tree" };
    if (artifact.commit === head) return { stale: false };
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", artifact.commit, head], { cwd: repoRoot });
    if (ancestor.status !== 0) {
      return { stale: true, reason: `artifact commit ${shortCommit(artifact.commit)} is not an ancestor of ${shortCommit(head)}` };
    }
    const diff = spawnSync("git", ["diff", "--quiet", artifact.commit, head, "--", ...MCP_SURFACE_PATHS], { cwd: repoRoot });
    if (diff.status === 1) {
      return { stale: true, reason: `MCP surface changed between ${shortCommit(artifact.commit)} and ${shortCommit(head)}` };
    }
    if (diff.status !== 0) {
      return { stale: true, reason: `could not compare ${shortCommit(artifact.commit)} with ${shortCommit(head)}` };
    }
    return { stale: false };
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { artifacts, problems: loadProblems } = loadArtifacts(opts.dir);
  const commit = headCommit();
  const matrix = buildMatrix({ specs: HARNESSES, artifacts, headCommit: commit, requireFresh: opts.requireFresh, staleCheck: makeStaleCheck(commit) });
  const problems = [...loadProblems, ...matrix.problems];
  if (!opts.check && !opts.print) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, matrix.markdown + "\n");
  }
  if (opts.print || (!opts.check && !opts.json)) process.stdout.write(matrix.markdown + "\n");
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          schema: "ultrasearch/harness-matrix@1",
          commit,
          problems,
          rows: matrix.rows.map((r) => ({
            id: r.spec.id,
            label: r.spec.label,
            surface: r.spec.surface,
            status: r.status,
            protocol: r.protocol?.status,
            negotiated: r.protocol?.negotiatedProtocolVersion ?? null,
            native: r.native?.status,
            nativeReason: r.native?.reason ?? null,
            measuredProtocolVersion: r.native?.measuredProtocolVersion ?? null,
            artifactCommit: r.artifact?.commit ?? null,
            stale: r.stale,
          })),
        },
        null,
        2
      ) + "\n"
    );
  }
  if (problems.length) {
    process.stderr.write(`harness-matrix: ${problems.length} problem(s)\n`);
    for (const problem of problems.slice(0, 20)) process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }
  if (!opts.json && !opts.check) process.stderr.write(`harness-matrix: wrote ${path.relative(repoRoot, opts.out)}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`harness-matrix: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
