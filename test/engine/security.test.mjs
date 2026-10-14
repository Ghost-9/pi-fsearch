// Engine security boundary tests (#23): the configurable fail-closed
// deny-list, caller `root` containment, and the withheld counts.
//
// These run against a REAL daemon over a fixture tree (test/engine/harness.mjs).
// The client-side half of #23 (PEM regex, DLP on path output, isPathSafe for
// query scopes) is covered by test/client.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EngineHarness, writeFile, tmpdir, until } from "./harness.mjs";

/** A fixture with a public tree and a denied tree, both searchable by name. */
function fixtureWithSecret() {
  const h = new EngineHarness({ root: path.join(tmpdir("us-sec-"), "root") });
  writeFile(path.join(h.root, "public", "alpha-report.txt"), "PUBLIC_MARKER\n");
  // No credential-shaped text here on purpose: this test is about the policy
  // boundary, and a fixture that looks like a live key is indistinguishable
  // from one to a secret scanner. `test/sanitize.test.ts` covers the shapes.
  writeFile(path.join(h.root, "secret", "alpha-keys.txt"), "SECRET_MARKER confidential-value\n");
  writeFile(path.join(h.root, "secret", "nested", "alpha-deep.txt"), "SECRET_MARKER\n");
  return h;
}

test("deny-list: blocked paths never reach output, and the count is reported", async () => {
  const h = fixtureWithSecret();
  const denyFile = path.join(h.dir, "deny.txt");
  fs.writeFileSync(denyFile, `# policy\n${path.join(h.root, "secret")}\n`);
  await h.start();
  // Grep goes through the content index; wait for it to cover the fixture so
  // the grep assertions below are about the deny-list, not about cold start.
  await until(async () => (await h.status()).content_docs > 0, { timeoutMs: 20_000 });
  try {
    const res = await h.search("alpha-*");
    const paths = (res.hits ?? []).map((x) => x.path);
    assert.ok(res.ok, JSON.stringify(res));
    assert.ok(paths.some((p) => p.includes("/public/")), `public hit missing: ${JSON.stringify(paths)}`);
    assert.ok(!paths.some((p) => p.includes("/secret")), `denied path leaked: ${JSON.stringify(paths)}`);
    assert.equal(res.withheld, 2, `withheld count wrong: ${JSON.stringify(res)}`);

    const grep = await h.grep("SECRET_MARKER");
    assert.ok(grep.ok, JSON.stringify(grep));
    assert.deepEqual(grep.files ?? [], [], "denied files leaked through grep");
    assert.equal(grep.withheld, 2);
  } finally {
    h.cleanup();
  }
});

test("deny-list: a denial does not have to hide the whole tree", async () => {
  const h = fixtureWithSecret();
  fs.writeFileSync(path.join(h.dir, "deny.txt"), `${path.join(h.root, "secret", "nested")}\n`);
  await h.start();
  await until(async () => (await h.status()).content_docs > 0, { timeoutMs: 20_000 });
  try {
    const res = await h.grep("SECRET_MARKER");
    const paths = (res.files ?? []).map((f) => f.path);
    assert.equal(paths.length, 1, JSON.stringify(paths));
    assert.ok(paths[0].includes("alpha-keys.txt"), JSON.stringify(paths));
    assert.equal(res.withheld, 1);
  } finally {
    h.cleanup();
  }
});

test("deny-list: a malformed rule fails every result request closed", async () => {
  const h = fixtureWithSecret();
  // A rule that is not an absolute path: we cannot know what it meant, so
  // nothing may be served.
  fs.writeFileSync(path.join(h.dir, "deny.txt"), `relative/not-absolute\n`);
  await h.start();
  try {
    for (const call of [() => h.search("alpha-*"), () => h.grep("SECRET_MARKER"), () => h.request({ op: "recent", in: h.root })]) {
      const res = await call();
      assert.equal(res.ok, false, `expected refusal, got ${JSON.stringify(res).slice(0, 200)}`);
      assert.match(res.error, /security/, JSON.stringify(res));
    }
    // Diagnostics stay reachable, and say why: an operator has to be able to
    // see that the policy, not the index, is what broke.
    const st = await h.status();
    assert.equal(st.ok, true, JSON.stringify(st).slice(0, 300));
    assert.equal(st.deny_configured, true);
    assert.match(st.deny_error, /not an absolute path/);
  } finally {
    h.cleanup();
  }
});

