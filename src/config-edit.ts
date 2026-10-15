/**
 * Surgical config editing for `ultrasearch init` (issue #51).
 *
 * Why not `JSON.parse` + `JSON.stringify`: harness configs are user files that
 * mix machine state with hand-written formatting (`~/.claude.json` is tens of
 * kilobytes of Claude Code state; `~/.config/zed/settings.json` is JSONC with
 * comments). Rewriting them wholesale would reformat unrelated content and
 * lose comments. So every edit here is a textual splice over a *validated*
 * document:
 *
 *   1. the file must parse (JSON, JSONC, or a conservative TOML scan),
 *   2. the exact member/section the tool owns is located by a scanner,
 *   3. the smallest possible splice is applied,
 *   4. the result is re-parsed and the entry is read back before it is written.
 *
 * Anything that cannot be done that way is refused by the caller, never
 * guessed at. Pure functions only — no filesystem access, so tests can run
 * entirely in memory.
 */

export type ConfigFormat = "json" | "jsonc" | "toml";

export interface ParseCheck {
  ok: boolean;
  reason?: string;
}

export interface EditResult {
  /** Resulting text (equal to the input when `changed` is false). */
  text: string;
  changed: boolean;
}

// ---------------------------------------------------------------------------
// JSON / JSONC
// ---------------------------------------------------------------------------

/**
 * Blank `//` and block comments and trailing commas, preserving every byte
 * offset so scanner positions remain valid against the original text. String
 * contents are never touched.
 */
export function normalizeJsonc(text: string): string {
  const chars = text.split("");
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '"') {
      i++;
      while (i < chars.length) {
        if (chars[i] === "\\") {
          i += 2;
          continue;
        }
        if (chars[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n") chars[i++] = " ";
      continue;
    }
    if (c === "/" && chars[i + 1] === "*") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) {
        if (chars[i] !== "\n") chars[i] = " ";
        i++;
      }
      if (i < chars.length) {
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    i++;
  }

  // Second pass: blank trailing commas (`,` followed only by whitespace and a
  // closer), again preserving offsets. String-aware, so `"a, ]"` is untouched.
  i = 0;
  while (i < chars.length) {
    if (chars[i] === '"') {
      i++;
      while (i < chars.length) {
        if (chars[i] === "\\") {
          i += 2;
          continue;
        }
        if (chars[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (chars[i] === ",") {
      let j = i + 1;
      while (j < chars.length && /\s/.test(chars[j] ?? "")) j++;
      if (chars[j] === "}" || chars[j] === "]") chars[i] = " ";
    }
    i++;
  }
  return chars.join("");
}

interface JsonMember {
  key: string;
  /** Index of the opening quote of the key. */
  keyStart: number;
  /** Index after the closing quote of the value. */
  memberEnd: number;
  valueStart: number;
  valueEnd: number;
}

interface JsonObject {
  /** Index of `{`. */
  start: number;
  /** Index after `}`. */
  end: number;
  members: JsonMember[];
  /** True when the object spans lines, with `indent` for new members. */
  multiline: boolean;
  indent: string;
}

function skipWs(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i] as string)) i++;
  return i;
}

function scanString(text: string, i: number): { end: number; value: string } {
  if (text[i] !== '"') throw new Error(`expected string at offset ${i}`);
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (text[j] === '"') break;
    j++;
  }
  if (j >= text.length) throw new Error("unterminated string");
  return { end: j + 1, value: JSON.parse(text.slice(i, j + 1)) as string };
}

/** Scan one JSON value starting at `i`; returns the index after it. */
function scanValue(text: string, i: number): number {
  const c = text[i];
  if (c === '"') return scanString(text, i).end;
  if (c === "{") return scanObject(text, i).end;
  if (c === "[") {
    let j = i + 1;
    for (;;) {
      j = skipWs(text, j);
      if (text[j] === "]") return j + 1;
      if (text[j] === ",") {
        j++;
        continue;
      }
      j = scanValue(text, j);
    }
  }
  // number / true / false / null
  let j = i;
  while (j < text.length && !/[\s,}\]]/.test(text[j] as string)) j++;
  if (j === i) throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
  return j;
}

