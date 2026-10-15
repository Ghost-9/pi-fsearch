# 0006 — Pi uses the native extension, not MCP

**Choice.** Register the MCP server in Antigravity, VS Code and Claude Desktop,
but let Pi (and T3 Code) use the native extension.

**Reason.** The native extension is the shipped, tested surface with the tool
semantics Pi expects; a second MCP registration would duplicate 12 tool names
into every prompt for no capability gain.

**Rejected.**
- Registering both: prompt surface doubles; two ways to configure the socket.
- MCP-only: loses the extension lifecycle hooks (frecency, auto-compaction).
