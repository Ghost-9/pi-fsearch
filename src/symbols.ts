/**
 * Symbol extraction and definitions-first ranking (issue #26, wave 2 relevance).
 *
 * Layout:
 *   - tree-sitter adapter (WASM, optional at runtime) for TypeScript/JavaScript,
 *     Go and Rust. Grammars are looked up in `PI_ULTRASEARCH_GRAMMAR_DIR`,
 *     `~/.cache/pi-ultrasearch-grammars`, and the package's own `node_modules`
 *     (`@vscode/tree-sitter-wasm/wasm`, `tree-sitter-wasms/out`).
 *   - regex fallback for every language (and the only engine for Swift, where
 *     no ABI-compatible WASM grammar is distributed).
 *
 * The ranking half of this module is engine-independent: it consumes the files a
 * literal grep already found and orders them definitions-first, so `mode: "symbol"`
 * keeps every reference file (recall) while putting the declaring file on top.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { UltraSearchGrepFile, UltraSearchGrepMatch } from "./types.ts";

export type SymbolKind = "fn" | "method" | "class" | "type" | "var" | "property" | "module";
export type SymbolEngine = "tree-sitter" | "regex";

export interface SymbolDefinition {
  name: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
  language: string;
}

export interface SymbolExtraction {
  definitions: SymbolDefinition[];
  engine: SymbolEngine;
}

export interface SymbolIndexEntry {
  path: string;
  language: string | null;
  engine: SymbolEngine;
  definitions: SymbolDefinition[];
}

/** Match line decorated with the definition tier the symbol ranker assigned. */
export interface TaggedGrepMatch extends UltraSearchGrepMatch {
  /** `def:<kind>` when this line declares the queried symbol, `ref` otherwise. */
  symbolTag?: string;
  /** Which definition tier this file landed in: 0 declares, 2 references. */
  symbolTier?: number;
}

export interface TaggedGrepFile extends UltraSearchGrepFile {
  matches: TaggedGrepMatch[];
  /** Ranking evidence for explain output. */
  symbolExplain?: { tier: number; declaration: SymbolDefinition | null; engine: SymbolEngine };
}

// -------------------------------------------------------------------- language

const EXT_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".go": "go",
  ".rs": "rust",
  ".swift": "swift",
};

export function languageForFile(filePath: string): string | null {
  return EXT_LANGUAGE[path.extname(filePath).toLowerCase()] ?? null;
}

// ------------------------------------------------------------- regex fallback

interface RegexRule {
  re: RegExp;
  kind: SymbolKind;
}

