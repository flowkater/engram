/**
 * memory.search — Hybrid search using vector similarity + FTS5 + RRF.
 */
import type Database from "better-sqlite3";
import { embed, type EmbedderOptions } from "../core/embedder.js";
import { rrfMerge } from "../utils/rrf.js";

export interface SearchParams {
  query: string;
  scope?: string;
  limit?: number;
  source?: string;
  agent?: string;
  minScore?: number;
}

export interface MemoryResult {
  id: string;
  content: string;
  summary: string | null;
  source: string;
  scope: string;
  tags: string[];
  importance: number;
  created_at: string;
  score: number;
}

/**
 * Hybrid search: vector similarity (sqlite-vec) + keyword (FTS5) + RRF merge.
 */
export async function memorySearch(
  db: Database.Database,
  params: SearchParams,
  embedOpts?: EmbedderOptions
): Promise<MemoryResult[]> {
  const limit = params.limit || 10;
  const fetchLimit = limit * 3;
  const minScore = params.minScore ?? 0.0;

  // Generate query embedding
  const queryEmbedding = await embed(params.query, embedOpts);

  // Build scope/source/agent filter conditions for SQL
  const filterConditions: string[] = ["m.deleted = 0"];
  const filterParams: unknown[] = [];
  if (params.scope) {
    filterConditions.push("m.scope = ?");
    filterParams.push(params.scope);
  }
  if (params.source) {
    filterConditions.push("m.source = ?");
    filterParams.push(params.source);
  }
  if (params.agent) {
    filterConditions.push("m.agent = ?");
    filterParams.push(params.agent);
  }
  const whereClause = filterConditions.join(" AND ");

  // 1. Vector search — sqlite-vec requires k=? in WHERE, no external LIMIT
  //    Filters applied post-hoc since sqlite-vec KNN doesn't support JOINs in WHERE
  const vecRaw = db
    .prepare(
      `
      SELECT id, distance
      FROM memory_vec
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `
    )
    .all(Buffer.from(queryEmbedding.buffer), fetchLimit) as Array<{
    id: string;
    distance: number;
  }>;

  // Post-filter vec results by scope/source/agent/deleted via a lookup
  let vecResults = vecRaw;
  if (filterParams.length > 0 || true /* always filter deleted */) {
    const vecIds = vecRaw.map((r) => r.id);
    if (vecIds.length > 0) {
      const ph = vecIds.map(() => "?").join(",");
      const validIds = new Set(
        (db.prepare(
          `SELECT id FROM memories WHERE id IN (${ph}) AND ${whereClause}`
        ).all(...vecIds, ...filterParams) as Array<{ id: string }>).map((r) => r.id)
      );
      vecResults = vecRaw.filter((r) => validIds.has(r.id));
    }
  }

  // 2. FTS5 keyword search with scope/source/agent filter
  let ftsResults: Array<{ id: string; rank: number }> = [];
  try {
    const ftsRaw = db
      .prepare(
        `
        SELECT id, rank
        FROM memory_fts
        WHERE memory_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `
      )
      .all(escapeFtsQuery(params.query), fetchLimit) as Array<{
      id: string;
      rank: number;
    }>;

    // Post-filter by scope/source/agent/deleted
    if (ftsRaw.length > 0 && (filterParams.length > 0 || true)) {
      const ftsIds = ftsRaw.map((r) => r.id);
      const ph = ftsIds.map(() => "?").join(",");
      const validIds = new Set(
        (db.prepare(
          `SELECT id FROM memories WHERE id IN (${ph}) AND ${whereClause}`
        ).all(...ftsIds, ...filterParams) as Array<{ id: string }>).map((r) => r.id)
      );
      ftsResults = ftsRaw.filter((r) => validIds.has(r.id));
    } else {
      ftsResults = ftsRaw;
    }
  } catch {
    // FTS query might fail on special characters; fall back to vec only
  }

  // 3. RRF merge
  const merged = rrfMerge(
    [
      vecResults.map((r) => ({ id: r.id })),
      ftsResults.map((r) => ({ id: r.id })),
    ],
    60,
    limit
  );

  if (merged.length === 0) return [];

  // Filter by minScore
  const filtered = merged.filter((r) => r.score >= minScore);

  // 4. Fetch full memory records
  const ids = filtered.map((r) => r.id);
  const scoreMap = new Map(filtered.map((r) => [r.id, r.score]));

  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `
      SELECT id, content, summary, source, scope, tags, importance, created_at
      FROM memories
      WHERE id IN (${placeholders}) AND deleted = 0
    `
    )
    .all(...ids) as Array<{
    id: string;
    content: string;
    summary: string | null;
    source: string;
    scope: string;
    tags: string;
    importance: number;
    created_at: string;
  }>;

  // Update access stats
  if (ids.length > 0) {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id IN (${placeholders})`
    ).run(now, ...ids);
  }

  // Sort by RRF score (scope/source/agent already filtered in SQL)
  return rows
    .map((r) => ({
      ...r,
      tags: JSON.parse(r.tags) as string[],
      score: scoreMap.get(r.id) || 0,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Escape special FTS5 characters in query.
 */
function escapeFtsQuery(query: string): string {
  // Wrap each word in quotes to avoid FTS5 syntax errors
  return query
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(" AND ");
}
