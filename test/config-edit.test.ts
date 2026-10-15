import test from "node:test";
import assert from "node:assert/strict";
import {
  checkJson,
  checkToml,
  normalizeJsonc,
  readJsonEntry,
  readTomlSection,
  removeJsonEntry,
  removeTomlSection,
  upsertJsonEntry,
  upsertTomlSection,
} from "../src/config-edit.ts";

// ---------------------------------------------------------------------------
// JSONC normalization
// ---------------------------------------------------------------------------

test("config-edit: normalizeJsonc blanking preserves byte offsets", () => {
  const text = `{\n  // comment\n  "a": "// not a comment", /* block */\n  "b": [1, 2,],\n}\n`;
  const normalized = normalizeJsonc(text);
  assert.equal(normalized.length, text.length);
  assert.deepEqual(JSON.parse(normalized), { a: "// not a comment", b: [1, 2] });
  assert.equal(normalized.indexOf(`"// not a comment"`), text.indexOf(`"// not a comment"`));
  assert.deepEqual(checkJson(text, true), { ok: true });
});

test("config-edit: trailing comma inside a string is not treated as JSONC punctuation", () => {
  const text = `{"a": "x, ]", "b": 1,}`;
  const normalized = normalizeJsonc(text);
  assert.equal(normalized.length, text.length);
  assert.deepEqual(JSON.parse(normalized), { a: "x, ]", b: 1 });
});

// ---------------------------------------------------------------------------
// JSON upsert
// ---------------------------------------------------------------------------

test("config-edit: upsert creates a nested entry and preserves unrelated content", () => {
  const before = `{\n  "mcpServers": {\n    "rea": { "command": "/bin/rea", "args": ["mcp"] }\n  },\n  "other": 1\n}\n`;
  const { text, changed } = upsertJsonEntry(before, ["mcpServers"], "ultrasearch", { command: "/bin/us", args: [] });
  assert.equal(changed, true);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.mcpServers.ultrasearch, { command: "/bin/us", args: [] });
  assert.deepEqual(parsed.mcpServers.rea, { command: "/bin/rea", args: ["mcp"] });
  assert.equal(parsed.other, 1);
  assert.ok(text.endsWith("\n"));
  assert.match(text, /\n {4}"ultrasearch": \{/);
});

test("config-edit: upsert is idempotent for an equal entry and reports no change", () => {
  const before = `{\n  "mcpServers": {\n    "ultrasearch": { "command": "/bin/us", "args": [] }\n  }\n}\n`;
  const { changed } = upsertJsonEntry(before, ["mcpServers"], "ultrasearch", { command: "/bin/us", args: [] });
  assert.equal(changed, false);
});

test("config-edit: merge keeps unmanaged keys the user added to our entry", () => {
  const before = `{"mcpServers":{"ultrasearch":{"command":"/old","args":[],"custom":true,"env":{"A":"1"}}}}`;
  const { text } = upsertJsonEntry(before, ["mcpServers"], "ultrasearch", { command: "/new", args: [] }, { merge: true });
  assert.deepEqual(JSON.parse(text).mcpServers.ultrasearch, { command: "/new", args: [], custom: true, env: { A: "1" } });
});

