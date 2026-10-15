import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMatrix, loadArtifacts, validateArtifact, SMOKE_SCHEMA } from "../bench/harness-matrix.mjs";
import { HARNESSES } from "../src/harness-registry.ts";
import { SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp.ts";
import { canonicalToolNames } from "../src/tool-schema.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeDir = path.join(repoRoot, "bench", "harness-smoke");

function headCommit(): string {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "unknown";
}

function passingArtifact(id: string, overrides: Record<string, any> = {}) {
  const spec = HARNESSES.find((h) => h.id === id) as (typeof HARNESSES)[number];
  return {
    schema: SMOKE_SCHEMA,
    id,
    label: spec.label,
    generatedAt: new Date().toISOString(),
    commit: headCommit(),
    serverVersion: SERVER_VERSION,
    supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    harness: {
      surface: spec.surface,
      configPath: spec.configPath.darwin,
      configPresent: true,
      installed: true,
      installEvidence: [],
      entryShapeSource: spec.entryShapeSource,
      declaredProtocolVersion: spec.protocolVersion,
      declaredProtocolVersionSource: spec.protocolVersionSource,
      declaredProtocolSupported: SUPPORTED_PROTOCOL_VERSIONS.includes(spec.protocolVersion),
      note: spec.note,
      directive: spec.directive,
    },
    arms: {
      protocol: {
        status: "pass",
        launch: { command: "/bin/ultrasearch-mcp", args: [], source: "installed" },
        client: { name: "ultrasearch-smoke", version: "1.0.0" },
        requestedProtocolVersion: spec.protocolVersion,
        negotiatedProtocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(spec.protocolVersion) ? spec.protocolVersion : SUPPORTED_PROTOCOL_VERSIONS[0],
        serverInfo: { name: "pi-ultrasearch", version: SERVER_VERSION },
        toolCount: 6,
        toolNames: canonicalToolNames(),
        toolCall: { name: "ultrasearch_locate", arguments: { filename: "package.json" }, isError: false, textSample: "package.json" },
        checks: { initialize: true },
        failures: [],
      },
      native: { status: "skipped", mode: "none", reason: "skipped:no-non-interactive-mcp-cli", checks: {}, failures: [] },
    },
    status: "partial",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// committed artifacts
// ---------------------------------------------------------------------------

test("matrix: every registry harness has a committed artifact", () => {
  const { artifacts, problems } = loadArtifacts(smokeDir);
  assert.deepEqual(problems, []);
  for (const spec of HARNESSES) {
    assert.ok(artifacts.has(spec.id), `missing bench/harness-smoke/${spec.id}.json`);
    assert.equal(artifacts.get(spec.id).id, spec.id);
  }
});

test("matrix: the committed artifacts validate against the registry and the server", () => {
  const { artifacts, problems } = loadArtifacts(smokeDir);
  assert.deepEqual(problems, []);
  const matrix = buildMatrix({ specs: HARNESSES, artifacts, headCommit: headCommit() });
  assert.deepEqual(matrix.problems, [], matrix.problems.join("\n"));
  assert.equal(matrix.rows.length, HARNESSES.length);
});

test("matrix: generated markdown states statuses explicitly and never implies an absent pass", () => {
  const { artifacts } = loadArtifacts(smokeDir);
  const { markdown, rows } = buildMatrix({ specs: HARNESSES, artifacts, headCommit: headCommit(), generatedAt: "2026-10-15T00:00:00.000Z" });
  assert.match(markdown, /# Harness capability matrix/);
  assert.match(markdown, /### Explicitly unsupported \/ skipped/);
  assert.match(markdown, /skipped:no-non-interactive-mcp-cli/);
  assert.match(markdown, /skipped:inherits-pi-provider/);
  for (const row of rows) {
    if (row.status === "skipped") assert.equal(row.spec.surface, "pi-derived");
  }
});

// ---------------------------------------------------------------------------
// validation rules (synthetic)
// ---------------------------------------------------------------------------

test("matrix: a missing artifact, a failed arm and a reasonless skip are problems", () => {
  const artifacts = new Map();
  artifacts.set("cursor", passingArtifact("cursor"));
  const failed = passingArtifact("codex");
  failed.arms.protocol.status = "fail";
  failed.arms.protocol.failures = ["initialize timed out"];
  artifacts.set("codex", failed);
  const reasonless = passingArtifact("zed");
  reasonless.arms.native = { status: "skipped", mode: "none", checks: {}, failures: [] };
  artifacts.set("zed", reasonless);
  artifacts.set("ghost", passingArtifact("cursor"));

  const matrix = buildMatrix({ specs: HARNESSES, artifacts, headCommit: headCommit() });
  const problems = matrix.problems.join("\n");
  assert.match(problems, /windsurf: no smoke artifact/);
  assert.match(problems, /codex: protocol arm is fail/);
  assert.match(problems, /zed: a skipped native arm must carry a skipped:<reason>/);
  assert.match(problems, /ghost: artifact has no registry row/);
});

test("matrix: tool count, canonical names, negotiation and measured protocol are enforced", () => {
  const five = passingArtifact("cursor");
  five.arms.protocol.toolCount = 5;
  five.arms.protocol.toolNames = canonicalToolNames().slice(0, 5);
  assert.match(validateArtifact(HARNESSES.find((h) => h.id === "cursor"), five).join("\n"), /expected 6/);

  const measured = passingArtifact("claude-code");
  measured.arms.native = { status: "pass", mode: "harness-cli", checks: {}, failures: [], measuredProtocolVersion: null };
  measured.arms.protocol.requestedProtocolVersion = "2025-11-25";
  measured.arms.protocol.negotiatedProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0];
  assert.match(validateArtifact(HARNESSES.find((h) => h.id === "claude-code"), measured).join("\n"), /must record the measured protocol version/);

  const wrongFallback = passingArtifact("claude-code");
  wrongFallback.arms.protocol.requestedProtocolVersion = "2025-11-25";
  wrongFallback.arms.protocol.negotiatedProtocolVersion = "2025-03-26";
  assert.match(validateArtifact(HARNESSES.find((h) => h.id === "claude-code"), wrongFallback).join("\n"), /newest supported revision/);

  const errorCall = passingArtifact("cursor");
  errorCall.arms.protocol.toolCall.isError = true;
  assert.match(validateArtifact(HARNESSES.find((h) => h.id === "cursor"), errorCall).join("\n"), /tools\/call did not succeed/);
});

test("matrix: staleness is reported but only fatal with --require-fresh", () => {
  const artifacts = new Map();
  const cursor = HARNESSES.find((h) => h.id === "cursor") as (typeof HARNESSES)[number];
  artifacts.set("cursor", passingArtifact("cursor", { commit: "0".repeat(40) }));
  const loose = buildMatrix({ specs: [cursor], artifacts, headCommit: headCommit() });
  assert.equal(loose.rows[0]?.stale, true, "an old artifact is flagged stale");
  const strict = buildMatrix({ specs: [cursor], artifacts, headCommit: headCommit(), requireFresh: true });
  assert.match(strict.problems.join("\n"), /artifact is from/);
});
