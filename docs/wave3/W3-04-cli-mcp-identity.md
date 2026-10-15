# W3-04 — identical sets through client, CLI and MCP (#47 acceptance)

`bench/wave3/identity-cli-mcp.mjs` runs one query through all three surfaces and diffs the
path sets. All three build the same `UltraSearchClient` and send the same `op`; the check
exists so the acceptance is a measurement, not an argument.

```
PI_ULTRASEARCH_TEST=1 PI_ULTRASEARCH_SOCKET=<iso-sock> node bench/wave3/identity-cli-mcp.mjs
```

| surface | how it is driven | files |
|:--|:--|--:|
| client library | `client.search("src/**/*.ts", { in: <corpus>, limit: 20 })` | 14 |
| CLI | `node bin/cli.ts search "src/**/*.ts" --in <corpus> --limit 20`, stdout parsed | 14 |
| MCP | real JSON-RPC `tools/call` → `ultrasearch_query` on an in-process `UltraSearchMcpServer` | 14 |

```
identity: library_equals_cli true, library_equals_mcp true, all_identical true
cli_only [] · mcp_only [] · library_only []
```

Artifact: `bench/wave3/results/identity-cli-mcp.json`.

Corpus: `~/.cache/ultrasearch/corpus/wave2-8d1419d` (`tree_sha256 c9c2e4ac…`).
Engine: `7b413d874fa2a824` (the tree's `engine/target/release/ultrasearch`), isolated daemon.
Every file in the expected set of `RS02` is returned: `recall_at_limit = 1.00`.
