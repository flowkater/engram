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
  usePolling?: boolean;
  pollingInterval?: number;
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
  let walkHadErrors = false;

  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Track the error and surface it — a transient readdir failure
      // (Obsidian sync / Dropbox / OneDrive / permission race) would otherwise
      // silently cause every file under this subdir to be treated as missing,
      // triggering spurious soft-deletes in the deletion pass below.
      walkHadErrors = true;
      opts?.onError?.(err as Error);
      return out;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await walk(full);
        out.push(...sub);
      } else if (entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
    return out;
  }

  const mdFiles = await walk(resolvedVault);
  const currentFiles = new Set(mdFiles.map((f) => path.resolve(f)));

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
  // Limit to 3 concurrent files in flight — matches the live watcher's Semaphore(3)
  // and complements indexer.ts's pLimit(3) for embed calls within a single file.
  // See the `indexSemaphore = new Semaphore(3)` below for the live-path equivalent.
  const BATCH = 3;

  for (let i = 0; i < mdFiles.length; i += BATCH) {
    const batch = mdFiles.slice(i, i + BATCH);
    await Promise.all(batch.map(async (absPath) => {
      scanned++;
      try {
        const stat = await fs.promises.stat(absPath);
        const mtimeBefore = stat.mtimeMs;
        const cp = getCheckpoint.get(absPath) as { file_mtime_ms: number } | undefined;
        if (cp && cp.file_mtime_ms >= mtimeBefore) return;

        const result = await indexFile(db, absPath, absPath, {
          source,
          embedOpts: opts?.embedOpts,
        });
        if (!result.skipped) {
          indexed++;
          const relativePath = path.relative(resolvedVault, absPath);
          opts?.onIndexed?.(relativePath, result.chunks);
        }
        const statAfter = await fs.promises.stat(absPath);
        if (mtimeBefore === statAfter.mtimeMs && result.reason !== "locked") {
          upsertCheckpoint.run(absPath, source, mtimeBefore, new Date().toISOString());
        }
      } catch (err) {
        opts?.onError?.(err as Error);
      }
    }));
    await new Promise((r) => setImmediate(r));
  }

  // Deletion pass — only run if the walk fully succeeded. If any readdir
  // failed, currentFiles is incomplete and treating missing entries as
  // deletions would soft-delete real, still-present files. We keep the
  // indexing work done above; a subsequent scan will reconcile deletions.
  if (!walkHadErrors) {
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
  } else {
    opts?.onError?.(new Error("diffScan: walk encountered errors, skipping deletion pass to avoid spurious soft-deletes"));
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
  const usePolling = opts.usePolling ?? process.env.CHOKIDAR_USEPOLLING === "true";
  const pollingInterval = opts.pollingInterval ?? 100;
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const vaultPath = path.resolve(opts.vaultPath);

  const watcher = watch(vaultPath, {
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    usePolling,
    interval: pollingInterval,
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
