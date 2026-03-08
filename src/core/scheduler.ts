/**
 * Cron scheduler — periodic tasks for memory maintenance.
 * - Every 6 hours: re-index MEMORY.md files
 * - Weekly: prune old memories
 */
import type Database from "better-sqlite3";
import cron from "node-cron";
import fs from "node:fs";
import path from "node:path";
import { indexFile } from "./indexer.js";
import { memoryPrune } from "../tools/prune.js";
import type { EmbedderOptions } from "./embedder.js";

export interface SchedulerOptions {
  memoryMdPaths?: string[];
  embedOpts?: EmbedderOptions;
  onLog?: (message: string) => void;
}

export interface SchedulerInstance {
  tasks: cron.ScheduledTask[];
  stop(): void;
}

/**
 * Start the cron scheduler for periodic memory maintenance.
 */
export function startScheduler(
  db: Database.Database,
  opts: SchedulerOptions = {}
): SchedulerInstance {
  const log = opts.onLog || ((msg: string) => console.error(`[scheduler] ${msg}`));
  const tasks: cron.ScheduledTask[] = [];

  const defaultMemoryPaths = [
    "~/.openclaw/workspace/MEMORY.md",
    "~/.openclaw/workspace/memory/*.md",
  ];
  const memoryPaths = opts.memoryMdPaths || defaultMemoryPaths;

  // Every 6 hours: re-index MEMORY.md files
  const reindexTask = cron.schedule("0 */6 * * *", async () => {
    log("Starting MEMORY.md re-indexing...");
    let indexed = 0;

    for (const pattern of memoryPaths) {
      const expanded = pattern.replace(/^~/, process.env.HOME || "~");

      if (expanded.includes("*")) {
        // Glob pattern — find matching files
        const dir = path.dirname(expanded);
        const ext = path.extname(expanded);
        if (fs.existsSync(dir)) {
          try {
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
              if (entry.endsWith(ext || ".md")) {
                const fullPath = path.join(dir, entry);
                try {
                  await indexFile(db, fullPath, fullPath, {
                    source: "memory-md",
                    importance: 0.8,
                    embedOpts: opts.embedOpts,
                  });
                  indexed++;
                } catch (err) {
                  log(`Error indexing ${fullPath}: ${(err as Error).message}`);
                }
              }
            }
          } catch (err) {
            log(`Error reading ${dir}: ${(err as Error).message}`);
          }
        }
      } else if (fs.existsSync(expanded)) {
        try {
          await indexFile(db, expanded, expanded, {
            source: "memory-md",
            importance: 0.8,
            embedOpts: opts.embedOpts,
          });
          indexed++;
        } catch (err) {
          log(`Error indexing ${expanded}: ${(err as Error).message}`);
        }
      }
    }

    log(`MEMORY.md re-indexing complete: ${indexed} files processed`);
  });
  tasks.push(reindexTask);

  // Weekly Sunday 3 AM: prune old memories
  const pruneTask = cron.schedule("0 3 * * 0", () => {
    log("Starting weekly prune...");
    const result = memoryPrune(db, {
      olderThanDays: 180,
      minAccessCount: 0,
      dryRun: false,
    });
    log(`Prune complete: ${result.pruned} memories removed`);
  });
  tasks.push(pruneTask);

  log("Scheduler started (reindex: every 6h, prune: weekly Sun 3AM)");

  return {
    tasks,
    stop() {
      for (const task of tasks) {
        task.stop();
      }
      log("Scheduler stopped");
    },
  };
}
