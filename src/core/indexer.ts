/**
 * Indexing pipeline — processes markdown files into chunks, embeds, and stores in DB.
 * Supports batch processing with hash-based skip for efficiency.
 */
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { v7 as uuidv7 } from "uuid";
import { chunkMarkdown, extractWikiLinks, type ChunkOptions, OBSIDIAN_CHUNK_OPTS, MEMORY_MD_CHUNK_OPTS } from "./chunker.js";
import { embed, type EmbedderOptions } from "./embedder.js";
import { sha256 } from "../utils/hash.js";
import { detectObsidianScope } from "../utils/scope.js";

const BATCH_SIZE = 20;

export interface IndexFileOptions {
  source: "obsidian" | "manual" | "memory-md";
  scope?: string;
  importance?: number;
  chunkOpts?: ChunkOptions;
  embedOpts?: EmbedderOptions;
}

export interface IndexResult {
  file: string;
  chunks: number;
  skipped: boolean;
}

/**
 * Check if a file is already indexed with the same hash.
 */
export function isAlreadyIndexed(db: Database.Database, sourcePath: string, hash: string): boolean {
  const row = db.prepare(
    "SELECT source_hash FROM memories WHERE source_path = ? AND deleted = 0 LIMIT 1"
  ).get(sourcePath) as { source_hash: string } | undefined;
  return row?.source_hash === hash;
}

/**
 * Soft-delete all memory chunks for a given source path.
 */
export function softDeleteByPath(db: Database.Database, sourcePath: string): number {
  const result = db.prepare(
    "UPDATE memories SET deleted = 1, updated_at = ? WHERE source_path = ? AND deleted = 0"
  ).run(new Date().toISOString(), sourcePath);
  return result.changes;
}

/**
 * Index a single markdown file: chunk → embed → store.
 */
export async function indexFile(
  db: Database.Database,
  filePath: string,
  relativePath: string,
  opts: IndexFileOptions
): Promise<IndexResult> {
  const content = fs.readFileSync(filePath, "utf-8");
  const hash = sha256(content);

  // Skip if already indexed with same hash
  if (isAlreadyIndexed(db, relativePath, hash)) {
    return { file: relativePath, chunks: 0, skipped: true };
  }

  // Remove old chunks for this file
  softDeleteByPath(db, relativePath);

  // Determine chunk options
  const chunkOpts = opts.chunkOpts ||
    (opts.source === "memory-md" ? MEMORY_MD_CHUNK_OPTS : OBSIDIAN_CHUNK_OPTS);

  // Chunk the content
  const chunks = chunkMarkdown(content, chunkOpts);
  if (chunks.length === 0) {
    return { file: relativePath, chunks: 0, skipped: false };
  }

  // Determine scope
  const scope = opts.scope || chunks[0].meta.scope || detectObsidianScope(relativePath);
  const importance = opts.importance ?? 0.5;

  // Insert each chunk
  const insertMemory = db.prepare(`
    INSERT INTO memories (id, content, summary, source, source_path, source_hash, chunk_index, scope, agent, tags, importance, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVec = db.prepare(
    "INSERT INTO memory_vec (id, embedding) VALUES (?, ?)"
  );
  const insertFts = db.prepare(
    "INSERT INTO memory_fts (id, content, summary, tags, scope) VALUES (?, ?, ?, ?, ?)"
  );
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO memory_links (from_id, to_id, link_type, weight, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const chunkIds: string[] = [];

  for (const chunk of chunks) {
    const id = uuidv7();
    const now = new Date().toISOString();
    const tags = JSON.stringify(chunk.meta.tags || []);
    const chunkScope = chunk.meta.scope || scope;

    // Generate embedding
    const embedding = await embed(chunk.text, opts.embedOpts);

    insertMemory.run(
      id, chunk.text, null, opts.source, relativePath, hash,
      chunk.index, chunkScope, null, tags, importance, now, now
    );
    insertVec.run(id, Buffer.from(embedding.buffer));
    insertFts.run(id, chunk.text, "", tags, chunkScope);
    chunkIds.push(id);

    // Extract wikilinks and create link records to existing memories
    const wikiLinks = extractWikiLinks(chunk.text);
    for (const linkName of wikiLinks) {
      // Find target memory by source_path matching the link name
      const targets = db.prepare(
        "SELECT DISTINCT id FROM memories WHERE source_path LIKE ? AND deleted = 0 LIMIT 5"
      ).all(`%${linkName}%`) as Array<{ id: string }>;

      for (const target of targets) {
        if (target.id !== id) {
          insertLink.run(id, target.id, "wikilink", 1.0, new Date().toISOString());
        }
      }
    }

    // Create tag-based links to other memories with same tags
    const chunkTags = chunk.meta.tags || [];
    if (chunkTags.length > 0) {
      for (const tag of chunkTags) {
        const tagMatches = db.prepare(
          "SELECT id FROM memories WHERE tags LIKE ? AND id != ? AND deleted = 0 LIMIT 10"
        ).all(`%${tag}%`, id) as Array<{ id: string }>;

        for (const match of tagMatches) {
          insertLink.run(id, match.id, "tag", 0.5, new Date().toISOString());
        }
      }
    }
  }

  return { file: relativePath, chunks: chunks.length, skipped: false };
}

/**
 * Index all markdown files in a directory (batch processing).
 */
export async function indexDirectory(
  db: Database.Database,
  dirPath: string,
  opts: IndexFileOptions,
  onProgress?: (indexed: number, total: number) => void
): Promise<IndexResult[]> {
  // Find all .md files
  const files = findMarkdownFiles(dirPath);
  const results: IndexResult[] = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map((file) => {
        const fullPath = path.join(dirPath, file);
        return indexFile(db, fullPath, file, opts);
      })
    );

    results.push(...batchResults);

    if (onProgress) {
      onProgress(Math.min(i + BATCH_SIZE, files.length), files.length);
    }
  }

  return results;
}

/**
 * Find all .md files in a directory recursively.
 * Excludes .obsidian, .trash, assets, images directories.
 */
function findMarkdownFiles(dirPath: string): string[] {
  const files: string[] = [];
  const IGNORE = new Set([".obsidian", ".trash", "assets", "images", "node_modules", ".git"]);

  function walk(dir: string, prefix: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;

      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(rel);
      }
    }
  }

  walk(dirPath, "");
  return files.sort();
}