function scanObject(text: string, i: number): JsonObject {
  if (text[i] !== "{") throw new Error(`expected object at offset ${i}`);
  const start = i;
  i++;
  const afterBrace = i;
  const lineBreak = /^[ \t]*\n([ \t]*)/.exec(text.slice(afterBrace));
  const multiline = Boolean(lineBreak);
  const indent = lineBreak?.[1] ?? "  ";
  const members: JsonMember[] = [];
  for (;;) {
    i = skipWs(text, i);
    if (text[i] === "}") return { start, end: i + 1, members, multiline, indent };
    if (text[i] === ",") {
      i++;
      continue;
    }
    const keyStart = i;
    const key = scanString(text, i);
    i = skipWs(text, key.end);
    if (text[i] !== ":") throw new Error(`expected ':' at offset ${i}`);
    i = skipWs(text, i + 1);
    const valueStart = i;
    const valueEnd = scanValue(text, i);
    members.push({ key: key.value, keyStart, memberEnd: valueEnd, valueStart, valueEnd });
    i = valueEnd;
  }
}

/** Parse a JSON/JSONC document, returning the reason on failure. */
export function checkJson(text: string, jsonc = false): ParseCheck {
  const normalized = jsonc ? normalizeJsonc(text) : text;
  try {
    JSON.parse(normalized);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

interface LocatedObject {
  root: JsonObject;
  /** The object at the end of `keyPath`, or null when any segment is missing. */
  target: JsonObject | null;
}

function locate(text: string, keyPath: readonly string[]): LocatedObject {
  const normalized = text;
  let obj = scanObject(normalized, skipWs(normalized, 0));
  let target: JsonObject | null = obj;
  for (const segment of keyPath) {
    if (!target) break;
    const member = target.members.find((m) => m.key === segment);
    if (!member) {
      target = null;
      break;
    }
    const at = skipWs(normalized, member.valueStart);
    if (normalized[at] !== "{") {
      target = null;
      break;
    }
    target = scanObject(normalized, at);
  }
  return { root: obj, target };
}

function splice(text: string, start: number, end: number, insert: string): string {
  return text.slice(0, start) + insert + text.slice(end);
}

function indentBlock(json: string, baseIndent: string): string {
  return json
    .split("\n")
    .map((line, idx) => (idx === 0 ? line : baseIndent + line))
    .join("\n");
}

/** Insert `key: value` as the first member of `obj`. */
function insertMember(text: string, obj: JsonObject, key: string, value: unknown): string {
  const keyLiteral = JSON.stringify(key);
  if (obj.members.length === 0) {
    const serialized = JSON.stringify(value, null, 2) as string;
    if (!obj.multiline && serialized.includes("\n")) {
      // An empty inline object (e.g. a fresh `{}`) grows into a block so the
      // inserted value keeps readable indentation.
      const lineStart = text.lastIndexOf("\n", obj.start) + 1;
      const base = /^([ \t]*)/.exec(text.slice(lineStart))?.[1] ?? "";
      const rebuilt = `{\n${base}  ${keyLiteral}: ${indentBlock(serialized, `${base}  `)}\n${base}}`;
      return splice(text, obj.start, obj.end, rebuilt);
    }
    if (!obj.multiline) {
      return splice(text, obj.start + 1, obj.end - 1, `${keyLiteral}: ${serialized}`);
    }
    // Rebuild the empty object so indentation of the new member and the
    // existing closing brace both stay coherent.
    const closeIndentMatch = /\n([ \t]*)\}([ \t]*)$/.exec(text.slice(obj.start, obj.end));
    const closeIndent = closeIndentMatch?.[1] ?? "";
    const rebuilt = `{\n${obj.indent}${keyLiteral}: ${indentBlock(serialized, obj.indent)}\n${closeIndent}}`;
    return splice(text, obj.start, obj.end, rebuilt);
  }
  const first = obj.members[0] as JsonMember;
  if (obj.multiline) {
    const serialized = indentBlock(JSON.stringify(value, null, 2) as string, obj.indent);
    return splice(text, first.keyStart, first.keyStart, `${keyLiteral}: ${serialized},\n${obj.indent}`);
  }
  const serialized = JSON.stringify(value);
  return splice(text, first.keyStart, first.keyStart, `${keyLiteral}: ${serialized}, `);
}

/** Replace the value of an existing member, keeping surrounding formatting. */
function replaceValue(text: string, member: JsonMember, value: unknown, baseIndent: string): string {
  const serialized = indentBlock(JSON.stringify(value, null, 2) as string, baseIndent);
  return splice(text, member.valueStart, member.valueEnd, serialized);
}

/**
 * Read one entry from a JSON/JSONC document without editing it. Returns
 * `undefined` when any path segment or the final key is absent.
 */
export function readJsonEntry(text: string, keyPath: readonly string[], entryKey: string): unknown {
  try {
    // The scanner needs comments and trailing commas blanked; offsets are
    // preserved, so the located spans still refer to the original text.
    const normalized = normalizeJsonc(text);
    const { target } = locate(normalized, keyPath);
    const member = target?.members.find((m) => m.key === entryKey);
    if (!member) return undefined;
    // Values are read back through the parser for a ground-truth comparison.
    const parsed = JSON.parse(normalized) as Record<string, any>;
    let cur: any = parsed;
    for (const segment of keyPath) {
      cur = cur?.[segment];
      if (cur === undefined) return undefined;
    }
    return cur?.[entryKey];
  } catch {
    return undefined;
  }
}

/**
 * Insert or update `keyPath.entryKey = entryValue`. When the entry exists,
 * pass `merge` to update only the keys this tool manages while preserving
 * everything else the user or another tool stored in the entry.
 */
export function upsertJsonEntry(
  text: string,
  keyPath: readonly string[],
  entryKey: string,
  entryValue: unknown,
  opts: { jsonc?: boolean; merge?: boolean } = {}
): EditResult {
  const parse = checkJson(text, opts.jsonc ?? false);
  if (!parse.ok) throw new Error(`refusing to edit unparseable JSON: ${parse.reason}`);
  // The scanner runs over the normalized text; offsets match the original byte
  // for byte because normalization only blanks characters.
  const normalized = opts.jsonc ? normalizeJsonc(text) : text;
  const { root, target } = locate(normalized, keyPath);
  if (!target) {
    // Build the missing tail as a nested literal and insert its first segment.
    let nested: unknown = { [entryKey]: entryValue };
    for (let i = keyPath.length - 1; i >= 0; i--) nested = { [keyPath[i] as string]: nested };
    const outerKey = Object.keys(nested as Record<string, unknown>)[0] as string;
    const next = insertMember(text, root, outerKey, (nested as Record<string, unknown>)[outerKey]);
    return { text: next, changed: next !== text };
  }
  const existing = target.members.find((m) => m.key === entryKey);
  if (!existing) {
    const next = insertMember(text, target, entryKey, entryValue);
    return { text: next, changed: next !== text };
  }
  const current = readJsonEntry(text, keyPath, entryKey);
  const desired =
    opts.merge && current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>), ...(entryValue as Record<string, unknown>) }
      : entryValue;
  if (deepEqual(current, desired)) return { text, changed: false };
  const lineStart = text.lastIndexOf("\n", existing.keyStart) + 1;
  const baseIndent = /^[ \t]*$/.test(text.slice(lineStart, existing.keyStart)) ? text.slice(lineStart, existing.keyStart) : "";
  const next = replaceValue(text, existing, desired, baseIndent);
  return { text: next, changed: true };
}

