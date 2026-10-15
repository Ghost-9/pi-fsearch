// Ranking-ownership guard (wave-2 bars, "no client path sorts daemon rows").
//
// The daemon owns ranking. `search`/`grep` responses arrive ordered, with the
// score vector `{match, near, boost, def}` the engine computed; the client and
// the Pi tool wrappers render them as returned. A `.sort(` over `hits` or
// `files` is the third-reranker failure mode this test exists to catch.
//
// The semantic lane's own ranker (`searchSemanticIntent`) is a separate,
// documented API whose judgments are scored against that function directly; it
// is not a re-rank of daemon rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { formatGrepFiles, explainReasonTags } from "../src/formatter.ts";
import type { UltraSearchGrepFile } from "../src/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

test("guard: no client path sorts daemon rows", () => {
  for (const file of ["src/client.ts", "index.ts"]) {
    const src = fs.readFileSync(path.join(REPO, file), "utf8");
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/\.sort\(|\.sort\b/.test(lines[i])) continue;
      const window = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
      assert.ok(
        !/(\bhits\b|\bfiles\b)/.test(window),
        `${file}:${i + 1} sorts daemon rows (client must not re-rank):\n${window}`
      );
    }
  }
});

test("guard: formatGrepFiles preserves the engine's file order", () => {
  // The engine ranked `a-primary` before `z-rare`; the formatter may not
  // re-sort (alphabetically or by any other signal) on the way out.
  const files: UltraSearchGrepFile[] = [
    { path: "/root/a-primary.ts", matches: [{ line: 1, text: "engine put me first" }] },
    { path: "/root/z-rare.ts", matches: [{ line: 1, text: "engine put me last" }] },
  ];
  const out = formatGrepFiles(files, { worktreeRoot: "/root" });
  const first = out.text.indexOf("a-primary.ts");
  const second = out.text.indexOf("z-rare.ts");
  assert.ok(first >= 0 && second >= 0 && first < second, `file order preserved, got:\n${out.text}`);
});

test("guard: engine definition verdicts drive [def:*] tags, not client detection", () => {
  const files: UltraSearchGrepFile[] = [
    {
      path: "/root/client.ts",
      def: 8,
      matches: [
        { line: 1, text: "export class UltraSearchClient {", def: true },
        { line: 2, text: "const pattern = 'export class UltraSearchClient {'", def: false },
      ],
    },
  ];
  const out = formatGrepFiles(files, { worktreeRoot: "/root", tagSymbols: true, prioritizeSymbols: true });
  const tagged = out.text.split("\n").filter((l) => l.includes("[def:"));
  assert.equal(tagged.length, 1, `exactly the engine-certified declaration is tagged:\n${out.text}`);
  assert.match(tagged[0], /export class UltraSearchClient/);
});

test("guard: explainReasonTags renders the engine's vector truthfully", () => {
  const tagsFor = (query: string, hit: Parameters<typeof explainReasonTags>[1]) => explainReasonTags(query, hit);
  assert.deepEqual(
    tagsFor("src/client.ts", { path: "/root/src/client.ts", score: 30, match: 30 }),
    ["exact", "match:30", "score:30"]
  );
  assert.ok(tagsFor("src/**/*.ts", { path: "/root/src/client.ts", score: 20, match: 20 }).includes("glob"));
  assert.ok(tagsFor("client", { path: "/root/src/client.ts", score: 40, match: 15, near: 12, boost: 13 }).includes("proximity"));
  assert.ok(tagsFor("client", { path: "/root/src/client.ts", score: 40, match: 30, boost: 10 }).includes("frecency"));
  assert.ok(tagsFor("Policy", { path: "/root/engine/src/coverage.rs", score: 8, match: 8, def: 8 }).includes("symbol"));
  assert.ok(tagsFor("x", { path: "/root/a.ts", score: 5, match: 5, git: "modified" }).includes("git:modified"));
});
