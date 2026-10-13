# pi-fsearch

> Ultra-fast whole-disk filesystem search, trigram grep, and git-aware code indexing extension for **Pi Agent** and **T3 Code**, backed by the persistent resident Rust daemon `fsearch`.

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tested on Apple Silicon](https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-black.svg)]()

---

## What it is

Modern LLM coding agents spend **35%–60% of turn latency** executing repetitive shell commands (`find`, `ripgrep`, `grep -rn`) across massive repository trees. Each shell invocation spawns a subprocess, scans disk directories, and dumps raw text lines into LLM prompts.

`pi-fsearch` bridges the high-performance native Rust daemon `fsearch` directly into **Pi Agent's extension system** and **Code Mode** (QuickJS WASM sandbox).

### Measured Performance (Apple Silicon, 2.85M Files Indexed)

| Operation | Native Subprocess (`find` / `rg`) | Code Mode (In-Process AST) | `pi-fsearch` (Daemon Socket) | Speedup |
|:---|:---:|:---:|:---:|:---:|
| **File Path Discovery (p50)** | 14.40 ms | 6.46 ms | **0.15 ms** | **45.3× faster** |
| **Trigram Grep Search (p50)** | 1.27 ms | 45.00 ms | **0.09 ms** | **11.9× faster** |
| **Typo Tolerance** | 0% (exact only) | 0% | **100% (1–2 typos forgiven)** | Instant recovery |
| **Disk I/O per query** | Repeated disk read | Moderate file read | **0 bytes (mmap RAM)** | Zero disk churn |
| **Agent Context Bloat** | Up to 4,000 tokens dumped | Filtered in script | **Terse relative paths** | 90%+ context savings |

---

## Tool Surface Exposed to Agents

### 1. `fsearch_query`
Instant indexed file and path discovery.
- **Fuzzy & Typo-Tolerant**: Forgives 1–2 typos (`mian.rs` -> `main.rs`).
- **Globs & Filters**: `src/**/*.{ts,tsx} !test/`, `ext:rs`, `in:./Sources`.
- **Git Awareness**: Native integration with git status (`git:modified`, `git:staged`, `git:untracked`).
- **Auto-Scoping**: Automatically restricts search to current working directory (`process.cwd()`) unless `global: true` is passed.

### 2. `fsearch_grep`
Sub-millisecond text content retrieval backed by Tantivy trigram segments.
- Finds function signatures, symbol declarations, and text patterns.
- Automatic **secret scrubbing** protects credentials and keys from prompt leakage.
- Trigram bloom filters eliminate 99.8% of non-matching files before reading.

### 3. `fsearch_locate`
O(1) exact filename resolver for configs, headers, or module definitions (`package.json`, `Cargo.toml`).

### 4. `fsearch_recent`
Frecency-ranked list of files worked on recently in the active workspace or git branch.

---

## Code Mode Integration

In Pi Agent Code Mode, model-written JavaScript executes inside QuickJS WebAssembly. With `pi-fsearch`, agents can perform entire multi-stage discovery pipelines in a **single turn**:

```javascript
// Inside Pi Agent QuickJS Sandbox:
const files = await tools.fsearch_query({ query: "in:./Sources ext:swift Omnibox" });
const matches = await tools.fsearch_grep({ pattern: "ultraThinMaterial", path_filter: files[0].path });
if (matches.length > 0) {
  const content = await tools.read({ path: files[0].path });
  text(`Discovered glass omnibox style in ${files[0].path}`);
}
```

---

## Installation & Setup

1. **Install and run the `fsearch` daemon**:
   ```bash
   git clone https://github.com/noahdunnagan/fsearch.git ~/.cache/fsearch
   cd ~/.cache/fsearch
   cargo build --release
   ./target/release/fsearch install
   ```

2. **Add extension to Pi Agent**:
   Add `"~/.pi/agent/extensions/pi-fsearch"` to your `~/.pi/agent/settings.json` extensions list.

3. **Verify Daemon Health**:
   ```bash
   fsearch status
   ```

---

## License

MIT © 2026 [Ghost-9](https://github.com/Ghost-9).
