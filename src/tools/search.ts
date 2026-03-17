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
  asOf?: string;
}

export interface CanonicalSearchParams {
  query: string;
  scope?: string;
  limit?: number;
  minScore?: number;
  asOf?: string;
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
  isCanonical?: boolean;
  kind?: "fact" | "decision" | "raw";
  valid_from?: string | null;
  valid_to?: string | null;
  decided_at?: string | null;
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
  const allowCanonical = !params.source && !params.agent;

  // Generate query embedding
  const queryEmbedding = await embed(params.query, embedOpts);

  const canonicalResults = allowCanonical
    ? searchCanonicalMemories(db, params, queryEmbedding, limit, minScore)
    : [];
  const rawResults = searchRawMemories(db, params, queryEmbedding, limit, minScore);
  if (params.asOf) {
    return canonicalResults.slice(0, limit);
  }

  const merged = [...canonicalResults];
  for (const raw of rawResults) {
    if (!canonicalResults.some((item) => item.content === raw.content && item.scope === raw.scope)) {
      merged.push(raw);
    }
  }

  return merged.slice(0, limit);
}

export async function memorySearchCanonical(
  db: Database.Database,
  params: CanonicalSearchParams,
  embedOpts?: EmbedderOptions
): Promise<MemoryResult[]> {
  const limit = params.limit || 10;
  const minScore = params.minScore ?? 0.0;
  const queryEmbedding = await embed(params.query, embedOpts);
  return searchCanonicalMemories(db, params, queryEmbedding, limit, minScore);
}

function searchCanonicalMemories(
  db: Database.Database,
  params: SearchParams,
  queryEmbedding: Float32Array,
  limit: number,
  minScore: number
): MemoryResult[] {
  const filterConditions: string[] = [];
  const filterParams: unknown[] = [];
  if (params.scope) {
    filterConditions.push("scope = ?");
    filterParams.push(params.scope);
  }
  if (params.asOf) {
    filterConditions.push("(valid_from IS NULL OR valid_from <= ?)");
    filterParams.push(params.asOf);
    filterConditions.push("(valid_to IS NULL OR valid_to >= ?)");
    filterParams.push(params.asOf);
  }
  const whereClause = filterConditions.length > 0 ? `WHERE ${filterConditions.join(" AND ")}` : "";

  const multipliers = [5, 10, 20];
  let vecResults: Array<{ id: string; distance: number }> = [];
  let ftsResults: Array<{ id: string; rank: number }> = [];

  for (const multiplier of multipliers) {
    const fetchLimit = limit * multiplier;
    const vecRaw = db.prepare(`
      SELECT id, distance
      FROM canonical_memory_vec
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `).all(Buffer.from(queryEmbedding.buffer), fetchLimit) as Array<{ id: string; distance: number }>;

    vecResults = vecRaw;
    if (vecRaw.length > 0) {
      const vecIds = vecRaw.map((r) => r.id);
      const ph = vecIds.map(() => "?").join(",");
      const validIds = new Set(
        (db.prepare(
          `SELECT id FROM canonical_memories ${whereClause} ${whereClause ? "AND" : "WHERE"} id IN (${ph})`
        ).all(...filterParams, ...vecIds) as Array<{ id: string }>).map((r) => r.id)
      );
      vecResults = vecRaw.filter((r) => validIds.has(r.id));
    }

    ftsResults = [];
    try {
      const ftsRaw = db.prepare(`
        SELECT id, rank
        FROM canonical_memory_fts
        WHERE canonical_memory_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(escapeFtsQuery(params.query), fetchLimit) as Array<{ id: string; rank: number }>;

      if (ftsRaw.length > 0) {
        const ftsIds = ftsRaw.map((r) => r.id);
        const ph = ftsIds.map(() => "?").join(",");
        const validIds = new Set(
          (db.prepare(
            `SELECT id FROM canonical_memories ${whereClause} ${whereClause ? "AND" : "WHERE"} id IN (${ph})`
          ).all(...filterParams, ...ftsIds) as Array<{ id: string }>).map((r) => r.id)
        );
        ftsResults = ftsRaw.filter((r) => validIds.has(r.id));
      }
    } catch {
      // fall through to vec-only
    }

    const uniqueIds = new Set([...vecResults.map((r) => r.id), ...ftsResults.map((r) => r.id)]);
    if (uniqueIds.size >= limit || vecRaw.length < fetchLimit) break;
  }

  const merged = rrfMerge(
    [vecResults.map((r) => ({ id: r.id })), ftsResults.map((r) => ({ id: r.id }))],
    60,
    limit
  );
  if (merged.length === 0) return [];

  const maxScore = merged[0].score;
  if (maxScore > 0) {
    for (const item of merged) item.score = item.score / maxScore;
  }
  const filtered = merged.filter((r) => r.score >= minScore);
  if (filtered.length === 0) return [];

  const ids = filtered.map((r) => r.id);
  const scoreMap = new Map(filtered.map((r) => [r.id, r.score]));
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, kind, title, content, scope, importance, created_at, valid_from, valid_to, decided_at
    FROM canonical_memories
    WHERE id IN (${placeholders})
  `).all(...ids) as Array<{
    id: string;
    kind: "fact" | "decision";
    title: string;
    content: string;
    scope: string;
    importance: number;
    created_at: string;
    valid_from: string | null;
    valid_to: string | null;
    decided_at: string | null;
  }>;

  return rows
    .map((row) => ({
      id: row.id,
      content: row.content,
      summary: row.title,
      source: "canonical",
      scope: row.scope,
      tags: [],
      importance: row.importance,
      created_at: row.created_at,
      score: scoreMap.get(row.id) || 0,
      isCanonical: true,
      kind: row.kind,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      decided_at: row.decided_at,
    }))
    .sort((a, b) => b.score - a.score);
}

function searchRawMemories(
  db: Database.Database,
  params: SearchParams,
  queryEmbedding: Float32Array,
  limit: number,
  minScore: number
): MemoryResult[] {
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
  if (filtered.length === 0) return [];

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
      isCanonical: false,
      kind: "raw" as const,
      valid_from: null,
      valid_to: null,
      decided_at: null,
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
