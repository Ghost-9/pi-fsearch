#!/usr/bin/env node
import { UltraSearchTui } from "../src/tui.ts";

const once = process.argv.includes("--once");
const tui = new UltraSearchTui();
tui.run(once).catch((err) => {
  console.error("TUI Error:", err);
  process.exit(1);
});
