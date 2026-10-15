/**
 * Harness registry for `ultrasearch init` and the smoke matrix (issues #51, #52).
 *
 * One row per harness: where its MCP config lives, how a server entry is
 * shaped, which protocol revision its client speaks, and how to tell whether
 * it is installed. Adding a harness is adding a row here plus a smoke artifact
 * — no harness name is allowed anywhere in the core transport.
 *
 * `entryShape` records how each shape was established:
 *   - `machine-measured` — the harness's own CLI wrote it (temp HOME), or a
 *     live registration written by the harness was read on this machine;
 *   - `docs`             — taken from the vendor's current documentation;
 *   - `assumed`          — neither; the row is experimental and says so.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ConfigFormat } from "./config-edit.ts";

export type HarnessSurface = "mcp-stdio" | "pi-extension" | "pi-derived";
export type EntryShapeSource = "machine-measured" | "machine-observed" | "docs" | "assumed";
export type HarnessNativeProbe = "claude-mcp-list" | "codex-mcp-list" | "pi-interop-test" | null;

/** Where the launch command comes from, for the audit trail. */
export type LaunchSource = "explicit" | "env" | "installed" | "path";

export interface HarnessLaunch {
  command: string;
  args: string[];
  source: LaunchSource;
}

export interface HarnessSpec {
  id: string;
  label: string;
  surface: HarnessSurface;
  /** Home-relative (or absolute) config path per platform. */
  configPath: { darwin: string; linux: string };
  format: ConfigFormat;
  /** Key path inside the config leading to the server map. */
  serverKey: readonly string[];
  /** How one server entry is shaped for this harness. */
  entryKind: "command-args" | "claude-code-stdio" | "vscode-stdio" | "zed-command-args" | "pi-native";
  /** Keys this tool owns in an entry (merged into, never wholesale replacing). */
  managedKeys: readonly string[];
  entryShapeSource: EntryShapeSource;
  /** Protocol revision the smoke requests, and where that number comes from. */
  protocolVersion: string;
  protocolVersionSource: "measured" | "assumed";
  /** Smoke client identity; the harness's own identity where known. */
  clientInfo: { name: string; version: string };
  /** Executable names that indicate the harness is installed. */
  binaries: readonly string[];
  /** Absolute app-bundle/CLI paths that indicate installation. */
  appPaths: readonly string[];
  /** Files/dirs whose presence indicates installation even without a binary. */
  detectPaths: readonly string[];
  /** Directive file the harness reads (phase 3), documented only. */
  directive: string;
  /** `skip` means init refuses unless `--force` is passed, with this note. */
  initDefault: "write" | "skip";
  note: string;
  nativeProbe: HarnessNativeProbe;
}

const CLAUDE_DESKTOP_NOTE =
  "`type: stdio` is accepted; the canonical documented shape is `{command, args}` and extra keys are preserved";

