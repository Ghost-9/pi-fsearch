// Symbol mode (#26), engine-side: access-modifier declarations are indexed and
// found, a declaration-shaped string literal is not, and absent identifiers
// stay empty. The ranker lives in the engine (`engine/src/content.rs` +
// `engine/src/symbols.rs`); this test drives the real daemon through the
// harness, not the client.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { EngineHarness, writeFile, tmpdir, until } from "./harness.mjs";

function fixture() {
  const h = new EngineHarness({ root: path.join(tmpdir("us-sym-"), "root") });
  writeFile(
    path.join(h.root, "src", "client.ts"),
    [
      "export class UltraSearchClient {",
      "  public applyProximityRanking(n: number) { return n; }",
      "  private trySpawnDaemon() { return 1; }",
      "}",
      'const pattern = "export class UltraSearchClient {";',
      "",
    ].join("\n")
  );
  writeFile(
    path.join(h.root, "src", "coverage.rs"),
    ["pub struct Policy { x: u32 }", "impl Policy {", "  pub fn policy(&self) -> u32 { self.x }", "}", ""].join("\n")
  );
  writeFile(path.join(h.root, "test", "mock.ts"), "const s = 'export class UltraSearchClient {';\n");
  return h;
}

test("symbol mode: declarations (including access modifiers), not string literals", async () => {
  const h = fixture();
  await h.start();
  try {
    const ready = await until(
      async () => {
        const s = await h.status().catch(() => null);
        return s?.ok && (s.content_docs ?? 0) >= 3 && (s.content_pending ?? 0) === 0 ? s : null;
      },
      { timeoutMs: 30_000 }
    );
    assert.ok(ready, "fixture indexed");

    const files = async (pattern) => {
      const r = await h.grep(pattern, { mode: "symbol", root: h.root, defs: true });
      return (r.files ?? []).map((f) => path.basename(f.path));
    };

    assert.deepEqual(await files("applyProximityRanking"), ["client.ts"], "public method declaration");
    assert.deepEqual(await files("trySpawnDaemon"), ["client.ts"], "private method declaration");
    assert.deepEqual(await files("UltraSearchClient"), ["client.ts"], "mock string is not a declaration");
    assert.deepEqual(await files("Policy"), ["coverage.rs"], "Rust pub struct + impl");
    assert.deepEqual(await files("policy"), ["coverage.rs"], "Rust method");
    assert.deepEqual(await files("kubernetesPodReconcilerV2"), [], "absent identifier returns nothing");

    const defs = await h.grep("applyProximityRanking", { mode: "symbol", root: h.root, defs: true });
    assert.equal(defs.files[0].def, 8, "engine returns the def score");
    assert.equal(defs.files[0].matches[0].def, true, "the declaration line is marked");
  } finally {
    h.cleanup();
  }
});
