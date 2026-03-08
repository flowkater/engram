/**
 * File watcher — uses chokidar v4 to watch Obsidian vault for changes.
 * Triggers re-indexing on add/change, soft-delete on unlink.
 * Debounces rapid changes with configurable delay.
 */
import type Database from "better-sqlite3";
import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
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
          const result = await indexFile(db, absPath, relativePath, {
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
      softDeleteByPath(db, relativePath);
      opts.onDeleted?.(relativePath);
    } catch (err) {
      opts.onError?.(err as Error);
    }
  });

  watcher.on("error", (err: Error) => {
    opts.onError?.(err);
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