export const HARNESSES: readonly HarnessSpec[] = [
  {
    id: "pi",
    label: "Pi Agent",
    surface: "pi-extension",
    configPath: { darwin: "~/.pi/agent/mcp.json", linux: "~/.pi/agent/mcp.json" },
    format: "json",
    serverKey: ["mcpServers"],
    entryKind: "pi-native",
    managedKeys: [],
    entryShapeSource: "machine-measured",
    protocolVersion: "2025-06-18",
    protocolVersionSource: "assumed",
    clientInfo: { name: "ultrasearch-smoke", version: "1.0.0" },
    binaries: ["pi"],
    appPaths: [],
    detectPaths: ["~/.pi/agent"],
    directive: "~/.pi/agent/AGENTS.md",
    initDefault: "skip",
    note:
      "Pi intentionally uses the native extension (`index.ts`), which exposes the same six tools without a second MCP surface; " +
      "init skips it by default (docs/decisions/0006-pi-native-not-mcp.md). Pass --force to register the MCP server anyway.",
    nativeProbe: "pi-interop-test",
  },
  {
    id: "t3code",
    label: "T3 Code",
    surface: "pi-derived",
    configPath: { darwin: "~/.pi/agent/mcp.json", linux: "~/.pi/agent/mcp.json" },
    format: "json",
    serverKey: ["mcpServers"],
    entryKind: "pi-native",
    managedKeys: [],
    entryShapeSource: "machine-measured",
    protocolVersion: "2025-06-18",
    protocolVersionSource: "assumed",
    clientInfo: { name: "ultrasearch-smoke", version: "1.0.0" },
    binaries: [],
    appPaths: ["/Applications/T3 Code (Nightly).app"],
    detectPaths: [],
    directive: "AGENTS.md (project) via the Pi provider",
    initDefault: "skip",
    note:
      "No independent user-level MCP registry: T3 Code reaches the tools through its Pi provider (native extension) or the `ultrasearch` CLI. Its row inherits Pi's smoke.",
    nativeProbe: null,
  },
  {
    id: "codex",
    label: "Codex CLI",
    surface: "mcp-stdio",
    configPath: { darwin: "~/.codex/config.toml", linux: "~/.codex/config.toml" },
    format: "toml",
    serverKey: ["mcp_servers"],
    entryKind: "command-args",
    managedKeys: ["command", "args"],
    entryShapeSource: "machine-measured",
    protocolVersion: "2025-06-18",
    protocolVersionSource: "assumed",
    clientInfo: { name: "ultrasearch-smoke", version: "1.0.0" },
    binaries: ["codex"],
    appPaths: ["/Applications/Codex.app", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app"],
    detectPaths: ["~/.codex"],
    directive: "AGENTS.md (repo) + ~/.codex/AGENTS.md",
    initDefault: "write",
    note: "`[mcp_servers.<name>]` with `command` / `args`; the shape `codex mcp add` writes itself",
    nativeProbe: "codex-mcp-list",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    surface: "mcp-stdio",
    configPath: { darwin: "~/.claude.json", linux: "~/.claude.json" },
    format: "json",
    serverKey: ["mcpServers"],
    entryKind: "claude-code-stdio",
    managedKeys: ["type", "command", "args"],
    entryShapeSource: "machine-measured",
    protocolVersion: "2025-06-18",
    protocolVersionSource: "assumed",
    clientInfo: { name: "claude-code", version: "unknown" },
    binaries: ["claude"],
    appPaths: [],
    detectPaths: ["~/.claude.json"],
    directive: "CLAUDE.md / ~/.claude/CLAUDE.md",
    initDefault: "write",
    note: "top-level `mcpServers` in `~/.claude.json` (user scope), exactly as `claude mcp add --scope user` writes it",
    nativeProbe: "claude-mcp-list",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    surface: "mcp-stdio",
    configPath: {
      darwin: "~/Library/Application Support/Claude/claude_desktop_config.json",
      linux: "~/.config/Claude/claude_desktop_config.json",
    },
    format: "json",
    serverKey: ["mcpServers"],
    entryKind: "command-args",
    managedKeys: ["command", "args"],
    entryShapeSource: "machine-observed",
    protocolVersion: "2025-06-18",
    protocolVersionSource: "assumed",
    clientInfo: { name: "ultrasearch-smoke", version: "1.0.0" },
    binaries: [],
    appPaths: ["/Applications/Claude.app"],
    detectPaths: ["~/Library/Application Support/Claude", "~/.config/Claude"],
    directive: "none (GUI)",
    initDefault: "write",
    note: CLAUDE_DESKTOP_NOTE,
    nativeProbe: null,
  },
  {
    id: "cursor",
    label: "Cursor",
    surface: "mcp-stdio",
    configPath: { darwin: "~/.cursor/mcp.json", linux: "~/.cursor/mcp.json" },
    format: "json",
    serverKey: ["mcpServers"],
    entryKind: "command-args",
    managedKeys: ["command", "args"],
    entryShapeSource: "machine-observed",
    protocolVersion: "2025-06-18",
    protocolVersionSource: "assumed",
    clientInfo: { name: "ultrasearch-smoke", version: "1.0.0" },
    binaries: ["cursor"],
    appPaths: ["/Applications/Cursor.app"],
    detectPaths: ["~/.cursor"],
    directive: "AGENTS.md / .cursor/rules",
    initDefault: "write",
    note: "user-level `~/.cursor/mcp.json` with `mcpServers`",
    nativeProbe: null,
  },
  {
    id: "windsurf",
    label: "Windsurf",
    surface: "mcp-stdio",
    configPath: { darwin: "~/.codeium/windsurf/mcp_config.json", linux: "~/.codeium/windsurf/mcp_config.json" },
    format: "json",
    serverKey: ["mcpServers"],
    entryKind: "command-args",
    managedKeys: ["command", "args"],
    entryShapeSource: "machine-observed",
    protocolVersion: "2025-06-18",
    protocolVersionSource: "assumed",
    clientInfo: { name: "ultrasearch-smoke", version: "1.0.0" },
    binaries: ["windsurf"],
    appPaths: ["/Applications/Windsurf.app"],
    detectPaths: ["~/.codeium/windsurf"],
    directive: ".windsurfrules / AGENTS.md",
    initDefault: "write",
    note: "user-level `~/.codeium/windsurf/mcp_config.json` with `mcpServers`",
    nativeProbe: null,
  },
  {
    id: "zed",
    label: "Zed",
    surface: "mcp-stdio",
    configPath: { darwin: "~/.config/zed/settings.json", linux: "~/.config/zed/settings.json" },
    format: "jsonc",
    serverKey: ["context_servers"],
    entryKind: "zed-command-args",
    managedKeys: ["command", "args"],
    entryShapeSource: "docs",
    protocolVersion: "2025-06-18",
    protocolVersionSource: "assumed",
    clientInfo: { name: "ultrasearch-smoke", version: "1.0.0" },
    binaries: ["zed"],
    appPaths: ["/Applications/Zed.app"],
    detectPaths: ["~/.config/zed"],
    directive: "AGENTS.md",
    initDefault: "write",
    note: "`context_servers` in `settings.json`, which is JSONC (comments and trailing commas are preserved)",
    nativeProbe: null,
  },
  {
    id: "vscode",
    label: "VS Code",
    surface: "mcp-stdio",
    configPath: {
      darwin: "~/Library/Application Support/Code/User/mcp.json",
      linux: "~/.config/Code/User/mcp.json",
    },
    format: "json",
    serverKey: ["servers"],
    entryKind: "vscode-stdio",
    managedKeys: ["type", "command", "args"],
    entryShapeSource: "machine-observed",
    protocolVersion: "2025-06-18",
    protocolVersionSource: "assumed",
    clientInfo: { name: "ultrasearch-smoke", version: "1.0.0" },
    binaries: ["code"],
    appPaths: ["/Applications/Visual Studio Code.app"],
    detectPaths: ["~/Library/Application Support/Code", "~/.config/Code"],
    directive: ".github/copilot-instructions.md / .vscode/instructions",
    initDefault: "write",
    note: "user `mcp.json` with a top-level `servers` map; workspace `.vscode/mcp.json` is the same shape",
    nativeProbe: null,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    surface: "mcp-stdio",
    configPath: {
      darwin: "~/.gemini/antigravity/mcp_config.json",
      linux: "~/.gemini/antigravity/mcp_config.json",
    },
    format: "json",
    serverKey: ["mcpServers"],
    entryKind: "command-args",
    managedKeys: ["command", "args"],
    entryShapeSource: "machine-observed",
    protocolVersion: "2025-06-18",
    protocolVersionSource: "assumed",
    clientInfo: { name: "ultrasearch-smoke", version: "1.0.0" },
    binaries: ["antigravity"],
    appPaths: ["/Applications/Antigravity.app", "/Applications/Antigravity IDE.app"],
    detectPaths: ["~/.gemini/antigravity"],
    directive: ".agents/rules or workspace instructions",
    initDefault: "write",
    note: "`mcpServers` in `~/.gemini/antigravity/mcp_config.json`",
    nativeProbe: null,
  },
];

/** Name this tool registers under in every harness config. */
export const MCP_SERVER_NAME = "ultrasearch";

export function harnessById(id: string): HarnessSpec | undefined {
  return HARNESSES.find((h) => h.id === id);
}

export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function harnessConfigPath(spec: HarnessSpec, home: string, platform = process.platform): string {
  const template = platform === "linux" ? spec.configPath.linux : spec.configPath.darwin;
  return expandHome(template, home);
}

/** The entry this tool writes for one harness. */
export function buildEntry(spec: HarnessSpec, launch: HarnessLaunch): Record<string, unknown> {
  switch (spec.entryKind) {
    case "claude-code-stdio":
      return { type: "stdio", command: launch.command, args: [...launch.args], env: {} };
    case "vscode-stdio":
      return { type: "stdio", command: launch.command, args: [...launch.args] };
    case "zed-command-args":
      return { command: launch.command, args: [...launch.args] };
    case "pi-native":
    case "command-args":
      return { command: launch.command, args: [...launch.args] };
  }
}

/** The subset of an entry this tool owns, used for idempotency checks. */
export function managedEntry(spec: HarnessSpec, entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of spec.managedKeys) if (key in entry) out[key] = entry[key];
  return out;
}

