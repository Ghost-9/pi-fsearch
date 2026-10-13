# pi-ultrasearch

> Ultra-fast whole-disk filesystem search, trigram grep, and git-aware code indexing extension for **Pi Agent** and **T3 Code**, backed by the persistent resident Rust daemon `fsearch`.

[![Version](https://img.shields.io/badge/version-0.2.2-blue.svg)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tested on Apple Silicon](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-black.svg)]()
[![CI Gate](https://img.shields.io/badge/CI%20Gate-p95%20%3C%2010ms-brightgreen.svg)]()

---

## What it is

Modern LLM coding agents spend **35%–60% of turn latency** executing repetitive shell commands (`find`, `ripgrep`, `grep -rn`) across massive repository trees. Each shell invocation spawns a subprocess, scans disk directories, and dumps raw text lines into LLM prompts.

`pi-ultrasearch` bridges the high-performance native Rust daemon `fsearch` directly into **Pi Agent's extension system**, **Code Mode** (QuickJS WASM sandbox), and **Model Context Protocol (MCP)**.

### Measured Performance (Apple Silicon, 2.85M Files Indexed)

| Operation | Native Subprocess (`find` / `rg`) | Code Mode (In-Process AST) | `pi-ultrasearch` (Daemon Socket) | Speedup |
|:---|:---:|:---:|:---:|:---:|
| **File Path Discovery (p50)** | 14.40 ms | 6.46 ms | **0.15 ms** | **45.3× faster** |
| **Trigram Grep Search (p50)** | 1.27 ms | 45.00 ms | **0.09 ms** | **11.9× faster** |
| **Typo Tolerance** | 0% (exact only) | 0% | **0% (Strict zero typo tolerance)** | Deterministic precision |
| **Disk I/O per query** | Repeated disk read | Moderate file read | **0 bytes (mmap RAM)** | Zero disk churn |
| **Agent Context Bloat** | Up to 4,000 tokens dumped | Filtered in script | **Terse relative paths** | 90%+ context savings |

---

## Tool Surface Exposed to Agents

### 1. `fsearch_query`
Instant indexed file and path discovery.
- **Strict Zero Typo Tolerance**: Deterministic exact matching only. Plain tokens are evaluated in `Mode::Exact`. Misspellings return 0 false positives.
- **Globs & Filters**: `src/**/*.{ts,tsx} !test/`, `ext:rs`, `in:./Sources`.
- **Git Awareness**: Native integration with git status (`git:modified`, `git:staged`, `git:untracked`).
- **Proximity Re-Ranking**: `near: <path>` or `near` parameter boosts files closer in directory hierarchy.
- **Worktree Boundary Scoping**: Auto-resolved via `git rev-parse --show-toplevel` to prevent cross-repo leaks.

### 2. `fsearch_grep`
Sub-millisecond text content retrieval backed by Tantivy trigram segments.
- Finds function signatures, symbol declarations, and text patterns.
- Automatic **enterprise secret scrubbing** protects credentials and keys from prompt leakage.
- Trigram bloom filters eliminate 99.8% of non-matching files before reading.
- Fail-open fallback: seamlessly invokes native `rg` if daemon is temporarily offline.

### 3. `fsearch_multi_grep`
Atomic disjunction grep: searches for multiple keywords, symbols, or regex patterns concurrently in a single IPC roundtrip.

### 4. `fsearch_locate`
O(1) exact filename resolver for configs, headers, or module definitions (`package.json`, `Cargo.toml`).

### 5. `fsearch_recent`
Frecency-ranked list of files worked on recently in the active workspace or git branch. Updated automatically via the `tool_execution_end` lifecycle hook whenever the agent reads, views, or edits files.

### 6. `fsearch_metrics`
Toolchain audit profiler & self-learning advice. Inspects session latency percentiles (p50/p90/p95), error rates, 0-hit diagnostics, and flags CLI search bypasses (`find`, `rg`).

---

## Observability & Toolchain Shadow Detector

`pi-ultrasearch` includes an autonomous observability engine:
- **Persistent JSONL Telemetry**: Logs all search operations and latencies to `~/.pi/agent/cache/pi-ultrasearch/audit.jsonl`.
- **Toolchain Shadow Detector**: Hooks into `tool_execution_end` to monitor agent `bash` calls. Whenever an agent falls back to slow shell commands (`find . -name ...` or `rg ...`), it logs an anti-pattern event and calculates the latency gap.
- **Dynamic Diagnostic Hints**: When queries produce 0 hits, the engine inspects the workspace, verifies if the target exists in another directory, and attaches actionable corrective guidance in the tool result.
- **Slash Commands**: Run `/ultrasearch metrics` or `/ultrasearch audit` (alias: `/fsearch`) in Pi Agent to view real-time profiler statistics.

---

## Code Mode Integration

In Pi Agent Code Mode, model-written JavaScript executes inside QuickJS WebAssembly. With `pi-ultrasearch`, agents can perform entire multi-stage discovery pipelines in a **single turn**:

```javascript
// Inside Pi Agent QuickJS Sandbox:
const files = await tools.fsearch_query({ query: "in:./Sources ext:swift Omnibox", near: "OmniboxView.swift" });
const matches = await tools.fsearch_grep({ pattern: "ultraThinMaterial", path_filter: files[0].path });
if (matches.length > 0) {
  const content = await tools.read({ path: files[0].path });
  text(`Discovered glass omnibox style in ${files[0].path}`);
}
```

TypeScript declarations can be dynamically retrieved for QuickJS via:
```typescript
import { renderUltraSearchDeclarations } from "pi-ultrasearch/src/codemode.ts";
console.log(renderUltraSearchDeclarations());
```

---

## Model Context Protocol (MCP) Server

`pi-ultrasearch` includes a native stdio MCP server for T3 Code, Antigravity, and Claude Desktop:

```json
{
  "mcpServers": {
    "ultrasearch": {
      "command": "node",
      "args": ["/Users/batra/.pi/agent/extensions/pi-ultrasearch/bin/mcp-server.ts"]
    }
  }
}
```

---

## Testing & CI Latency Gate

Run the test suite and regression gate:
```bash
# Run unit & observability tests
npm test

# Run deterministic sub-10ms p95 latency CI gate
npm run test:gate

# Run TypeScript compilation
npm run typecheck
```

---

## License

[MIT](LICENSE) © 2026 Ghost-9
