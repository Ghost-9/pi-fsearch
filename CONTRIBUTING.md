# Contributing to pi-ultrasearch

We welcome contributions to `pi-ultrasearch`!

## Development Workflow

1. Ensure the `fsearch` daemon is installed and running:
   ```bash
   fsearch status
   ```

2. Run type checking:
   ```bash
   npm run typecheck
   ```

3. Run test suite:
   ```bash
   npm test
   ```

4. Run empirical benchmark:
   ```bash
   node test/bench.ts
   ```

## Commit Guidelines

Follow Conventional Commits:
- `feat:` for new capabilities or tools.
- `fix:` for bug fixes or edge case protections.
- `perf:` for latency optimizations.
- `docs:` for updates to ROADMAP or documentation.
- `test:` for benchmark or test coverage additions.
