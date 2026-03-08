/**
 * Shared helper to clean up FTS, vec, and link records for a set of memory IDs.
 * Used by both softDeleteByPath (indexer) and memoryPrune (prune).
 */
import type Database from "better-sqlite3";

/**
 * Delete FTS, vec, and link entries for the given memory IDs.
 * Must be called within a transaction.
 */
export function deleteRelatedRecords(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM memory_fts WHERE id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM memory_vec WHERE id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM memory_links WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`).run(...ids, ...ids);
}
