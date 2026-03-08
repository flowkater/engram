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

  // 1. Vector search (cosine similarity via sqlite-vec)
  const vecResults = db
    .prepare(
      `
      SELECT id, distance
      FROM memory_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `
    )
    .all(Buffer.from(queryEmbedding.buffer), fetchLimit) as Array<{
    id: string;
    distance: number;
  }>;

  // 2. FTS5 keyword search
  let ftsResults: Array<{ id: string; rank: number }> = [];
  try {
    ftsResults = db
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

  // Apply scope/source/agent filters and sort by RRF score
  return rows
    .filter((r) => {
      if (params.scope && r.scope !== params.scope) return false;
      if (params.source && r.source !== params.source) return false;
      return true;
    })
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
    .join(" OR ");
}