const REGEX_RULES: RegexRule[] = [
  // Rust / Go / Swift / TS function shapes.
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:static\s+)?(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/, kind: "fn" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:static\s+)?(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?fn\s+([A-Za-z_$][\w$]*)/, kind: "fn" },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "fn" },
  { re: /^\s*def\s+([A-Za-z_$][\w$]*)/, kind: "fn" },
  // Types.
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:default\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^\s*(?:export\s+)?(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?protocol\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^\s*(?:export\s+)?(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?extension\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^\s*(?:export\s+)?typealias\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  // Variables / constants (named, not destructured).
  { re: /^\s*(?:export\s+)?(?:default\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "var" },
  { re: /^\s*(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "var" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_$][\w$]*)/, kind: "var" },
  { re: /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?(?:var|let)\s+([A-Za-z_$][\w$]*)\s*[:=]/, kind: "var" },
];

function isExportedText(line: string): boolean {
  return /\b(export|default|pub)\b/.test(line) || /^\s*(?:public|open)\s/.test(line);
}

/** Regex-based symbol extraction: the fallback engine, and Swift's only engine. */
export function extractSymbolsRegex(text: string, language: string): SymbolDefinition[] {
  const out: SymbolDefinition[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    for (const rule of REGEX_RULES) {
      const m = rule.re.exec(line);
      if (m && m[1]) {
        out.push({ name: m[1], kind: rule.kind, line: i + 1, exported: isExportedText(line), language });
        break;
      }
    }
  }
  return out;
}

// -------------------------------------------------------------- tree-sitter

interface GrammarStatus {
  available: boolean;
  reason?: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

function grammarSearchDirs(): string[] {
  return [
    process.env.PI_ULTRASEARCH_GRAMMAR_DIR,
    path.join(process.env.HOME ?? "", ".cache", "pi-ultrasearch-grammars"),
    path.join(REPO_ROOT, "node_modules", "@vscode", "tree-sitter-wasm", "wasm"),
    path.join(REPO_ROOT, "node_modules", "tree-sitter-wasms", "out"),
    path.join(process.cwd(), "node_modules", "@vscode", "tree-sitter-wasm", "wasm"),
    path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out"),
  ].filter((d): d is string => Boolean(d));
}

function findGrammarFile(language: string, dir: string): string | null {
  const candidates = [
    `tree-sitter-${language}.wasm`,
    // tree-sitter-wasms names TypeScript templates differently.
    language === "tsx" ? "tree-sitter-tsx.wasm" : "",
  ].filter(Boolean);
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let treeSitterLib: any = null;
let treeSitterInit: Promise<any> | null = null;
const parserCache = new Map<string, any>();

async function getParserLib(): Promise<any> {
  if (treeSitterLib) return treeSitterLib;
  if (treeSitterInit) return treeSitterInit;
  treeSitterInit = (async () => {
    // Optional dependency: the extension stays functional (regex fallback) when absent.
    // @ts-ignore -- resolved at runtime; intentionally not a hard dependency.
    const mod: any = await import("web-tree-sitter");
    await mod.Parser.init();
    treeSitterLib = mod;
    return mod;
  })();
  return treeSitterInit;
}

async function getParser(language: string): Promise<any | null> {
  if (parserCache.has(language)) return parserCache.get(language);
  let parser: any = null;
  try {
    const mod = await getParserLib();
    let grammarPath: string | null = null;
    for (const dir of grammarSearchDirs()) {
      if (!fs.existsSync(dir)) continue;
      grammarPath = findGrammarFile(language, dir);
      if (grammarPath) break;
    }
    if (!grammarPath) return null;
    const lang = await mod.Language.load(grammarPath);
    parser = new mod.Parser();
    parser.setLanguage(lang);
  } catch {
    parser = null;
  }
  parserCache.set(language, parser);
  return parser;
}

const AST_KIND_BY_NODE: Record<string, SymbolKind> = {
  function_declaration: "fn",
  function_definition: "fn",
  generator_function_declaration: "fn",
  function_item: "fn",
  function_signature_item: "fn",
  method_definition: "method",
  method_declaration: "method",
  class_declaration: "class",
  abstract_class_declaration: "class",
  class_definition: "class",
  struct_item: "type",
  struct_declaration: "type",
  interface_declaration: "type",
  protocol_declaration: "type",
  trait_item: "type",
  enum_declaration: "type",
  enum_item: "type",
  union_declaration: "type",
  type_alias_declaration: "type",
  type_item: "type",
  type_spec: "type",
  typealias_declaration: "type",
  const_item: "var",
  static_item: "var",
  lexical_declaration: "var",
  variable_declaration: "var",
  property_declaration: "property",
  const_declaration: "var",
};

function nodeLooksExported(node: any): boolean {
  try {
    const parent = node.parent;
    if (parent && (parent.type === "export_statement" || parent.type === "modifiers" || parent.type === "attribute_item")) return true;
    const text = node.text.slice(0, 160);
    return /\bexport\b|\bpub\b|^\s*public\s|^\s*open\s/.test(text);
  } catch {
    return false;
  }
}

function firstNamedChild(node: any): any | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.isNamed) return c;
  }
  return null;
}

function extractNameNode(node: any): any | null {
  const direct = node.childForFieldName?.("name");
  if (direct) return direct;
  // Go/Rust wrap the name in an inner spec node (`type_spec`, `const_spec`, ...).
  const inner = firstNamedChild(node);
  if (inner) {
    const innerName = inner.childForFieldName?.("name");
    if (innerName) return innerName;
  }
  return null;
}

/** Tree-sitter symbol extraction. Returns null when no grammar is available. */
export async function extractSymbolsTreeSitter(
  text: string,
  language: string
): Promise<SymbolDefinition[] | null> {
  const parser = await getParser(language);
  if (!parser) return null;
  try {
    const tree = parser.parse(text);
    if (!tree) return null;
    const declarations = tree.rootNode.descendantsOfType(Object.keys(AST_KIND_BY_NODE));
    const out: SymbolDefinition[] = [];
    for (const node of declarations) {
      const kind = AST_KIND_BY_NODE[node.type];
      if (!kind) continue;
      const nameNode = extractNameNode(node);
      const name = nameNode?.text;
      if (!name || name.length > 120 || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      // Skip declarations nested in a function body: too noisy for file-level ranking.
      let p = node.parent;
      let depth = 0;
      while (p && depth < 6) {
        if (p.type === "function_declaration" || p.type === "function_item" || p.type === "method_definition") break;
        p = p.parent;
        depth++;
      }
      if (p) continue;
      out.push({ name, kind, line: node.startPosition.row + 1, exported: nodeLooksExported(node), language });
    }
    return out;
  } catch {
    return null;
  }
}

export async function extractSymbols(text: string, language: string): Promise<SymbolExtraction> {
  const viaAst = await extractSymbolsTreeSitter(text, language);
  if (viaAst) return { definitions: viaAst, engine: "tree-sitter" };
  return { definitions: extractSymbolsRegex(text, language), engine: "regex" };
}

export async function grammarStatus(): Promise<Record<string, GrammarStatus>> {
  const out: Record<string, GrammarStatus> = {};
  for (const lang of ["typescript", "tsx", "javascript", "go", "rust", "swift"]) {
    const p = await getParser(lang);
    out[lang] = p ? { available: true } : { available: false, reason: "no ABI-compatible WASM grammar found" };
  }
  return out;
}

// --------------------------------------------------------------- file index

const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const indexCache = new Map<string, { mtimeMs: number; size: number; entry: SymbolIndexEntry }>();

export async function indexFile(filePath: string): Promise<SymbolIndexEntry | null> {
  const language = languageForFile(filePath);
  if (!language) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_INDEX_BYTES) return null;
  const cached = indexCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.entry;
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const { definitions, engine } = await extractSymbols(text, language);
  const entry: SymbolIndexEntry = { path: filePath, language, engine, definitions };
  indexCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, entry });
  return entry;
}