/**
 * Remove `keyPath.entryKey`, together with the comma that separated it, and
 * nothing else. Returns unchanged text when the entry is absent.
 */
export function removeJsonEntry(
  text: string,
  keyPath: readonly string[],
  entryKey: string
): EditResult {
  const parse = checkJson(text, false);
  if (!parse.ok) throw new Error(`refusing to edit unparseable JSON: ${parse.reason}`);
  const { target } = locate(text, keyPath);
  const member = target?.members.find((m) => m.key === entryKey);
  if (!member) return { text, changed: false };

  const newlineAfter = text.indexOf("\n", member.memberEnd);
  const lineStart = text.lastIndexOf("\n", member.keyStart) + 1;
  const lineEnd = newlineAfter === -1 ? text.length : newlineAfter + 1;
  const beforeOnLine = text.slice(lineStart, member.keyStart);
  const afterOnLine = text.slice(member.memberEnd, newlineAfter === -1 ? text.length : newlineAfter);
  const ownLine = /^[ \t]*$/.test(beforeOnLine) && /^[ \t]*,?[ \t]*$/.test(afterOnLine);

  let start = member.keyStart;
  let end = member.memberEnd;
  if (ownLine) {
    start = lineStart;
    end = lineEnd;
    // When the removed member was last, the previous member's trailing comma
    // must go too or the document stops parsing.
    const nextNonWs = skipWs(text, end);
    if (text[nextNonWs] === "}" || text[nextNonWs] === "]") {
      let j = start - 1;
      while (j >= 0 && /\s/.test(text[j] as string)) j--;
      if (text[j] === ",") start = j;
    }
  } else {
    let j = end;
    while (j < text.length && /\s/.test(text[j] as string)) j++;
    if (text[j] === ",") end = j + 1;
    else {
      let k = start - 1;
      while (k >= 0 && /\s/.test(text[k] as string)) k--;
      if (text[k] === ",") start = k;
    }
  }
  const next = splice(text, start, end, "");
  const after = checkJson(next, false);
  if (!after.ok) throw new Error(`removal would produce invalid JSON: ${after.reason}`);
  return { text: next, changed: true };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  for (const key of ak) {
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// TOML (the conservative subset Codex CLI writes: tables of key = value)
// ---------------------------------------------------------------------------

interface TomlSection {
  /** Dotted, unquoted path, e.g. `mcp_servers.rea`. */
  path: string[];
  /** Index of the header line. */
  headerLine: number;
  /** Index after the last line of the section body. */
  endLine: number;
}

interface TomlScan {
  sections: TomlSection[];
  lineStarts: number[];
  lines: string[];
  error?: string;
}

function parseSectionPath(inner: string): string[] {
  return inner
    .split(".")
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
    .filter(Boolean);
}

/** Balance state of one logical TOML line (quotes, arrays, inline tables). */
function unbalancedReason(line: string): string | null {
  let quote: string | null = null;
  let brackets = 0;
  let braces = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      if (line.slice(i, i + 3) === c + c + c) return "multiline strings are not supported";
      quote = c;
      continue;
    }
    if (c === "#") break; // comment outside a string
    if (c === "[") brackets++;
    else if (c === "]") {
      brackets--;
      if (brackets < 0) return "unbalanced ]";
    } else if (c === "{") braces++;
    else if (c === "}") {
      braces--;
      if (braces < 0) return "unbalanced }";
    }
  }
  if (quote) return "unterminated string";
  if (brackets !== 0) return "open bracket";
  if (braces !== 0) return "open brace";
  return null;
}

