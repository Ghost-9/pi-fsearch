/**
 * Deterministic multi-scope fixture generator (issue #21).
 *
 * Scopes:
 *  - small:    ~50 files, a compact TypeScript repo
 *  - monorepo: ~2k files across 8 packages plus node_modules noise
 *  - home:     ~4.5k files shaped like a home directory (dot-dirs, Library,
 *              Documents, Downloads) — synthetic, so no private data is copied
 *
 * Fixtures are seeded so file names and tokens repeat exactly between runs;
 * `grep/results` comparisons therefore compare equal result sets.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { mulberry32 } from "./stats.mjs";

export const SCOPES = ["small", "monorepo", "home"];
export const GENERATOR_VERSION = 1;

function writeFile(root, rel, content) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function tsFile(token, i) {
  return [
    `// fixture module ${i}`,
    `export interface Shape${i} { id: number }`,
    ``,
    `export function fn${i}(input: string): string {`,
    `  const marker = "${token}";`,
    `  return marker + input;`,
    `}`,
    ``,
    `export const VALUE_${i} = fn${i}("x");`,
    ``,
  ].join("\n");
}

function genSmall(root) {
  let count = 0;
  const tokens = [];
  for (let i = 1; i <= 30; i++) {
    const token = `FIXTURE_SMALL_TOKEN_${String(i).padStart(4, "0")}`;
    tokens.push(token);
    writeFile(root, `src/mod-${String(i).padStart(4, "0")}.ts`, tsFile(token, i));
    count++;
  }
  for (let i = 31; i <= 40; i++) {
    writeFile(root, `test/mod-${String(i).padStart(4, "0")}.test.ts`, `import { fn } from "../src/mod-0001.ts";\n// ${i}\n`);
    count++;
  }
  for (let i = 0; i < 7; i++) {
    writeFile(root, `docs/guide-${i}.md`, `# Guide ${i}\n\nReferences FIXTURE_SMALL_TOKEN_0001 in prose.\n`);
    count++;
  }
  writeFile(root, "package.json", JSON.stringify({ name: "fixture-small", version: "1.0.0" }, null, 2) + "\n");
  writeFile(root, "README.md", "# fixture-small\n");
  count += 2;
  writeFile(root, "ignored/secret-small.txt", "FIXTURE_SMALL_IGNORED_TOKEN do not index\n");
  writeFile(root, "debug.log", "FIXTURE_SMALL_LOG_TOKEN\n");
  count += 2;
  writeFile(root, ".gitignore", "ignored/\n*.log\n");

  return {
    fileCount: count,
    ignoredFile: "ignored/secret-small.txt",
    queries: [
      {
        id: "small-path-exact",
        kind: "path",
        ultra: { query: "mod-0017.ts", options: { limit: 10 } },
        native: { kind: "find-name", pattern: "mod-0017.ts" },
        tolerance: { nativeOnly: 0 },
      },
      {
        id: "small-path-glob",
        kind: "path",
        ultra: { query: "*mod-001*", options: { limit: 30 } },
        native: { kind: "find-name", pattern: "mod-001*" },
        tolerance: { nativeOnly: 0 },
      },
      {
        id: "small-grep",
        kind: "grep",
        ultra: { pattern: "FIXTURE_SMALL_TOKEN_0023", options: { limit: 10 } },
        native: { kind: "rg-grep", pattern: "FIXTURE_SMALL_TOKEN_0023" },
        tolerance: { nativeOnly: 0.25 },
      },
    ],
  };
}

function genMonorepo(root) {
  let count = 0;
  const rng = mulberry32(0x5eed);
  const extensions = [".ts", ".tsx", ".json", ".md"];
  for (let pkg = 1; pkg <= 8; pkg++) {
    const p = `packages/pkg-${String(pkg).padStart(2, "0")}`;
    for (let i = 1; i <= 240; i++) {
      const ext = extensions[Math.floor(rng() * extensions.length)];
      const id = String(pkg * 1000 + i).padStart(4, "0");
      writeFile(root, `${p}/src/mod-${id}${ext}`, tsFile(`FIXTURE_MONO_PKG${pkg}_${id}`, i));
      count++;
    }
    writeFile(root, `${p}/package.json`, JSON.stringify({ name: `pkg-${pkg}`, version: "1.0.0" }, null, 2) + "\n");
    count++;
  }
  // Deep nesting probe
  writeFile(root, "packages/pkg-04/deep/a/b/c/d/e/f/mod-0417.ts", tsFile("FIXTURE_MONO_TOKEN_0417", 417));
  count++;
  // node_modules noise that must not be returned
  for (let i = 1; i <= 150; i++) {
    writeFile(root, `node_modules/noise-pkg-${i}/index.js`, `module.exports = "FIXTURE_MONO_NODE_MODULES_${i}";\n`);
    count++;
  }
  writeFile(root, "debug.log", "FIXTURE_MONO_LOG_TOKEN\n");
  writeFile(root, ".gitignore", "node_modules/\ndebug.log\n*.log\n");
  count += 2;

  return {
    fileCount: count,
    ignoredFile: "debug.log",
    noIndexDir: "node_modules",
    queries: [
      {
        id: "mono-path-exact",
        kind: "path",
        ultra: { query: "mod-0417.ts", options: { limit: 10 } },
        native: { kind: "find-name", pattern: "mod-0417.ts" },
        tolerance: { nativeOnly: 0 },
      },
      {
        id: "mono-path-glob",
        kind: "path",
        ultra: { query: "*mod-04*", options: { limit: 50 } },
        native: { kind: "find-name", pattern: "mod-04*" },
        tolerance: { nativeOnly: 0.02 },
      },
      {
        id: "mono-grep",
        kind: "grep",
        ultra: { pattern: "FIXTURE_MONO_TOKEN_0417", options: { limit: 10 } },
        native: { kind: "rg-grep", pattern: "FIXTURE_MONO_TOKEN_0417" },
        tolerance: { nativeOnly: 0.25 },
      },
    ],
  };
}

function genHome(root) {
  let count = 0;
  for (let i = 0; i < 200; i++) {
    writeFile(root, `.config/app-${String(i % 20).padStart(2, "0")}/config-${String(i).padStart(4, "0")}.json`, `{"id":${i}}\n`);
    count++;
  }
  for (let i = 0; i < 400; i++) {
    writeFile(root, `.cache/pkg-${String(i % 25).padStart(2, "0")}/cache-${String(i).padStart(4, "0")}.bin`, `cache-${i}\n`);
    count++;
  }
  for (let i = 0; i < 600; i++) {
    const app = String(i % 30).padStart(2, "0");
    writeFile(root, `Library/Application Support/App-${app}/store-${String(i).padStart(4, "0")}.db`, `store-${i}\n`);
    count++;
  }
  for (let i = 0; i < 2000; i++) {
    const proj = String(i % 40).padStart(3, "0");
    writeFile(root, `Documents/projects/proj-${proj}/src/file-${String(i).padStart(4, "0")}.ts`, tsFile(`FIXTURE_HOME_TOKEN_${String(i).padStart(4, "0")}`, i));
    count++;
  }
  for (let i = 0; i < 800; i++) {
    const d = String(i % 10).padStart(2, "0");
    writeFile(root, `Downloads/dump-${d}/file-${String(i).padStart(4, "0")}.txt`, `dump-${i}\n`);
    count++;
  }
  for (let i = 0; i < 300; i++) {
    writeFile(root, `.local/share/app/data-${String(i).padStart(4, "0")}.json`, `{"i":${i}}\n`);
    count++;
  }
  for (let i = 0; i < 200; i++) {
    writeFile(root, `Pictures/img-${String(i).padStart(4, "0")}.png`, "\u0089PNG\r\n");
    count++;
  }
  writeFile(root, "Documents/projects/proj-001/notes-0421.md", "# notes 0421\n\nHOME_TOKEN_0421 sentinel\n");
  writeFile(root, "Documents/projects/proj-001/tmp-junk.tmp", "HOME_TMP_TOKEN_0421\n");
  count += 2;
  writeFile(root, "Documents/projects/.gitignore", "*.tmp\n");
  count++;

  return {
    fileCount: count,
    ignoredFile: "Documents/projects/proj-001/tmp-junk.tmp",
    queries: [
      {
        id: "home-path-exact",
        kind: "path",
        ultra: { query: "notes-0421.md", options: { limit: 10 } },
        native: { kind: "find-name", pattern: "notes-0421.md" },
        tolerance: { nativeOnly: 0 },
      },
      {
        id: "home-path-glob",
        kind: "path",
        ultra: { query: "*proj-00*", options: { limit: 50 } },
        native: { kind: "find-name", pattern: "*proj-00*" },
        tolerance: { nativeOnly: 0.05 },
      },
      {
        id: "home-grep",
        kind: "grep",
        ultra: { pattern: "HOME_TOKEN_0421", options: { limit: 10 } },
        native: { kind: "rg-grep", pattern: "HOME_TOKEN_0421" },
        tolerance: { nativeOnly: 0.25 },
      },
    ],
  };
}

const GENERATORS = { small: genSmall, monorepo: genMonorepo, home: genHome };

export function buildFixture(scope, baseDir, options = {}) {
  if (!GENERATORS[scope]) throw new Error(`unknown fixture scope '${scope}' (expected one of ${SCOPES.join(", ")})`);
  const root = path.join(baseDir, scope);
  const manifestPath = path.join(root, ".fixture-manifest.json");
  if (!options.force && fs.existsSync(manifestPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      if (cached.scope === scope && cached.generatorVersion === GENERATOR_VERSION) {
        return { ...cached, root, cached: true };
      }
    } catch {
      // regenerate on a corrupt manifest
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const spec = GENERATORS[scope](root);
  const manifest = {
    scope,
    generatorVersion: GENERATOR_VERSION,
    root,
    fileCount: spec.fileCount,
    ignoredFile: spec.ignoredFile ?? null,
    noIndexDir: spec.noIndexDir ?? null,
    queries: spec.queries,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { ...manifest, cached: false };
}
