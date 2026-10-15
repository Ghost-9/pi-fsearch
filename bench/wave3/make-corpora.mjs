#!/usr/bin/env node
// bench/wave3/make-corpora.mjs — materialise the two frozen judgment corpora at a
// stable path and verify their tree hashes.
//
//   node bench/wave3/make-corpora.mjs [--force] [--root <dir>]
//
// Why: the wave-1 judgment set declares its corpus as the advisor worktree
// (`/Users/batra/ultrasearch-waves/advisor`), which was removed during worktree
// cleanup, so `bench:scopes`' relevance arm and `bench:boost` report 0.000 -
// unmeasurable, not zero. These archives are the same content, reproduced from
// the commits in the main repository and checked against the hashes the
// verifiers published, so a later wave can re-measure without the worktree.
//
//   wave1  0a16e50  33 files  tree_sha256 98e299a63f5dca90692cf73571c370ed54385b787f4af54efd0fc669aed6149d
//   wave2  8d1419d  97 files  tree_sha256 c9c2e4ac15e88df9c5c0e241b0dd1c0281abce57155be58bc94120218f7f9665
//
// The wave-1 archive is produced by `bench/baseline/make-corpus.mjs`; this script
// only adds the wave-2 archive, the stable root, and the hash assertions.

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

process.env.PI_ULTRASEARCH_TEST = "1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const FORCE = argv.includes("--force");
const ROOT = opt("root", path.join(os.homedir(), ".cache", "ultrasearch", "corpus"));

const CORPORA = [
  {
    name: "wave1-0a16e50",
    commit: "0a16e50",
    files: 33,
    tree_sha256: "98e299a63f5dca90692cf73571c370ed54385b787f4af54efd0fc669aed6149d",
    exclude: [],
    used_by: "bench/judgments/wave1-judgments.json (30 queries); bench/verification checks",
  },
  {
    name: "wave2-8d1419d",
    commit: "8d1419d",
    files: 97,
    tree_sha256: "c9c2e4ac15e88df9c5c0e241b0dd1c0281abce57155be58bc94120218f7f9665",
    // The spoiler guard from the wave-2 corpus recipe: bench/**, ADVISOR-WAVE1.md
    // and VERIFICATION-PROTOCOL.md quote judged queries and expected paths.
    exclude: ["bench/**", "ADVISOR-WAVE1.md", "VERIFICATION-PROTOCOL.md"],
    used_by: "bench/judgments/wave2-judgments.json (38 queries)",
  },
];

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
function treeHash(root, files) {
  const h = crypto.createHash("sha256");
  for (const f of [...files].sort()) {
    h.update(path.relative(root, f).replace(/\\/g, "/"));
    h.update("\0");
    h.update(fs.readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

fs.mkdirSync(ROOT, { recursive: true });
const report = [];
let failed = 0;

for (const c of CORPORA) {
  const dir = path.join(ROOT, c.name);
  const meta = path.join(dir, ".corpus-meta.json");
  if (!FORCE && fs.existsSync(meta)) {
    const m = JSON.parse(fs.readFileSync(meta, "utf8"));
    if (m.commit === c.commit && m.tree_sha256 === c.tree_sha256) {
      report.push({ ...c, root: dir, action: "kept", verified: true });
      continue;
    }
  }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const pathspec = c.exclude.map((g) => `':(exclude)${g}'`).join(" ");
  execFileSync("bash", ["-c", `git -C '${REPO}' archive ${c.commit} -- . ${pathspec} | tar -x -C '${dir}'`], { stdio: ["ignore", "pipe", "pipe"] });
  const files = walk(dir).filter((f) => path.basename(f) !== ".corpus-meta.json");
  const hash = treeHash(dir, files);
  const verified = files.length === c.files && hash === c.tree_sha256;
  if (!verified) failed += 1;
  fs.writeFileSync(
    meta,
    JSON.stringify(
      {
        id: `${path.basename(REPO)}@${c.commit}`,
        commit: c.commit,
        root: dir,
        files: files.length,
        bytes: files.reduce((a, f) => a + fs.statSync(f).size, 0),
        tree_sha256: hash,
        expected_files: c.files,
        expected_tree_sha256: c.tree_sha256,
        verified_against_published_hash: verified,
        excluded_pathspecs: c.exclude,
        used_by: c.used_by,
        generated_at: new Date().toISOString(),
        reproduce: `git -C <repo> archive ${c.commit} -- . ${pathspec} | tar -x -C ${dir}`,
      },
      null,
      2,
    ) + "\n",
  );
  report.push({ ...c, root: dir, action: "created", files: files.length, sha: hash, verified });
}

const md = [
  "# Frozen judgment corpora",
  "",
  `Stable root: \`${ROOT}\` (was \`~/.cache/pi-ultrasearch-bench/\`; the advisor worktree the wave-1 set declares is gone).`,
  "",
  "| corpus | commit | files | tree_sha256 | matches the published hash |",
  "|:--|:--|--:|:--|:--|",
  ...report.map((r) => `| \`${r.name}\` | \`${r.commit}\` | ${r.files ?? "-"} | \`${(r.sha ?? r.tree_sha256).slice(0, 16)}…\` | ${r.verified ? "yes" : "**NO**"} |`),
  "",
  "Regenerate with `node bench/wave3/make-corpora.mjs --force`.",
  "",
  "The wave-1 archive is the clean `git archive` of `0a16e50` (no worktree extras: the judgment file quotes every query - finding F8). The wave-2 archive excludes `bench/**`, `ADVISOR-WAVE1.md` and `VERIFICATION-PROTOCOL.md` for the same reason.",
  "",
].join("\n");
fs.writeFileSync(path.join(ROOT, "CORPUS.md"), md);

console.log(md);
for (const r of report) console.log(`${r.verified ? "OK  " : "FAIL"} ${r.name} -> ${r.root} (${r.action})`);
process.exit(failed ? 1 : 0);