/** Index of the `=` that separates a key from its value, or -1. */
function assignmentIndex(line: string): number {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote) {
      if (c === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      if (line.slice(i, i + 3) === c + c + c) return -1;
      quote = c;
      continue;
    }
    if (c === "#") return -1;
    if (c === "=") return i;
  }
  return -1;
}

interface LogicalLine {
  text: string;
  /** First raw line index. */
  startRaw: number;
  /** Raw line index after the last line of this logical line. */
  endRaw: number;
}

/**
 * Group raw lines into logical lines so a multi-line array value stays one
 * unit. Balance failures (an unterminated string, an unclosed bracket at EOF)
 * are errors, never guesses.
 */
function logicalLines(lines: string[]): { lines: LogicalLine[]; error?: string } {
  const out: LogicalLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const startRaw = i;
    let text = lines[i] as string;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push({ text, startRaw, endRaw: i + 1 });
      i++;
      continue;
    }
    const header = /^\[\[?(.+?)\]\]?$/.exec(trimmed);
    if (header) {
      const reason = unbalancedReason(text);
      if (reason) return { lines: out, error: `unsupported table header (${reason}): ${JSON.stringify(text)}` };
      out.push({ text, startRaw, endRaw: i + 1 });
      i++;
      continue;
    }
    let reason = unbalancedReason(text);
    while (reason === "open bracket" || reason === "open brace") {
      i++;
      if (i >= lines.length) return { lines: out, error: `unclosed value in TOML starting at line ${startRaw + 1}` };
      text += `\n${lines[i]}`;
      reason = unbalancedReason(text);
    }
    if (reason) return { lines: out, error: `unsupported TOML value (${reason}): ${JSON.stringify(trimmed)}` };
    out.push({ text, startRaw, endRaw: i + 1 });
    i++;
  }
  return { lines: out };
}

/**
 * Conservative TOML scan: enough structure to patch one table safely, and
 * explicit failure on anything this tool would not know how to edit.
 */
