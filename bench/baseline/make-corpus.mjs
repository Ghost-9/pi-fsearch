// bench/baseline/make-corpus.mjs
// Prepare the CLEAN judgment corpus at commit 0a16e50 (git archive, no worktree
// extras). The advisor worktree root contains bench/judgments/wave1-judgments.json,
// which quotes every query and therefore spoils retrieval/ranking (finding F8).
//
//   node bench/baseline/make-corpus.mjs [--force]
//
// Output: ~/.cache/pi-ultrasearch-bench/corpus-0a16e50
//         ~/.cache/pi-ultrasearch-bench/corpus-0a16e50.meta.json   <- BESIDE the root

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPO_ROOT, ensureTestEnv, utcDate } from "./lib.mjs";

ensureTestEnv();

const COMMIT = "0a16e50";
const ROOT = path.join(os.homedir(), ".cache", "pi-ultrasearch-bench", `corpus-${COMMIT}`);
// The metadata lives BESIDE the corpus, never inside it. Written inside, it is
// just another file in the searchable tree: measured through the real daemon,
// the engine returned `.corpus-meta.json` as a search hit and ranked it FIRST
// for the query `corpus`, ahead of the corpus's own README.md. It quotes the
// commit, the tree hash and the file count, so it poisons the very ranking it
// exists to measure (advisor finding `spoiler_meta_inside_root`).
const META = `${ROOT}.meta.json`;

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function treeHash(files) {
  const h = crypto.createHash("sha256");
  for (const f of [...files].sort()) {
    h.update(path.relative(ROOT, f).replace(/\\/g, "/"));
    h.update("\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

const force = process.argv.includes("--force");
if (!force && fs.existsSync(META)) {
  const meta = JSON.parse(fs.readFileSync(META, "utf8"));
  if (meta.commit === COMMIT) {
    console.log(JSON.stringify({ root: ROOT, skipped: true, ...meta }));
    process.exit(0);
  }
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

execFileSync("bash", ["-c", `git -C '${REPO_ROOT}' archive ${COMMIT} | tar -x -C '${ROOT}'`], {
  stdio: ["ignore", "pipe", "pipe"],
});

const files = walk(ROOT).filter((f) => path.basename(f) !== ".corpus-meta.json");
const meta = {
  commit: COMMIT,
  root: ROOT,
  files: files.length,
  bytes: files.reduce((a, f) => a + fs.statSync(f).size, 0),
  tree_sha256: treeHash(files),
  generated_at: utcDate(),
  note: "git archive of the frozen commit; excludes worktree extras such as bench/judgments (finding F8)",
};
fs.writeFileSync(META, JSON.stringify(meta, null, 2) + "\n");
console.log(JSON.stringify({ ...meta, skipped: false }));
