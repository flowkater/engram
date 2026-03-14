import path from "node:path";
import { openDatabase } from "../src/core/database.js";
import {
  repairFileBackedDuplicates,
  repairNullSourceSessionDuplicates,
} from "../src/core/duplicate-repair.js";

const DEFAULT_DB_PATH = process.env.MEMORY_DB || path.join(
  process.env.HOME || "~",
  ".engram",
  "memory.db"
);

function printUsage(): void {
  console.log(`
repair-duplicate-rows

Usage:
  npx tsx scripts/repair-duplicate-rows.ts [--db <path>] [--mode <file-backed|null-source-session|all>] [--path <file>] [--execute] [--verbose]

Options:
  --db       Override database path (default: $MEMORY_DB or ~/.engram/memory.db)
  --mode     Repair mode (default: file-backed)
  --path     Restrict repair to one file path (repeatable)
  --execute  Apply the repair (default: dry-run)
  --verbose  Include keepIds/deleteIds for each file
`);
}

function parseArgs(args: string[]): {
  dbPath: string;
  execute: boolean;
  verbose: boolean;
  mode: "file-backed" | "null-source-session" | "all";
  targetPaths?: string[];
} {
  let dbPath = DEFAULT_DB_PATH;
  let execute = false;
  let verbose = false;
  let mode: "file-backed" | "null-source-session" | "all" = "file-backed";
  const targetPaths: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--db") {
      dbPath = path.resolve(args[i + 1]?.replace(/^~/, process.env.HOME || "~") || dbPath);
      i += 1;
      continue;
    }
    if (arg === "--path") {
      const value = args[i + 1];
      if (value) {
        targetPaths.push(path.resolve(value.replace(/^~/, process.env.HOME || "~")));
      }
      i += 1;
      continue;
    }
    if (arg === "--mode") {
      const value = args[i + 1];
      if (value === "file-backed" || value === "null-source-session" || value === "all") {
        mode = value;
      }
      i += 1;
      continue;
    }
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return {
    dbPath,
    execute,
    verbose,
    mode,
    targetPaths: targetPaths.length > 0 ? targetPaths : undefined,
  };
}

async function main(): Promise<void> {
  const { dbPath, execute, verbose, mode, targetPaths } = parseArgs(process.argv.slice(2));
  const dbInstance = openDatabase(dbPath);

  try {
    const dryRun = !execute;
    const fileBacked = mode === "null-source-session"
      ? undefined
      : repairFileBackedDuplicates(dbInstance.db, {
          dryRun,
          targetPaths,
        });
    const fileItems = verbose && fileBacked
      ? fileBacked.items.map((item) => ({
          sourcePath: item.sourcePath,
          keepHash: item.keepHash,
          activeRows: item.activeRows,
          distinctChunkCount: item.distinctChunkCount,
          distinctHashCount: item.distinctHashCount,
          keepIds: item.keepIds,
          deleteIds: item.deleteIds,
          checkpoint: item.checkpoint,
        }))
      : undefined;
    const nullSessionResult = mode === "file-backed"
      ? undefined
      : repairNullSourceSessionDuplicates(dbInstance.db, dryRun);
    const nullSessionItems = verbose && nullSessionResult
      ? nullSessionResult.items.map((item) => ({
          keepId: item.keepId,
          deleteIds: item.deleteIds,
          scope: item.scope,
          agent: item.agent,
          chunkIndex: item.chunkIndex,
          accessCount: item.accessCount,
          accessedAt: item.accessedAt,
          updatedAt: item.updatedAt,
          createdAt: item.createdAt,
        }))
      : undefined;
    console.log(JSON.stringify({
      dbPath,
      mode,
      targetPaths,
      dryRun,
      fileBacked: {
        candidates: fileBacked?.candidates,
        duplicateRows: fileBacked?.duplicateRows,
        keptRows: fileBacked?.keptRows,
        repairedFiles: fileBacked?.repairedFiles,
        repairedRows: fileBacked?.repairedRows,
        items: fileItems,
      },
      nullSession: nullSessionResult
        ? {
            candidates: nullSessionResult.candidates,
            duplicateRows: nullSessionResult.duplicateRows,
            keptRows: nullSessionResult.keptRows,
            repairedGroups: nullSessionResult.repairedGroups,
            repairedRows: nullSessionResult.repairedRows,
            items: nullSessionItems,
          }
        : undefined,
    }, null, 2));
  } finally {
    dbInstance.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
