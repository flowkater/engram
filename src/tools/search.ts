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
  const minScore = params.minScore ?? 0.0;

  // Generate query embedding
  const queryEmbedding = await embed(params.query, embedOpts);

  // Build scope/source/agent filter conditions for SQL
  const filterConditions: string[] = ["deleted = 0"];
  const filterParams: unknown[] = [];
  if (params.scope) {
    filterConditions.push("scope = ?");
    filterParams.push(params.scope);
  }
  if (params.source) {
    filterConditions.push("source = ?");
    filterParams.push(params.source);
  }
  if (params.agent) {
    filterConditions.push("agent = ?");
    filterParams.push(params.agent);
  }
  const whereClause = filterConditions.join(" AND ");

  // Adaptive fetch: increase multiplier if post-filter yields too few results
  const multipliers = [5, 10, 20];
  let vecResults: Array<{ id: string; distance: number }> = [];
  let ftsResults: Array<{ id: string; rank: number }> = [];

  for (const multiplier of multipliers) {
    const fetchLimit = limit * multiplier;

    // 1. Vector search
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

    // Post-filter vec results by scope/source/agent/deleted
    vecResults = vecRaw;
    if (vecRaw.length > 0) {
      const vecIds = vecRaw.map((r) => r.id);
      const ph = vecIds.map(() => "?").join(",");
      const validIds = new Set(
        (db.prepare(
          `SELECT id FROM memories WHERE id IN (${ph}) AND ${whereClause}`
        ).all(...vecIds, ...filterParams) as Array<{ id: string }>).map((r) => r.id)
      );
      vecResults = vecRaw.filter((r) => validIds.has(r.id));
    }

    // 2. FTS5 keyword search
    ftsResults = [];
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

      if (ftsRaw.length > 0) {
        const ftsIds = ftsRaw.map((r) => r.id);
        const ph = ftsIds.map(() => "?").join(",");
        const validIds = new Set(
          (db.prepare(
            `SELECT id FROM memories WHERE id IN (${ph}) AND ${whereClause}`
          ).all(...ftsIds, ...filterParams) as Array<{ id: string }>).map((r) => r.id)
        );
        ftsResults = ftsRaw.filter((r) => validIds.has(r.id));
      }
    } catch {
      // FTS query might fail on special characters; fall back to vec only
    }

    // Check if we have enough results
    const uniqueIds = new Set([...vecResults.map((r) => r.id), ...ftsResults.map((r) => r.id)]);
    if (uniqueIds.size >= limit) break;
    // If we fetched all available vectors, no point increasing multiplier
    if (vecRaw.length < fetchLimit) break;
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

  // Normalize scores to 0~1 (max score = 1.0)
  const maxScore = merged[0].score;
  if (maxScore > 0) {
    for (const item of merged) {
      item.score = item.score / maxScore;
    }
  }

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