export interface DetectResult {
  installed: boolean;
  evidence: string[];
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find a harness binary on PATH, or at a known app-bundle path. */
export function findHarnessBinary(spec: HarnessSpec, home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const name of spec.binaries) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  for (const appPath of spec.appPaths) {
    const resolved = expandHome(appPath, home);
    if (fs.existsSync(resolved)) {
      // Prefer a runnable binary inside the bundle when one exists.
      const candidates = [
        path.join(resolved, "Contents", "MacOS", path.basename(resolved, ".app")),
        path.join(resolved, "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"),
      ];
      for (const candidate of candidates) if (isExecutable(candidate)) return candidate;
      return resolved;
    }
  }
  return null;
}

export function detectHarness(
  spec: HarnessSpec,
  home: string,
  deps: { env?: NodeJS.ProcessEnv; pathExists?: (p: string) => boolean } = {}
): DetectResult {
  const evidence: string[] = [];
  const binary = findHarnessBinary(spec, home, deps.env ?? process.env);
  if (binary && isExecutable(binary)) evidence.push(binary);
  else if (binary) evidence.push(binary);
  const exists = deps.pathExists ?? fs.existsSync;
  for (const p of spec.detectPaths) {
    const resolved = expandHome(p, home);
    if (exists(resolved)) evidence.push(resolved);
  }
  return { installed: evidence.length > 0, evidence };
}