test("deny-list: an explicitly named but missing file fails closed", async () => {
  const h = fixtureWithSecret();
  h.env.ULTRASEARCH_DENY_FILE = path.join(h.dir, "not-there.txt");
  await h.start();
  try {
    const res = await h.search("alpha-*");
    assert.equal(res.ok, false);
    assert.match(res.error, /does not exist/, JSON.stringify(res));
  } finally {
    h.cleanup();
  }
});

test("deny-list: a denied scope is refused, not silently narrowed", async () => {
  const h = fixtureWithSecret();
  fs.writeFileSync(path.join(h.dir, "deny.txt"), `${path.join(h.root, "secret")}\n`);
  await h.start();
  try {
    const res = await h.search(`in:${path.join(h.root, "secret")} alpha`);
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(res.error, /denied by policy/, JSON.stringify(res));
  } finally {
    h.cleanup();
  }
});

test("deny-list: no source configured denies nothing (upstream default)", async () => {
  const h = fixtureWithSecret();
  await h.start();
  try {
    const res = await h.search("alpha-*");
    assert.ok(res.ok);
    assert.ok((res.hits ?? []).some((x) => x.path.includes("/secret")), JSON.stringify(res.hits));
    assert.equal(res.withheld, undefined);
  } finally {
    h.cleanup();
  }
});

test("root containment: an escaping scope is a security error for every tool", async () => {
  const h = fixtureWithSecret();
  await h.start();
  try {
    const outside = tmpdir("us-outside-");
    for (const req of [
      // Explicit scopes (`in:` / a grep scope).
      { op: "search", q: `in:${outside} anything`, root: h.root },
      // An absolute glob narrows the search itself to the folder it names.
      { op: "glob", pattern: `${outside}/*.txt`, root: h.root },
      { op: "grep", pattern: "x", in: outside, root: h.root },
      // A `git:` filter with no `in:` takes its repo from `cwd`.
      { op: "search", q: "git:modified", cwd: outside, root: h.root },
    ]) {
      const res = await h.request(req);
      assert.equal(res.ok, false, `${req.op} should refuse: ${JSON.stringify(res).slice(0, 200)}`);
      assert.match(res.error, /outside the allowed root/, JSON.stringify(res));
    }
  } finally {
    h.cleanup();
  }
});

test("root containment: hits outside the root are dropped even when the scope is wider", async () => {
  const h = fixtureWithSecret();
  await h.start();
  try {
    // No `in:` scope: the daemon searches everything it indexed, but the
    // caller's boundary is the public folder.
    const res = await h.search("alpha-*", { root: path.join(h.root, "public") });
    const paths = (res.hits ?? []).map((x) => x.path);
    assert.ok(paths.length > 0, JSON.stringify(res));
    assert.ok(!paths.some((p) => p.includes("/secret")), JSON.stringify(paths));
    assert.ok(res.withheld >= 2, `withheld=${res.withheld}`);
  } finally {
    h.cleanup();
  }
});

test("root containment: an in-root scope still works normally", async () => {
  const h = fixtureWithSecret();
  await h.start();
  try {
    const res = await h.search(`in:${path.join(h.root, "public")} alpha-*`, { root: h.root });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal((res.hits ?? []).length, 1);
    assert.ok(res.hits[0].path.includes("/public/"));
  } finally {
    h.cleanup();
  }
});

test("root containment: a grep `file:` outside the root is refused", async () => {
  const h = fixtureWithSecret();
  await h.start();
  try {
    const res = await h.grep("SECRET_MARKER", { file: "/etc/hosts", root: path.join(h.root, "public") });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(res.error, /outside the allowed root/, JSON.stringify(res));
  } finally {
    h.cleanup();
  }
});
