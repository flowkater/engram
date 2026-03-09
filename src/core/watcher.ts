/**
 * File watcher — uses chokidar v4 to watch Obsidian vault for changes.
 * Triggers re-indexing on add/change, soft-delete on unlink.
 * Debounces rapid changes with configurable delay.
 */
import type Database from "better-sqlite3";
import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import fs from "node:fs";
import { indexFile, softDeleteByPath } from "./indexer.js";
import type { EmbedderOptions } from "./embedder.js";

export interface WatcherOptions {
  vaultPath: string;
  source?: "obsidian" | "memory-md";
  debounceMs?: number;
  embedOpts?: EmbedderOptions;
  onIndexed?: (file: string, chunks: number) => void;
  onDeleted?: (file: string) => void;
  onError?: (error: Error) => void;
}

export interface WatcherInstance {
  watcher: FSWatcher;
  close(): Promise<void>;
}

const IGNORED_DIRS = [".obsidian", ".trash", "assets", "images", "node_modules", ".git"];

/**
 * Diff scan — file-level checkpoint-based change detection.
 * Compares file mtime against stored checkpoints to find modified files.
 * Race condition safe: only records checkpoint if mtime hasn't changed during indexing.
 */
export async function diffScan(
  db: Database.Database,
  vaultPath: string,
  opts?: {
    source?: "obsidian" | "memory-md";
    embedOpts?: EmbedderOptions;
    onIndexed?: (file: string, chunks: number) => void;
    onError?: (error: Error) => void;
  }
): Promise<{ scanned: number; indexed: number }> {
  const source = opts?.source || "obsidian";
  const resolvedVault = path.resolve(vaultPath);

  // Walk vault for .md files
  const mdFiles: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_DIRS.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        mdFiles.push(full);
      }
    }
  }
  walk(resolvedVault);

  // Build set of current vault files (absolute paths)
  const currentFiles = new Set(mdFiles.map((f) => path.resolve(f)));

  // Prepared statements
  const getCheckpoint = db.prepare(
    "SELECT file_mtime_ms FROM file_checkpoints WHERE source_path = ?"
  );
  const upsertCheckpoint = db.prepare(
    "INSERT OR REPLACE INTO file_checkpoints (source_path, source, file_mtime_ms, indexed_at) VALUES (?, ?, ?, ?)"
  );
  const deleteCheckpoint = db.prepare(
    "DELETE FROM file_checkpoints WHERE source_path = ?"
  );

  let scanned = 0;
  let indexed = 0;

  // Index new/modified files
  for (const absPath of mdFiles) {
    scanned++;
    try {
      const stat = fs.statSync(absPath);
      const mtimeBefore = stat.mtimeMs;

      // Check checkpoint
      const cp = getCheckpoint.get(absPath) as { file_mtime_ms: number } | undefined;

      if (cp && cp.file_mtime_ms >= mtimeBefore) {
        // File not modified since last checkpoint — skip
        continue;
      }

      // File is new or modified — index it
      const relativePath = path.relative(resolvedVault, absPath);
      const result = await indexFile(db, absPath, absPath, {
        source,
        embedOpts: opts?.embedOpts,
      });

      if (!result.skipped) {
        indexed++;
        opts?.onIndexed?.(relativePath, result.chunks);
      }

      // Race condition check: verify file wasn't modified during indexing
      const statAfter = fs.statSync(absPath);
      const mtimeAfter = statAfter.mtimeMs;

      if (mtimeBefore === mtimeAfter) {
        // Safe to record checkpoint
        upsertCheckpoint.run(absPath, source, mtimeBefore, new Date().toISOString());
      }
      // If mtime changed during indexing, skip checkpoint — next scan will re-process
    } catch (err) {
      opts?.onError?.(err as Error);
    }
  }

  // Handle deleted files: checkpoints that no longer have files in vault
  const allCheckpoints = db.prepare(
    "SELECT source_path FROM file_checkpoints WHERE source = ?"
  ).all(source) as Array<{ source_path: string }>;

  for (const cp of allCheckpoints) {
    if (!currentFiles.has(cp.source_path)) {
      try {
        db.transaction(() => {
          softDeleteByPath(db, cp.source_path);
          deleteCheckpoint.run(cp.source_path);
        })();
      } catch (err) {
        opts?.onError?.(err as Error);
      }
    }
  }

  return { scanned, indexed };
}

/** Simple semaphore to limit concurrent indexing operations. */
class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.current < this.max) { this.current++; return; }
    return new Promise<void>((resolve) => this.queue.push(() => { this.current++; resolve(); }));
  }
  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// NOTE: This Semaphore(3) limits concurrent file-level indexing.
// It is independent of indexer.ts's pLimit(3) which limits concurrent embed API calls within a single file.
// They are complementary and intentionally separate.
const indexSemaphore = new Semaphore(3);

/**
 * Check if a path should be ignored.
 */
function shouldIgnore(filePath: string): boolean {
  const parts = filePath.split(path.sep);
  return parts.some((p) => IGNORED_DIRS.includes(p));
}

/**
 * Start watching a directory for markdown file changes.
 */
export function startWatcher(
  db: Database.Database,
  opts: WatcherOptions
): WatcherInstance {
  const source = opts.source || "obsidian";
  const debounceMs = opts.debounceMs ?? 2000;
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const vaultPath = path.resolve(opts.vaultPath);

  const watcher = watch(vaultPath, {
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (filePath: string) => {
      const rel = path.relative(vaultPath, filePath);
      if (rel === "") return false; // Don't ignore root
      return shouldIgnore(rel);
    },
  });

  function toRelativePath(absPath: string): string {
    return path.relative(vaultPath, absPath);
  }

  function debouncedIndex(absPath: string) {
    if (!absPath.endsWith(".md")) return;
    const relativePath = toRelativePath(absPath);
    if (shouldIgnore(relativePath)) return;

    const existing = debounceTimers.get(relativePath);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      relativePath,
      setTimeout(async () => {
        debounceTimers.delete(relativePath);
        await indexSemaphore.acquire();
        try {
          const result = await indexFile(db, absPath, absPath, {
            source,
            embedOpts: opts.embedOpts,
          });
          if (!result.skipped && opts.onIndexed) {
            opts.onIndexed(relativePath, result.chunks);
          }
        } catch (err) {
          opts.onError?.(err as Error);
        } finally {
          indexSemaphore.release();
        }
      }, debounceMs)
    );
  }

  watcher.on("add", (absPath: string) => {
    debouncedIndex(absPath);
  });

  watcher.on("change", (absPath: string) => {
    debouncedIndex(absPath);
  });

  watcher.on("unlink", (absPath: string) => {
    if (!absPath.endsWith(".md")) return;
    const relativePath = toRelativePath(absPath);
    if (shouldIgnore(relativePath)) return;

    // Cancel any pending debounce
    const existing = debounceTimers.get(relativePath);
    if (existing) {
      clearTimeout(existing);
      debounceTimers.delete(relativePath);
    }
    try {
      db.transaction(() => {
        softDeleteByPath(db, absPath);
      })();
      opts.onDeleted?.(relativePath);
    } catch (err) {
      opts.onError?.(err as Error);
    }
  });

  watcher.on("error", (err: unknown) => {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    watcher,
    async close() {
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      await watcher.close();
    },
  };
}
