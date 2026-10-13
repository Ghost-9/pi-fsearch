#!/usr/bin/env node
import { FSearchClient } from "../src/client.ts";
import { formatGrepFiles } from "../src/formatter.ts";
import { formatAuditSummary, summarizeAudit, loadAudit } from "../src/telemetry.ts";
import { LsmCompactor } from "../src/compactor.ts";
import { formatRecursiveLearningReport, loadLearningMemory } from "../src/recursive-learning.ts";
import { UltraSearchTui } from "../src/tui.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  const client = new FSearchClient();

  try {
    switch (command) {
      case "query":
      case "search": {
        const query = args[1];
        if (!query) {
          console.error("Usage: ultrasearch query <pattern> [--in <dir>] [--limit <n>]");
          process.exit(1);
        }
        let scope = process.cwd();
        let limit = 30;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--in" && args[i + 1]) scope = path.resolve(args[i + 1]);
          if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[i + 1], 10);
        }
        const res = await client.search(query, { in: scope, limit });
        if (!res.ok || !res.hits) {
          console.error(`Search error: ${res.error || "No hits"}`);
          process.exit(1);
        }
        for (const hit of res.hits) {
          console.log(hit.path);
        }
        break;
      }

      case "grep": {
        const pattern = args[1];
        if (!pattern) {
          console.error("Usage: ultrasearch grep <pattern> [--in <dir>]");
          process.exit(1);
        }
        let scope = process.cwd();
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--in" && args[i + 1]) scope = path.resolve(args[i + 1]);
        }
        const res = await client.grep(pattern, { in: scope });
        if (!res.ok || !res.files) {
          console.error(`Grep error: ${res.error || "No matches"}`);
          process.exit(1);
        }
        const formatted = formatGrepFiles(res.files, { worktreeRoot: scope, compact: true });
        console.log(formatted.text);
        break;
      }

      case "multi-grep": {
        const patterns = args.slice(1).filter((a) => !a.startsWith("--"));
        if (patterns.length === 0) {
          console.error("Usage: ultrasearch multi-grep <pattern1> <pattern2> ... [--in <dir>]");
          process.exit(1);
        }
        let scope = process.cwd();
        const inIdx = args.indexOf("--in");
        if (inIdx !== -1 && args[inIdx + 1]) scope = path.resolve(args[inIdx + 1]);

        const res = await client.multiGrep(patterns, { in: scope });
        if (!res.ok || !res.files) {
          console.error(`Multi-grep error: ${res.error || "No matches"}`);
          process.exit(1);
        }
        const formatted = formatGrepFiles(res.files, { worktreeRoot: scope, compact: true });
        console.log(formatted.text);
        break;
      }

      case "locate": {
        const filename = args[1];
        if (!filename) {
          console.error("Usage: ultrasearch locate <filename>");
          process.exit(1);
        }
        const res = await client.search(filename, { limit: 50 });
        for (const hit of res.hits || []) {
          console.log(hit.path);
        }
        break;
      }

      case "recent": {
        let scope = process.cwd();
        const inIdx = args.indexOf("--in");
        if (inIdx !== -1 && args[inIdx + 1]) scope = path.resolve(args[inIdx + 1]);

        const hits = await client.recent(scope, 20);
        for (const hit of hits) {
          console.log(hit.path);
        }
        break;
      }

      case "compact": {
        console.log("⏳ Triggering LSM segment compaction & index consolidation...");
        const compactor = new LsmCompactor(client);
        const res = await compactor.compact();
        if (res.ok) {
          console.log(`✅ ${res.message}`);
        } else {
          console.error(`❌ ${res.message}`);
          process.exit(1);
        }
        break;
      }

      case "metrics": {
        const audit = loadAudit();
        const summary = summarizeAudit(audit);
        console.log(formatAuditSummary(summary));
        break;
      }

      case "learning": {
        console.log(formatRecursiveLearningReport());
        break;
      }

      case "tui": {
        client.close();
        const tui = new UltraSearchTui();
        await tui.run(args.includes("--once"));
        return;
      }

      case "authorize":
      case "permissions": {
        console.log("🔐 Checking macOS Full Disk Access status for UltraSearch daemon...");
        try {
          const status = await client.status();
          if (status.full_disk_access) {
            console.log("✅ Full Disk Access is ALREADY active! Downloads, Documents, and Desktop are indexed.");
            break;
          }
        } catch {}

        console.log("⚠️ Full Disk Access is currently missing on macOS.");
        console.log("👉 Opening System Settings -> Privacy & Security -> Full Disk Access...");
        try {
          const { execSync } = await import("node:child_process");
          execSync("open 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'");
          execSync("open -R ~/Applications/UltraSearch.app || open -R ~/.local/bin/ultrasearch-daemon");
          console.log("📂 Revealed 'UltraSearch' in Finder.");
          console.log("💡 Simply toggle or drag 'UltraSearch' into the Full Disk Access list.");
        } catch (e: any) {
          console.error("Could not open settings:", e.message);
        }
        break;
      }

      case "daemon": {
        const sub = args[1] || "status";
        const { execSync } = await import("node:child_process");
        if (sub === "status") {
          try {
            const status = await client.status();
            console.log(JSON.stringify(status, null, 2));
          } catch (e: any) {
            console.error("Daemon is not reachable:", e.message);
          }
        } else if (sub === "restart") {
          console.log("🔄 Restarting ultrasearch daemon...");
          try {
            execSync("pkill -f 'UltraSearch serve' || pkill -f 'ultrasearch-daemon serve' || pkill -f 'fsearch serve' || true");
            execSync("~/Applications/UltraSearch.app/Contents/MacOS/UltraSearch serve >/dev/null 2>&1 & || ultrasearch-daemon serve >/dev/null 2>&1 &");
            console.log("✅ Ultrasearch daemon restarted.");
          } catch (e: any) {
            console.error("Restart error:", e.message);
          }
        } else {
          console.log("Usage: ultrasearch daemon [status|restart]");
        }
        break;
      }

      case "install": {
        const localBin = path.join(os.homedir(), ".local/bin");
        if (!fs.existsSync(localBin)) fs.mkdirSync(localBin, { recursive: true });

        const thisFile = path.resolve(process.argv[1]);
        const tuiFile = path.resolve(path.join(path.dirname(thisFile), "tui.ts"));

        const cliTarget = path.join(localBin, "ultrasearch");
        const tuiTarget = path.join(localBin, "ultrasearch-tui");

        // Write executable shims using Node's native strip-types
        fs.writeFileSync(
          cliTarget,
          `#!/usr/bin/env bash\nexec node --experimental-strip-types "${thisFile}" "$@"\n`,
          { mode: 0o755 }
        );
        fs.writeFileSync(
          tuiTarget,
          `#!/usr/bin/env bash\nexec node --experimental-strip-types "${tuiFile}" "$@"\n`,
          { mode: 0o755 }
        );

        console.log(`✅ Installed 'ultrasearch' -> ${cliTarget}`);
        console.log(`✅ Installed 'ultrasearch-tui' -> ${tuiTarget}`);

        const daemonTarget = path.join(localBin, "ultrasearch-daemon");
        const fsearchBin = path.join(localBin, "fsearch");
        if (fs.existsSync(fsearchBin)) {
          try {
            if (!fs.existsSync(daemonTarget)) fs.symlinkSync(fsearchBin, daemonTarget);
            console.log(`✅ Linked 'ultrasearch-daemon' -> ${daemonTarget}`);
          } catch {}
        }
        break;
      }

      case "help":
      default: {
        console.log(`
⚡ PI-ULTRASEARCH: Sub-millisecond filesystem search & trigram code indexing

Commands:
  ultrasearch query <text> [--in <dir>]     Search paths with zero-typo exactness
  ultrasearch grep <pattern> [--in <dir>]    Grep trigram index with DLP masking
  ultrasearch multi-grep <p1> <p2>          Search multiple patterns in single IPC pass
  ultrasearch locate <filename>             Instant whole-disk filename locator
  ultrasearch recent [--in <dir>]           Recently modified & git-active files
  ultrasearch compact                       Trigger automated LSM index compaction
  ultrasearch metrics                       Display latency, throughput, token savings
  ultrasearch learning                      Inspect recursive learning rules & mistakes
  ultrasearch tui [--once]                  Launch interactive mission control TUI
  ultrasearch install                       Install symlinks into ~/.local/bin
`);
        break;
      }
    }
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error("UltraSearch CLI error:", err);
  process.exit(1);
});