/** Test seam / cache hygiene. */
export function clearSymbolCache(): void {
  indexCache.clear();
}

function normalName(name: string): string {
  return name.replace(/^.*[.:]/, "").replace(/[<>]/g, "").trim();
}

/** Exact declaration of `symbolName` (case-sensitive, last dotted segment aware). */
export function declarationOf(entry: SymbolIndexEntry, symbolName: string): SymbolDefinition | null {
  const wanted = normalName(symbolName);
  for (const d of entry.definitions) {
    if (d.name === symbolName || d.name === wanted) return d;
  }
  return null;
}

function referenceLines(file: UltraSearchGrepFile, symbolName: string): number {
  const wanted = normalName(symbolName);
  let n = 0;
  for (const m of file.matches ?? []) {
    if (typeof m.text === "string" && (m.text.includes(symbolName) || m.text.includes(wanted))) n++;
  }
  return n;
}

export interface RankSymbolFilesOptions {
  /** Cap on files that get an AST index read (perf guard). */
  maxIndex?: number;
}

/**
 * Definitions-first file ranking for `mode: "symbol"`.
 *
 * Tier 0: the file declares the symbol (AST when available, regex otherwise).
 * Tier 1: the file declares a symbol whose name contains the queried one.
 * Tier 2: references only (kept, ranked after declarations).
 *
 * Every input file is preserved (recall), and declaration matches are tagged
 * `def:<kind>` so the formatter can print `[def:fn]` from real definitions.
 */
export async function rankSymbolFiles(
  files: UltraSearchGrepFile[],
  symbolName: string,
  options: RankSymbolFilesOptions = {}
): Promise<{ files: TaggedGrepFile[]; engine: SymbolEngine; engineByFile: Record<string, SymbolEngine> }> {
  const maxIndex = options.maxIndex ?? 200;
  const wanted = normalName(symbolName);
  const ranked: Array<{ file: TaggedGrepFile; tier: number; refs: number; engine: SymbolEngine }> = [];
  const engineByFile: Record<string, SymbolEngine> = {};
  let anyTreeSitter = false;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let tier = 2;
    let declaration: SymbolDefinition | null = null;
    let engine: SymbolEngine = "regex";
    if (i < maxIndex && /^[A-Za-z_$][\w$]*$/.test(wanted)) {
      const entry = await indexFile(file.path);
      if (entry) {
        engine = entry.engine;
        if (engine === "tree-sitter") anyTreeSitter = true;
        declaration = declarationOf(entry, symbolName);
        if (declaration) tier = 0;
        else if (entry.definitions.some((d) => d.name.includes(wanted) || wanted.includes(d.name))) tier = 1;
      }
    }
    engineByFile[file.path] = engine;
    const decorated: TaggedGrepFile = {
      ...file,
      matches: (file.matches ?? []).map((m) => {
        if (!declaration || m.line !== declaration.line) return { ...m } as TaggedGrepMatch;
        return { ...m, symbolTag: `def:${declaration.kind}`, symbolTier: 0 } as TaggedGrepMatch;
      }),
      symbolExplain: { tier, declaration, engine },
    };
    ranked.push({ file: decorated, tier, refs: referenceLines(file, symbolName), engine });
  }

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    // More references first inside a tier: the file that talks about the symbol most.
    if (b.refs !== a.refs) return b.refs - a.refs;
    const da = a.file.path.split("/").length;
    const db = b.file.path.split("/").length;
    if (da !== db) return da - db;
    return a.file.path.localeCompare(b.file.path);
  });

  return {
    files: ranked.map((r) => r.file),
    engine: anyTreeSitter ? "tree-sitter" : "regex",
    engineByFile,
  };
}

/**
 * Formatter support: tag match lines with the symbol they declare, using an
 * already-computed symbol index when the caller has one.
 */
export function tagGrepMatchesWithDefinitions(
  files: UltraSearchGrepFile[],
  entryByPath: Map<string, SymbolIndexEntry>
): TaggedGrepFile[] {
  return files.map((f) => {
    const entry = entryByPath.get(f.path);
    if (!entry) return f as TaggedGrepFile;
    const byLine = new Map<number, SymbolDefinition>();
    for (const d of entry.definitions) byLine.set(d.line, d);
    return {
      ...f,
      matches: (f.matches ?? []).map((m) => {
        const d = byLine.get(m.line);
        return d ? ({ ...m, symbolTag: `def:${d.kind}` } as TaggedGrepMatch) : ({ ...m } as TaggedGrepMatch);
      }),
    } as TaggedGrepFile;
  });
}
