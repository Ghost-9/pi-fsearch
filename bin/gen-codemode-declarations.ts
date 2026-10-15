#!/usr/bin/env node
/**
 * Regenerate the Code Mode declaration golden file from the tool registry
 * (issue #29). Run after any `src/tool-schema.ts` change:
 *
 *   npm run codemode:declarations
 *
 * The drift test (`test/interop-surface.test.ts`) compares the committed
 * golden with a fresh generation and fails the build when they differ, so a
 * schema change cannot ship with stale sandbox declarations.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDeclarations } from "../src/codemode.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultTarget = path.resolve(here, "..", "test", "fixtures", "codemode-declarations.txt");
const args = process.argv.slice(2);
const toStdout = args.includes("--stdout");
const target = args.find((a) => !a.startsWith("--")) ?? defaultTarget;
const generated = generateDeclarations();

if (toStdout) {
  process.stdout.write(generated);
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, generated);
  process.stderr.write(`wrote ${target} (${generated.length} bytes)\n`);
}
