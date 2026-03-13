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
    isCanonical?: boolean;
    kind?: "fact" | "decision" | "raw";
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

  const orderBy = recent
    ? "(importance * 0.4 + (1.0 - MIN(1.0, (julianday('now') - julianday(created_at)) / 30.0)) * 0.6) DESC"
    : "importance DESC";

  const canonicalRows = db.prepare(`
    SELECT id, content, title as summary, scope, importance, created_at, kind
    FROM canonical_memories
    WHERE (scope = ? OR scope = 'global')
      AND (valid_from IS NULL OR valid_from <= datetime('now'))
      AND (valid_to IS NULL OR valid_to >= datetime('now'))
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(scope, limit) as Array<{
    id: string;
    content: string;
    summary: string | null;
    scope: string;
    importance: number;
    created_at: string;
    kind: "fact" | "decision";
  }>;

  const rawRows = db.prepare(`
    SELECT id, content, summary, source, scope, importance, created_at, tags
    FROM memories
    WHERE deleted = 0
      AND (scope = ? OR scope = 'global')
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(scope, limit * 2) as Array<{
    id: string;
    content: string;
    summary: string | null;
    source: string;
    scope: string;
    importance: number;
    created_at: string;
    tags: string;
  }>;

  const canonicalKeys = new Set(
    canonicalRows.map((row) => `${row.scope}::${row.content}`)
  );

  const merged = [
    ...canonicalRows.map((row) => ({
      id: row.id,
      content: row.content,
      summary: row.summary,
      source: "canonical",
      importance: row.importance,
      created_at: row.created_at,
      tags: [] as string[],
      isCanonical: true,
      kind: row.kind,
    })),
    ...rawRows
      .filter((row) => !canonicalKeys.has(`${row.scope}::${row.content}`))
      .map((row) => ({
        ...row,
        tags: JSON.parse(row.tags) as string[],
        isCanonical: false,
        kind: "raw" as const,
      })),
  ].slice(0, limit);

  const rawIds = merged.filter((row) => !row.isCanonical).map((row) => row.id);
  if (rawIds.length > 0) {
    const now = new Date().toISOString();
    const placeholders = rawIds.map(() => "?").join(",");
    db.prepare(
      `UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id IN (${placeholders})`
    ).run(now, ...rawIds);
  }

  return {
    scope,
    memories: merged,
  };
}
