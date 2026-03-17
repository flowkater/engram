/**
 * Shared helper to clean up FTS, vec, link, tag, and candidate records for a set of memory IDs.
 * Used by both softDeleteByPath (indexer) and memoryPrune (prune).
 */
import type Database from "better-sqlite3";

const SQLITE_DELETE_BATCH_SIZE = 400;

/**
 * Delete FTS, vec, link, tag, and candidate entries for the given memory IDs.
 * Must be called within a transaction.
 */
export function deleteRelatedRecords(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;

  for (let i = 0; i < ids.length; i += SQLITE_DELETE_BATCH_SIZE) {
    const batch = ids.slice(i, i + SQLITE_DELETE_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");
    db.prepare(`DELETE FROM memory_fts WHERE id IN (${placeholders})`).run(...batch);
    db.prepare(`DELETE FROM memory_vec WHERE id IN (${placeholders})`).run(...batch);
    db.prepare(`DELETE FROM memory_links WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`).run(...batch, ...batch);
    db.prepare(`DELETE FROM memory_tags WHERE memory_id IN (${placeholders})`).run(...batch);
    db.prepare(`DELETE FROM canonical_candidates WHERE raw_memory_id IN (${placeholders})`).run(...batch);
  }
}
