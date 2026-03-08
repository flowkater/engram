#!/usr/bin/env node
/**
 * Engram CLI — index, stats, prune subcommands.
 */
import path from "node:path";
import { openDatabase } from "./core/database.js";
import { indexDirectory } from "./core/indexer.js";
import { memoryStats } from "./tools/stats.js";
import { memoryPrune } from "./tools/prune.js";

const DB_PATH = process.env.MEMORY_DB || path.join(process.env.HOME || "~", ".engram", "memory.db");

function printUsage() {
  console.log(`
engram — CLI for Engram MCP Server

Usage:
  engram index <path> [--source obsidian|manual|memory-md] [--scope <scope>]
  engram stats
  engram prune [--days <N>] [--scope <scope>] [--execute]

Commands:
  index    Index a directory of markdown files
  stats    Show memory store statistics
  prune    Clean up old memories (dry-run by default)

Options:
  --source   Source type (default: obsidian)
  --scope    Filter by scope
  --days     Prune memories older than N days (default: 90)
  --execute  Actually delete (default: dry-run)
`);
}

function parseArgs(args: string[]): { command: string; positional: string[]; flags: Record<string, string> } {
  const command = args[0] || "";
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (key === "execute") {
        flags[key] = "true";
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        i++;
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { command, positional, flags };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const { command, positional, flags } = parseArgs(args);

  const dbInstance = openDatabase(DB_PATH);

  try {
    switch (command) {
      case "index": {
        const targetPath = positional[0];
        if (!targetPath) {
          console.error("Error: path is required for index command");
          process.exit(1);
        }

        const resolvedPath = path.resolve(targetPath.replace(/^~/, process.env.HOME || "~"));
        const source = (flags.source || "obsidian") as "obsidian" | "manual" | "memory-md";
        const scope = flags.scope;

        console.log(`Indexing ${resolvedPath} (source: ${source})...`);

        const results = await indexDirectory(
          dbInstance.db,
          resolvedPath,
          { source, scope },
          (indexed, total) => {
            process.stdout.write(`\r[${indexed}/${total}] files processed`);
          }
        );

        console.log("");
        const indexed = results.filter((r) => !r.skipped && r.chunks > 0).length;
        const skipped = results.filter((r) => r.skipped).length;
        const totalChunks = results.reduce((s, r) => s + r.chunks, 0);
        console.log(`Done: ${indexed} indexed, ${skipped} skipped, ${totalChunks} total chunks`);
        break;
      }

      case "stats": {
        const stats = memoryStats(dbInstance.db, DB_PATH);
        console.log(JSON.stringify(stats, null, 2));
        break;
      }

      case "prune": {
        const days = parseInt(flags.days || "90", 10);
        const scope = flags.scope;
        const dryRun = flags.execute !== "true";

        const result = memoryPrune(dbInstance.db, {
          olderThanDays: days,
          scope,
          dryRun,
        });

        if (dryRun) {
          console.log(`[DRY RUN] Would prune ${result.candidates} memories:`);
        } else {
          console.log(`Pruned ${result.pruned} memories:`);
        }
        for (const item of result.items) {
          console.log(`  - [${item.scope}] ${item.content}`);
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } finally {
    dbInstance.close();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