export function scanToml(text: string): TomlScan {
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const logical = logicalLines(lines);
  if (logical.error) return { sections: [], lineStarts, lines, error: logical.error };
  const sections: TomlSection[] = [];
  let current: TomlSection | null = null;
  let seenHeader = false;
  for (const line of logical.lines) {
    const trimmed = line.text.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const header = /^\[\[?(.+?)\]\]?$/.exec(trimmed);
    if (header) {
      if (current) current.endLine = line.startRaw;
      current = { path: parseSectionPath(header[1] as string), headerLine: line.startRaw, endLine: lines.length };
      sections.push(current);
      seenHeader = true;
      continue;
    }
    if (trimmed.startsWith("[")) return { sections, lineStarts, lines, error: `unsupported table header: ${JSON.stringify(line.text)}` };
    const eq = assignmentIndex(line.text);
    if (eq === -1) return { sections, lineStarts, lines, error: `unsupported TOML line: ${JSON.stringify(line.text)}` };
    const key = line.text.slice(0, eq).trim();
    const value = line.text.slice(eq + 1).trim();
    if (!key || !value) return { sections, lineStarts, lines, error: `unsupported TOML assignment: ${JSON.stringify(line.text)}` };
    if (!seenHeader && key.startsWith("mcp_servers")) {
      return { sections, lineStarts, lines, error: "mcp_servers is declared as a dotted/root key; refusing to guess the table layout" };
    }
  }
  // Close the final section on the last raw line of its body.
  if (current) {
    current.endLine = logical.lines.length ? (logical.lines[logical.lines.length - 1] as LogicalLine).endRaw : 0;
  }
  return { sections, lineStarts, lines };
}

export function checkToml(text: string): ParseCheck {
  const scan = scanToml(text);
  if (scan.error) return { ok: false, reason: scan.error };
  const seen = new Set<string>();
  for (const section of scan.sections) {
    const key = section.path.join(".");
    if (seen.has(key)) return { ok: false, reason: `duplicate table [${key}]` };
    seen.add(key);
  }
  return { ok: true };
}

function tomlBodyLines(entry: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) out.push(`${key} = [${value.map((v) => JSON.stringify(v)).join(", ")}]`);
    else if (typeof value === "string") out.push(`${key} = ${JSON.stringify(value)}`);
    else out.push(`${key} = ${String(value)}`);
  }
  return out;
}

/** Read one table from a TOML document as a plain object (best effort). */
export function readTomlSection(text: string, sectionPath: readonly string[]): Record<string, unknown> | undefined {
  const scan = scanToml(text);
  const wanted = sectionPath.join(".");
  const section = scan.sections.find((s) => s.path.join(".") === wanted);
  if (!section) return undefined;
  const body = scan.lines.slice(section.headerLine + 1, section.endLine);
  const result: Record<string, unknown> = {};
  for (const raw of body) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    try {
      result[key] = JSON.parse(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

/** Insert or replace a TOML table with exactly the given key/value body. */
export function upsertTomlSection(
  text: string,
  sectionPath: readonly string[],
  entry: Record<string, unknown>
): EditResult {
  const check = checkToml(text);
  if (!check.ok) throw new Error(`refusing to edit unparseable TOML: ${check.reason}`);
  const scan = scanToml(text);
  const wanted = sectionPath.join(".");
  const section = scan.sections.find((s) => s.path.join(".") === wanted);
  const body = tomlBodyLines(entry);
  if (!section) {
    const prefix = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
    const addition = `${prefix.length ? "\n" : ""}[${wanted}]\n${body.join("\n")}\n`;
    return { text: `${prefix}${addition}`, changed: true };
  }
  const headerIndex = section.headerLine;
  const endIndex = section.endLine;
  const replacement = [`[${wanted}]`, ...body];
  const lines = [...scan.lines];
  lines.splice(headerIndex, endIndex - headerIndex, ...replacement);
  const next = lines.join("\n");
  const after = checkToml(next);
  if (!after.ok) throw new Error(`table update would produce invalid TOML: ${after.reason}`);
  return { text: next, changed: next !== text };
}

/** Remove a TOML table and its preceding blank line, when present. */
export function removeTomlSection(text: string, sectionPath: readonly string[]): EditResult {
  const check = checkToml(text);
  if (!check.ok) throw new Error(`refusing to edit unparseable TOML: ${check.reason}`);
  const scan = scanToml(text);
  const wanted = sectionPath.join(".");
  const section = scan.sections.find((s) => s.path.join(".") === wanted);
  if (!section) return { text, changed: false };
  let start = section.headerLine;
  if (start > 0 && (scan.lines[start - 1] as string).trim() === "") start--;
  const lines = [...scan.lines];
  lines.splice(start, section.endLine - start);
  const next = lines.join("\n");
  const after = checkToml(next);
  if (!after.ok) throw new Error(`table removal would produce invalid TOML: ${after.reason}`);
  return { text: next, changed: next !== text };
}
