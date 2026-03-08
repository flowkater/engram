/**
 * memory.prune — Clean up old, low-access memories.
 * Dry-run mode by default for safety.
 */
import type Database from "better-sqlite3";

export interface PruneParams {
  olderThanDays?: number;
  minAccessCount?: number;
  scope?: string;
  dryRun?: boolean;
  limit?: number;
}

export interface PruneResult {
  candidates: number;
  pruned: number;
  dryRun: boolean;
  items: Array<{
    id: string;
    content: string;
    scope: string;
    created_at: string;
    access_count: number;
  }>;
}

/**
 * Prune old, low-access memories. Soft-deletes by default.
 */
export function memoryPrune(
  db: Database.Database,
  params: PruneParams
): PruneResult {
  const olderThanDays = params.olderThanDays ?? 90;
  const minAccessCount = params.minAccessCount ?? 0;
  const dryRun = params.dryRun ?? true;

  // Calculate cutoff date
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);
  const cutoffIso = cutoff.toISOString();

  // Build query
  let whereClause = "deleted = 0 AND created_at < ? AND access_count <= ?";
  const queryParams: unknown[] = [cutoffIso, minAccessCount];

  if (params.scope) {
    whereClause += " AND scope = ?";
    queryParams.push(params.scope);
  }

  // Find candidates
  const candidates = db.prepare(`
    SELECT id, content, scope, created_at, access_count
    FROM memories
    WHERE ${whereClause}
    ORDER BY access_count ASC, created_at ASC
    LIMIT ?
  `).all(...queryParams, params.limit ?? 100) as Array<{
    id: string;
    content: string;
    scope: string;
    created_at: string;
    access_count: number;
  }>;

  // Truncate content for display
  const items = candidates.map((c) => ({
    ...c,
    content: c.content.length > 100 ? c.content.slice(0, 100) + "..." : c.content,
  }));

  let pruned = 0;
  if (!dryRun && candidates.length > 0) {
    const now = new Date().toISOString();
    const ids = candidates.map((c) => c.id);
    const placeholders = ids.map(() => "?").join(",");

    db.transaction(() => {
      const result = db.prepare(
        `UPDATE memories SET deleted = 1, updated_at = ? WHERE id IN (${placeholders})`
      ).run(now, ...ids);
      pruned = result.changes;

      // Clean up FTS, vec, and links
      db.prepare(`DELETE FROM memory_fts WHERE id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM memory_vec WHERE id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM memory_links WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`).run(...ids, ...ids);
    })();
  }

  return {
    candidates: candidates.length,
    pruned,
    dryRun,
    items,
  };
}
