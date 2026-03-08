/**
 * memory.restore — Restore a soft-deleted memory.
 * Re-embeds content and re-inserts into vec, FTS, and tags tables.
 */
import type Database from "better-sqlite3";
import { embed, getCurrentModelName, type EmbedderOptions } from "../core/embedder.js";
import { parseTags, insertTags } from "../utils/tags.js";

export interface RestoreParams {
  id: string;
}

export interface RestoreResult {
  id: string;
  restored: boolean;
  message: string;
}

/**
 * Restore a soft-deleted memory by ID.
 * Re-embeds, then atomically un-deletes + inserts vec/FTS/tags.
 */
export async function memoryRestore(
  db: Database.Database,
  params: RestoreParams,
  embedOpts?: EmbedderOptions
): Promise<RestoreResult> {
  const { id } = params;

  // Look up the memory
  const row = db.prepare(
    "SELECT id, content, summary, scope, tags, deleted FROM memories WHERE id = ?"
  ).get(id) as { id: string; content: string; summary: string | null; scope: string; tags: string; deleted: number } | undefined;

  if (!row) {
    throw new Error(`Memory not found: ${id}`);
  }

  if (row.deleted === 0) {
    throw new Error(`Memory is already active: ${id}`);
  }

  // Re-embed (outside transaction — network I/O)
  const embedding = await embed(row.content, embedOpts);
  const now = new Date().toISOString();
  const tags = parseTags(row.tags);

  // Atomic restore
  db.transaction(() => {
    db.prepare(
      "UPDATE memories SET deleted = 0, updated_at = ?, embed_model = ? WHERE id = ?"
    ).run(now, getCurrentModelName(embedOpts), id);

    db.prepare(
      "INSERT INTO memory_vec (id, embedding) VALUES (?, ?)"
    ).run(id, Buffer.from(embedding.buffer));

    db.prepare(
      "INSERT INTO memory_fts (id, content, summary, tags, scope) VALUES (?, ?, ?, ?, ?)"
    ).run(id, row.content, row.summary || "", row.tags, row.scope);

    insertTags(db, id, tags);
  })();

  return { id, restored: true, message: `Memory ${id} restored successfully` };
}
