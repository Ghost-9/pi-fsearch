# Changelog

All notable changes to `pi-fsearch` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-10-13

### Added
- **Line-Buffered UNIX Socket Client**: Implemented `FSearchClient` in `src/client.ts` communicating with `~/Library/Application Support/FSearch/fsearch.sock`. Uses Node.js `readline` to guarantee clean message boundaries and prevent buffer fragmentation on large responses.
- **Request Multiplexing**: Correlation ID assignment ensuring concurrent agent queries never cross-talk or reject out-of-order.
- **Pi Agent Tools**:
  - `fsearch_query`: Instant path discovery with 1–2 typo forgiveness and CWD auto-scoping.
  - `fsearch_grep`: Sub-millisecond indexed trigram search with line numbers and context.
  - `fsearch_locate`: O(1) exact filename resolver.
  - `fsearch_recent`: Workspace frecency query.
- **Security Scrubbing**: Built-in credential redactor in `src/sanitize.ts` removing GitHub tokens, AWS keys, JWTs, and private keys before text injection.
- **Automated Test Suite**: Unit tests (`test/client.test.ts`) and live benchmark script (`test/bench.ts`).
- **Empirical Baseline**: Measured 45.3× speedup on file discovery and 11.9× speedup on content grep over native subprocesses.