test("config-edit: upsert creates the whole server map on an empty root object", () => {
  const { text } = upsertJsonEntry("{}\n", ["mcpServers"], "ultrasearch", { command: "/bin/us", args: [] });
  assert.deepEqual(JSON.parse(text), { mcpServers: { ultrasearch: { command: "/bin/us", args: [] } } });
  assert.match(text, /^\{\n {2}"mcpServers": \{\n {4}"ultrasearch": \{/);
});

test("config-edit: upsert creates a missing server map next to existing keys", () => {
  const before = `{\n  "theme": "dark",\n  "context_servers": {}\n}\n`;
  const { text } = upsertJsonEntry(before, ["context_servers"], "ultrasearch", { command: "/bin/us" });
  const parsed = JSON.parse(text);
  assert.equal(parsed.theme, "dark");
  assert.deepEqual(parsed.context_servers.ultrasearch, { command: "/bin/us" });
  assert.match(text, /"context_servers": \{\n {4}"ultrasearch"/);
});

test("config-edit: upsert refuses unparseable JSON", () => {
  assert.throws(() => upsertJsonEntry("{oops", ["mcpServers"], "ultrasearch", {}), /unparseable JSON/);
});

// ---------------------------------------------------------------------------
// JSON removal
// ---------------------------------------------------------------------------

test("config-edit: removing a middle entry keeps neighbours and valid JSON", () => {
  const before = `{\n  "mcpServers": {\n    "aaa": { "command": "a" },\n    "ultrasearch": { "command": "us" },\n    "zzz": { "command": "z" }\n  }\n}\n`;
  const { text, changed } = removeJsonEntry(before, ["mcpServers"], "ultrasearch");
  assert.equal(changed, true);
  assert.deepEqual(JSON.parse(text), { mcpServers: { aaa: { command: "a" }, zzz: { command: "z" } } });
  assert.ok(!text.includes("ultrasearch"));
});

test("config-edit: removing the last entry also removes the previous comma", () => {
  const before = `{\n  "mcpServers": {\n    "aaa": { "command": "a" },\n    "ultrasearch": { "command": "us" }\n  }\n}\n`;
  const { text } = removeJsonEntry(before, ["mcpServers"], "ultrasearch");
  assert.deepEqual(JSON.parse(text), { mcpServers: { aaa: { command: "a" } } });
  assert.ok(!/,\s*\}/.test(text));
});

test("config-edit: removing the only entry leaves an empty map", () => {
  const before = `{\n  "context_servers": {\n    "ultrasearch": { "command": "us" }\n  }\n}\n`;
  const { text } = removeJsonEntry(before, ["context_servers"], "ultrasearch");
  assert.deepEqual(JSON.parse(text), { context_servers: {} });
});

test("config-edit: removing from a compact document works and is a no-op when absent", () => {
  const before = `{"servers":{"a":{"command":"a"},"ultrasearch":{"command":"us"}}}`;
  const { text } = removeJsonEntry(before, ["servers"], "ultrasearch");
  assert.deepEqual(JSON.parse(text), { servers: { a: { command: "a" } } });
  const { changed } = removeJsonEntry(text, ["servers"], "ultrasearch");
  assert.equal(changed, false);
});

// ---------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------

test("config-edit: toml upsert appends a section and keeps earlier tables intact", () => {
  const before = `model = "gpt-5"\n\n[mcp_servers.rea]\ncommand = "/bin/rea"\nargs = ["mcp"]\n`;
  const { text, changed } = upsertTomlSection(before, ["mcp_servers", "ultrasearch"], {
    command: "/bin/us",
    args: [],
  });
  assert.equal(changed, true);
  assert.equal(checkToml(text).ok, true);
  assert.deepEqual(readTomlSection(text, ["mcp_servers", "ultrasearch"]), { command: "/bin/us", args: [] });
  assert.deepEqual(readTomlSection(text, ["mcp_servers", "rea"]), { command: "/bin/rea", args: ["mcp"] });
  assert.match(text, /\[mcp_servers\.ultrasearch\]\ncommand = "\/bin\/us"\nargs = \[\]/);
});

test("config-edit: toml upsert into a fresh file creates only our table", () => {
  const { text } = upsertTomlSection("", ["mcp_servers", "ultrasearch"], { command: "/bin/us" });
  assert.equal(text, `[mcp_servers.ultrasearch]\ncommand = "/bin/us"\n`);
  assert.equal(checkToml(text).ok, true);
});

test("config-edit: toml upsert updates in place and is idempotent", () => {
  const before = `[mcp_servers.ultrasearch]\ncommand = "/old"\nargs = []\n\n[desktop]\nfollowUpQueueMode = "steer"\n`;
  const first = upsertTomlSection(before, ["mcp_servers", "ultrasearch"], { command: "/new", args: ["--x"] });
  assert.equal(readTomlSection(first.text, ["mcp_servers", "ultrasearch"])?.command, "/new");
  assert.equal(readTomlSection(first.text, ["desktop"])?.followUpQueueMode, "steer");
  const second = upsertTomlSection(first.text, ["mcp_servers", "ultrasearch"], { command: "/new", args: ["--x"] });
  assert.equal(second.changed, false, "re-writing the same table must be a no-op");
  assert.equal(second.text, first.text);
});

test("config-edit: toml removal drops only our table", () => {
  const before = `[mcp_servers.rea]\ncommand = "/bin/rea"\n\n[mcp_servers.ultrasearch]\ncommand = "/bin/us"\n\n[desktop]\nfollowUpQueueMode = "steer"\n`;
  const { text } = removeTomlSection(before, ["mcp_servers", "ultrasearch"]);
  assert.equal(checkToml(text).ok, true);
  assert.equal(readTomlSection(text, ["mcp_servers", "ultrasearch"]), undefined);
  assert.deepEqual(readTomlSection(text, ["mcp_servers", "rea"]), { command: "/bin/rea" });
  assert.equal(readTomlSection(text, ["desktop"])?.followUpQueueMode, "steer");
});

test("config-edit: toml refuses an inline mcp_servers root key instead of guessing", () => {
  const note = { ok: false, reason: String(checkToml(`mcp_servers = { ultrasearch = { command = "/bin/us" } }\n`).reason) };
  assert.match(note.reason, /refusing to guess/);
  assert.throws(
    () => upsertTomlSection(`mcp_servers = { ultrasearch = { command = "/bin/us" } }\n`, ["mcp_servers", "ultrasearch"], { command: "/x" }),
    /unparseable TOML/
  );
});

test("config-edit: toml refuses duplicate tables", () => {
  const check = checkToml(`[mcp_servers.ultrasearch]\ncommand = "/a"\n\n[mcp_servers.ultrasearch]\ncommand = "/b"\n`);
  assert.equal(check.ok, false);
  assert.match(String(check.reason), /duplicate/);
});

test("config-edit: toml quoted section names are matched", () => {
  const before = `[mcp_servers."ultrasearch"]\ncommand = "/old"\n`;
  const { text } = upsertTomlSection(before, ["mcp_servers", "ultrasearch"], { command: "/new" });
  assert.match(text, /command = "\/new"/);
});

// ---------------------------------------------------------------------------
// read-back
// ---------------------------------------------------------------------------

test("config-edit: readJsonEntry returns undefined for a missing path or key", () => {
  const text = `{"mcpServers":{"a":{"command":"a"}}}\n`;
  assert.deepEqual(readJsonEntry(text, ["mcpServers"], "a"), { command: "a" });
  assert.equal(readJsonEntry(text, ["mcpServers"], "b"), undefined);
  assert.equal(readJsonEntry(text, ["nope"], "a"), undefined);
  assert.equal(readJsonEntry("{bad", ["mcpServers"], "a"), undefined);
});
