/**
 * Tag normalization utilities — parse, insert, and delete tags via memory_tags table.
 */
import type Database from "better-sqlite3";

/**
 * Parse tags from various inputs into a normalized string array.
 * Lowercases, trims, deduplicates, and removes empty strings.
 */
export function parseTags(input: string | string[] | undefined | null): string[] {
  let raw: string[];

  if (!input) return [];

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      raw = Array.isArray(parsed) ? parsed : [input];
    } catch {
      raw = [input];
    }
  } else {
    raw = input;
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const t of raw) {
    const normalized = String(t).trim().toLowerCase();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

/**
 * Insert tags into memory_tags table for a given memory.
 * Must be called within a transaction.
 */
export function insertTags(db: Database.Database, memoryId: string, tags: string[]): void {
  if (tags.length === 0) return;
  const stmt = db.prepare("INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)");
  for (const tag of tags) {
    stmt.run(memoryId, tag);
  }
}

/**
 * Delete all tags for a given memory.
 * Must be called within a transaction.
 */
export function deleteTags(db: Database.Database, memoryId: string): void {
  db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").run(memoryId);
}

/**
 * Delete tags for multiple memory IDs.
 * Must be called within a transaction.
 */
export function deleteTagsBatch(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM memory_tags WHERE memory_id IN (${placeholders})`).run(...ids);
}
