/**
 * memory.ingest — Manually index a file or directory into the memory store.
 */
import type Database from "better-sqlite3";
import fs from "node:fs";
import { indexFile, indexDirectory, type IndexResult } from "../core/indexer.js";
import type { EmbedderOptions } from "../core/embedder.js";
import path from "node:path";

export interface IngestParams {
  path: string;
  source?: "obsidian" | "manual" | "memory-md";
  scope?: string;
  recursive?: boolean;
}

export interface IngestResult {
  totalFiles: number;
  indexed: number;
  skipped: number;
  totalChunks: number;
}

/**
 * Ingest a file or directory into the memory database.
 */
export async function memoryIngest(
  db: Database.Database,
  params: IngestParams,
  embedOpts?: EmbedderOptions
): Promise<IngestResult> {
  const targetPath = params.path.replace(/^~/, process.env.HOME || "");
  const source = params.source || "manual";
  const recursive = params.recursive ?? true;

  const stat = fs.statSync(targetPath);

  let results: IndexResult[];

  if (stat.isDirectory()) {
    results = await indexDirectory(
      db,
      targetPath,
      { source, scope: params.scope, embedOpts },
      (indexed, total) => {
        console.error(`[ingest] ${indexed}/${total} files processed`);
      }
    );
  } else {
    const dirName = path.dirname(targetPath);
    const relPath = path.basename(targetPath);
    const result = await indexFile(db, targetPath, relPath, {
      source,
      scope: params.scope,
      embedOpts,
    });
    results = [result];
  }

  const indexed = results.filter((r) => !r.skipped && r.chunks > 0).length;
  const skipped = results.filter((r) => r.skipped).length;
  const totalChunks = results.reduce((sum, r) => sum + r.chunks, 0);

  return {
    totalFiles: results.length,
    indexed,
    skipped,
    totalChunks,
  };
}