export interface ResolveLaunchOptions {
  home: string;
  /** Explicit `--command`. */
  command?: string;
  /** Explicit `--arg` values. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Repo root used for the last-resort dev entrypoint. */
  repoRoot?: string;
  pathExists?: (p: string) => boolean;
}

/**
 * Resolve the MCP stdio server command to register.
 *
 * Order: explicit flag, `ULTRASEARCH_MCP_COMMAND` (+ `ULTRASEARCH_MCP_ARGS`),
 * the `ultrasearch install` shim, PATH, then the source entrypoint (dev
 * checkouts only, and the note says so).
 */
export function resolveLaunch(opts: ResolveLaunchOptions): HarnessLaunch {
  const env = opts.env ?? process.env;
  const exists = opts.pathExists ?? fs.existsSync;
  if (opts.command) return { command: opts.command, args: opts.args ?? [], source: "explicit" };
  if (env.ULTRASEARCH_MCP_COMMAND) {
    const envArgs = (env.ULTRASEARCH_MCP_ARGS ?? "")
      .split(/\s+/)
      .map((a) => a.trim())
      .filter(Boolean);
    return { command: env.ULTRASEARCH_MCP_COMMAND, args: envArgs, source: "env" };
  }
  const installed = path.join(opts.home, ".local", "bin", "ultrasearch-mcp");
  if (exists(installed) && isExecutable(installed)) return { command: installed, args: [], source: "installed" };
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "ultrasearch-mcp");
    if (exists(candidate) && isExecutable(candidate)) return { command: candidate, args: [], source: "path" };
  }
  const repoRoot = opts.repoRoot ?? process.cwd();
  const distEntry = path.join(repoRoot, "dist", "bin", "mcp-server.js");
  const srcEntry = path.join(repoRoot, "bin", "mcp-server.ts");
  const entry = exists(distEntry) ? distEntry : srcEntry;
  return { command: process.execPath, args: [entry], source: "explicit" };
}
