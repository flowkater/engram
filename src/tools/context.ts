/**
 * memory.context — Auto-load relevant memories based on current working directory.
 * Detects scope from cwd and returns recent + high-importance memories.
 */
import type Database from "better-sqlite3";
import { detectScope } from "../utils/scope.js";

export interface ContextParams {
  cwd?: string;
  limit?: number;
  recent?: boolean;
}

export interface ContextResult {
  scope: string;
  memories: Array<{
    id: string;
    content: string;
    summary: string | null;
    source: string;
    importance: number;
    created_at: string;
    tags: string[];
  }>;
}

/**
 * Get contextual memories for the current working directory.
 * Combines recent memories with high-importance ones for the detected scope.
 */
export function memoryContext(
  db: Database.Database,
  params: ContextParams
): ContextResult {
  const cwd = params.cwd || process.cwd();
  const scope = detectScope(cwd);
  const limit = params.limit || 5;
  const recent = params.recent ?? true;

  // Build query: scope-filtered, ordered by weighted score (importance * 0.4 + recency * 0.6)
  const orderBy = recent
    ? "(importance * 0.4 + (1.0 - MIN(1.0, (julianday('now') - julianday(created_at)) / 30.0)) * 0.6) DESC"
    : "importance DESC";

  const rows = db.prepare(`
    SELECT id, content, summary, source, importance, created_at, tags
    FROM memories
    WHERE deleted = 0
      AND (scope = ? OR scope = 'global')
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(scope, limit) as Array<{
    id: string;
    content: string;
    summary: string | null;
    source: string;
    importance: number;
    created_at: string;
    tags: string;
  }>;

  // Update access stats
  if (rows.length > 0) {
    const now = new Date().toISOString();
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id IN (${placeholders})`
    ).run(now, ...ids);
  }

  return {
    scope,
    memories: rows.map((r) => ({
      ...r,
      tags: JSON.parse(r.tags) as string[],
    })),
  };
}
