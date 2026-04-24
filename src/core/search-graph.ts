import type Database from "better-sqlite3";
import { memorySearchCanonical, type MemoryResult } from "../tools/search.js";

export interface SearchGraphParams {
  query: string;
  scope?: string;
  limit?: number;
  asOf?: string;
  hopDepth?: 1 | 2;
}

export interface SearchGraphResultItem {
  id: string;
  summary: string | null;
  content: string;
  scope: string;
  score: number;
  isCanonical: true;
  kind: "fact" | "decision";
  hasConflict: boolean;
}

export interface CandidateGraphResultItem {
  id: string;
  rawMemoryId: string;
  summary: string | null;
  content: string;
  scope: string;
  status: "queued" | "processing" | "approved" | "merged" | "rejected";
  candidateKind: "fact" | "decision" | "unknown";
  priorityScore: number;
  confidence: number | null;
  rationale: string | null;
  matchedCanonicalId: string | null;
}

export interface GraphNodePayload {
  id: string;
  kind: "canonical" | "raw";
  label: string;
  scope: string;
  canonicalKind?: "fact" | "decision";
}

export interface GraphEdgePayload {
  id: string;
  source: string;
  target: string;
  type: "supersedes" | "contradicts" | "canonical_evidence";
}

export interface SearchGraphResponse {
  confirmed: SearchGraphResultItem[];
  candidates: CandidateGraphResultItem[];
  graph: {
    nodes: GraphNodePayload[];
    edges: GraphEdgePayload[];
    meta: {
      seedCount: number;
      expandedNodeCount: number;
      hopDepth: 1 | 2;
      rerankVersion: string;
    };
  };
}

interface CanonicalNodeRow {
  id: string;
  kind: "fact" | "decision";
  title: string;
  content: string;
  scope: string;
  importance: number;
  confidence: number;
  valid_from: string | null;
  valid_to: string | null;
}

interface RawNodeRow {
  id: string;
  content: string;
  scope: string;
}

interface CandidateRow {
  id: string;
  raw_memory_id: string;
  scope: string;
  status: "queued" | "processing" | "approved" | "merged" | "rejected";
  candidate_kind: "fact" | "decision" | "unknown";
  candidate_title: string | null;
  candidate_content: string;
  priority_score: number;
  confidence: number | null;
  rationale: string | null;
  matched_canonical_id: string | null;
}

const RERANK_VERSION = "v1";
const CURRENT_CANONICAL_BONUS = 0.15;
const SUPERSEDED_PENALTY = 0.2;
const CONTRADICTION_PENALTY = 0.1;
const EVIDENCE_BONUS = 0.05;
const TITLE_OVERLAP_BONUS = 0.2;
const EDGE_PROPAGATION_DECAY = 0.85;
const EDGE_PROPAGATION_BONUS = 0.1;
const IMPORTANCE_BONUS_WEIGHT = 0.03;
const CONFIDENCE_BONUS_WEIGHT = 0.05;
const EXPLICIT_HISTORY_TITLE_BONUS = 0.35;

export async function runGraphSearch(
  db: Database.Database,
  params: SearchGraphParams
): Promise<SearchGraphResponse> {
  const requestedLimit = params.limit ?? 10;
  const hopDepth = params.hopDepth ?? 1;
  const seeds = await collectCanonicalSeeds(db, params, requestedLimit);

  const canonicalIds = new Set<string>(seeds.map((row) => row.id));
  const rawIds = new Set<string>();
  const edges: GraphEdgePayload[] = [];
  const contradictionIds = new Set<string>();
  const evidenceCounts = new Map<string, number>();
  const seedScoreMap = new Map(seeds.map((row) => [row.id, row.score]));
  const propagatedScores = new Map(seeds.map((row) => [row.id, row.score]));

  // Memo of canonical id -> row, so repeated visits across hops never re-fetch.
  const nodeCache = new Map<string, CanonicalNodeRow | null>();
  const visitedForEdges = new Set<string>();

  let frontier = new Set<string>(seeds.map((row) => row.id));
  for (let hop = 0; hop < hopDepth && frontier.size > 0; hop += 1) {
    const frontierIds = Array.from(frontier).filter((id) => !visitedForEdges.has(id));
    for (const id of frontierIds) visitedForEdges.add(id);

    const edgeRows = fetchEdgesBatch(db, frontierIds);
    const evidenceRows = fetchEvidenceBatch(db, frontierIds);

    // Collect neighbor ids that aren't already materialized in the cache.
    // Both endpoints of every edge must be fetched — when both endpoints are in
    // the current frontier (e.g., two seeds linked by an edge), we still need
    // each to appear in nodeCache so bidirectional score propagation below can
    // resolve the neighbor node for each direction.
    const neighborIdsToFetch: string[] = [];
    const seenNeighbors = new Set<string>();
    for (const row of edgeRows) {
      for (const id of [row.from_canonical_id, row.to_canonical_id]) {
        if (seenNeighbors.has(id)) continue;
        seenNeighbors.add(id);
        if (!nodeCache.has(id)) {
          neighborIdsToFetch.push(id);
        }
      }
    }

    // One batched IN(...) fetch per hop for all un-cached neighbors.
    const fetched = fetchCanonicalNodesBatch(db, neighborIdsToFetch);
    for (const id of neighborIdsToFetch) {
      nodeCache.set(id, fetched.get(id) ?? null);
    }

    const nextFrontier = new Set<string>();
    // Preserve the original BFS semantics: each edge is evaluated once per
    // frontier endpoint it touches, so propagation happens in both directions
    // when both endpoints are in the frontier.
    for (const row of edgeRows) {
      const endpoints: Array<{ canonicalId: string; otherId: string }> = [];
      if (frontier.has(row.from_canonical_id)) {
        endpoints.push({ canonicalId: row.from_canonical_id, otherId: row.to_canonical_id });
      }
      if (frontier.has(row.to_canonical_id) && row.to_canonical_id !== row.from_canonical_id) {
        endpoints.push({ canonicalId: row.to_canonical_id, otherId: row.from_canonical_id });
      }

      // Emit the edge once, deduped by upsertEdge on its composite id.
      // This must run even if the neighbor turned out to be missing for one
      // endpoint path — but we only emit when at least one endpoint visit
      // produced a visible neighbor. Track that via `emitted`.
      let emitted = false;

      for (const { canonicalId, otherId } of endpoints) {
        const neighbor = nodeCache.get(otherId) ?? null;
        if (!neighbor || !isCanonicalVisible(neighbor, params.asOf)) continue;

        canonicalIds.add(neighbor.id);
        if (!visitedForEdges.has(neighbor.id)) {
          nextFrontier.add(neighbor.id);
        }
        const parentScore = propagatedScores.get(canonicalId) ?? seedScoreMap.get(canonicalId) ?? 0;
        const propagatedScore = parentScore * EDGE_PROPAGATION_DECAY;
        if (propagatedScore > (propagatedScores.get(neighbor.id) ?? 0)) {
          propagatedScores.set(neighbor.id, propagatedScore);
        }
        if (row.relation_type === "contradicts") {
          contradictionIds.add(canonicalId);
          contradictionIds.add(otherId);
        }

        if (!emitted) {
          upsertEdge(edges, {
            id: `${row.relation_type}:${row.from_canonical_id}:${row.to_canonical_id}`,
            source: row.from_canonical_id,
            target: row.to_canonical_id,
            type: row.relation_type,
          });
          emitted = true;
        }
      }
    }

    for (const row of evidenceRows) {
      rawIds.add(row.memory_id);
      evidenceCounts.set(row.canonical_id, (evidenceCounts.get(row.canonical_id) || 0) + 1);
      upsertEdge(edges, {
        id: `canonical_evidence:${row.canonical_id}:${row.memory_id}`,
        source: row.canonical_id,
        target: row.memory_id,
        type: "canonical_evidence",
      });
    }

    frontier = nextFrontier;
  }

  // Materialize any canonical ids not already in the cache (e.g., seeds).
  const unmaterialized = Array.from(canonicalIds).filter((id) => !nodeCache.has(id));
  if (unmaterialized.length > 0) {
    const fetched = fetchCanonicalNodesBatch(db, unmaterialized);
    for (const id of unmaterialized) {
      nodeCache.set(id, fetched.get(id) ?? null);
    }
  }

  const canonicalRows = Array.from(canonicalIds)
    .map((id) => nodeCache.get(id) ?? null)
    .filter((row): row is CanonicalNodeRow => Boolean(row))
    .filter((row) => isCanonicalVisible(row, params.asOf));
  const supersededIds = getSupersededIds(db, canonicalRows);

  const rawRows = Array.from(rawIds)
    .map((id) => getRawNode(db, id))
    .filter((row): row is RawNodeRow => Boolean(row));

  const scoredResults = canonicalRows
    .map((row) => {
      const baseScore = seedScoreMap.get(row.id) ?? 0;
      let score = Math.max(baseScore, propagatedScores.get(row.id) ?? 0);

      if (row.valid_to === null || row.valid_to === undefined) {
        score += CURRENT_CANONICAL_BONUS;
      } else {
        score -= SUPERSEDED_PENALTY;
      }

      const hasConflict = contradictionIds.has(row.id);
      if (hasConflict) {
        score -= CONTRADICTION_PENALTY;
      }

      if ((evidenceCounts.get(row.id) || 0) > 0) {
        score += EVIDENCE_BONUS;
      }
      if ((propagatedScores.get(row.id) ?? 0) > 0 && !seedScoreMap.has(row.id)) {
        score += EDGE_PROPAGATION_BONUS;
      }
      score += row.importance * IMPORTANCE_BONUS_WEIGHT;
      score += row.confidence * CONFIDENCE_BONUS_WEIGHT;
      score += computeTitleOverlap(row.title, params.query) * TITLE_OVERLAP_BONUS;
      if (titleMatchesExplicitHistoryTokens(row.title, params.query)) {
        score += EXPLICIT_HISTORY_TITLE_BONUS;
      }

      return {
        id: row.id,
        summary: row.title,
        content: row.content,
        scope: row.scope,
        score,
        isCanonical: true as const,
        kind: row.kind,
        hasConflict,
      };
    })
    .filter((row) => !shouldHideSupersededCanonical(row, supersededIds, params.query))
    .sort((a, b) => b.score - a.score)
    .slice(0, requestedLimit);

  const graphNodes: GraphNodePayload[] = [
    ...canonicalRows.map((row) => ({
      id: row.id,
      kind: "canonical" as const,
      label: row.title,
      scope: row.scope,
      canonicalKind: row.kind,
    })),
    ...rawRows.map((row) => ({
      id: row.id,
      kind: "raw" as const,
      label: row.content,
      scope: row.scope,
    })),
  ];

  const candidates = listCandidateRows(db, params, requestedLimit).map((row) => ({
    id: row.id,
    rawMemoryId: row.raw_memory_id,
    summary: row.candidate_title,
    content: row.candidate_content,
    scope: row.scope,
    status: row.status,
    candidateKind: row.candidate_kind,
    priorityScore: row.priority_score,
    confidence: row.confidence,
    rationale: row.rationale,
    matchedCanonicalId: row.matched_canonical_id,
  }));

  return {
    confirmed: scoredResults,
    candidates,
    graph: {
      nodes: graphNodes,
      edges,
      meta: {
        seedCount: seeds.length,
        expandedNodeCount: Math.max(graphNodes.length - seeds.length, 0),
        hopDepth,
        rerankVersion: RERANK_VERSION,
      },
    },
  };
}

async function collectCanonicalSeeds(
  db: Database.Database,
  params: SearchGraphParams,
  requestedLimit: number
): Promise<Array<MemoryResult & { isCanonical: true }>> {
  const multipliers = [3, 5, 10];
  let canonicalSeeds: Array<MemoryResult & { isCanonical: true }> = [];

  for (const multiplier of multipliers) {
    const fetchLimit = Math.max(requestedLimit * multiplier, 10);
    const baseline = await memorySearchCanonical(db, {
      query: params.query,
      scope: params.scope,
      limit: fetchLimit,
      asOf: params.asOf,
    });

    canonicalSeeds = baseline
      .filter((row): row is MemoryResult & { isCanonical: true } => row.isCanonical === true)
      .sort((a, b) => {
        const overlapDiff = computeTitleOverlap(b.summary ?? "", params.query)
          - computeTitleOverlap(a.summary ?? "", params.query);
        if (overlapDiff !== 0) return overlapDiff;
        return b.score - a.score;
      });
    if (canonicalSeeds.length >= requestedLimit || baseline.length < fetchLimit) {
      break;
    }
  }

  return canonicalSeeds.slice(0, requestedLimit);
}

function listCandidateRows(
  db: Database.Database,
  params: SearchGraphParams,
  requestedLimit: number
): CandidateRow[] {
  const whereClauses = [
    "memories.deleted = 0",
  ];
  const queryParams: unknown[] = [];

  if (params.scope) {
    whereClauses.push("canonical_candidates.scope = ?");
    queryParams.push(params.scope);
  }

  const rows = db.prepare(`
    SELECT canonical_candidates.id,
           canonical_candidates.raw_memory_id,
           canonical_candidates.scope,
           canonical_candidates.status,
           canonical_candidates.candidate_kind,
           canonical_candidates.candidate_title,
           canonical_candidates.candidate_content,
           canonical_candidates.priority_score,
           canonical_candidates.confidence,
           canonical_candidates.rationale,
           canonical_candidates.matched_canonical_id
    FROM canonical_candidates
    JOIN memories ON memories.id = canonical_candidates.raw_memory_id
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY
      CASE canonical_candidates.status
        WHEN 'queued' THEN 0
        WHEN 'processing' THEN 1
        ELSE 2
      END,
      COALESCE(canonical_candidates.confidence, 0) DESC,
      canonical_candidates.priority_score DESC,
      canonical_candidates.updated_at DESC
    LIMIT ?
  `).all(...queryParams, requestedLimit * 5) as CandidateRow[];

  const filtered = rows.filter((row) => candidateMatchesQuery(row, params.query));
  return filtered.slice(0, requestedLimit);
}

function fetchEdgesBatch(
  db: Database.Database,
  frontierIds: string[]
): Array<{ from_canonical_id: string; to_canonical_id: string; relation_type: "supersedes" | "contradicts" }> {
  if (frontierIds.length === 0) return [];
  const ph = frontierIds.map(() => "?").join(",");
  return db.prepare(`
    SELECT from_canonical_id, to_canonical_id, relation_type
    FROM canonical_edges
    WHERE from_canonical_id IN (${ph}) OR to_canonical_id IN (${ph})
  `).all(...frontierIds, ...frontierIds) as Array<{
    from_canonical_id: string;
    to_canonical_id: string;
    relation_type: "supersedes" | "contradicts";
  }>;
}

function fetchEvidenceBatch(
  db: Database.Database,
  frontierIds: string[]
): Array<{ canonical_id: string; memory_id: string }> {
  if (frontierIds.length === 0) return [];
  const ph = frontierIds.map(() => "?").join(",");
  return db.prepare(`
    SELECT canonical_id, memory_id
    FROM canonical_evidence
    WHERE canonical_id IN (${ph})
  `).all(...frontierIds) as Array<{ canonical_id: string; memory_id: string }>;
}

function fetchCanonicalNodesBatch(
  db: Database.Database,
  ids: string[]
): Map<string, CanonicalNodeRow> {
  const out = new Map<string, CanonicalNodeRow>();
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, kind, title, content, scope, importance, confidence, valid_from, valid_to
    FROM canonical_memories
    WHERE id IN (${ph})
  `).all(...ids) as CanonicalNodeRow[];
  for (const row of rows) out.set(row.id, row);
  return out;
}

function getRawNode(db: Database.Database, id: string): RawNodeRow | undefined {
  return db.prepare(`
    SELECT id, content, scope
    FROM memories
    WHERE id = ? AND deleted = 0
  `).get(id) as RawNodeRow | undefined;
}

function isCanonicalVisible(row: CanonicalNodeRow, asOf?: string): boolean {
  if (!asOf) return true;
  if (row.valid_from && row.valid_from > asOf) return false;
  if (row.valid_to && row.valid_to < asOf) return false;
  return true;
}

function upsertEdge(edges: GraphEdgePayload[], edge: GraphEdgePayload): void {
  if (!edges.some((existing) => existing.id === edge.id)) {
    edges.push(edge);
  }
}

function getSupersededIds(
  db: Database.Database,
  rows: CanonicalNodeRow[]
): Set<string> {
  if (rows.length === 0) return new Set<string>();

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const edgeRows = db.prepare(`
    SELECT to_canonical_id
    FROM canonical_edges
    WHERE relation_type = 'supersedes'
      AND from_canonical_id IN (${placeholders})
      AND to_canonical_id IN (${placeholders})
  `).all(...ids, ...ids) as Array<{ to_canonical_id: string }>;

  return new Set(edgeRows.map((row) => row.to_canonical_id));
}

function tokenize(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

function computeTitleOverlap(title: string, query: string): number {
  const titleTokens = new Set(tokenize(title));
  const queryTokens = tokenize(query);
  if (titleTokens.size === 0 || queryTokens.length === 0) return 0;

  const hits = queryTokens.filter((token) => titleTokens.has(token)).length;
  return hits / queryTokens.length;
}

function candidateMatchesQuery(row: CandidateRow, query: string): boolean {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return true;

  const haystack = new Set(tokenize(`${row.candidate_title ?? ""} ${row.candidate_content}`));
  const hits = queryTokens.filter((token) => haystack.has(token)).length;
  return hits > 0;
}

function shouldHideSupersededCanonical(
  row: CanonicalNodeRow,
  supersededIds: Set<string>,
  query: string
): boolean {
  if (!supersededIds.has(row.id)) return false;
  if (hasExplicitHistoricalQuery(query)) return false;
  return !titleMatchesExplicitHistoryTokens(row.title, query);
}

function hasExplicitHistoricalQuery(query: string): boolean {
  return extractExplicitHistoryTokens(query).length > 0;
}

function titleMatchesExplicitHistoryTokens(title: string, query: string): boolean {
  const titleLower = (title ?? "").toLowerCase();
  const explicitTokens = extractExplicitHistoryTokens(query);
  if (explicitTokens.length === 0) return false;
  return explicitTokens.some((token) => titleLower.includes(token));
}

function extractExplicitHistoryTokens(query: string): string[] {
  const queryLower = (query ?? "").toLowerCase();
  return [
    ...queryLower.matchAll(/\bv\d+(?:\.\d+)?\b/g),
    ...queryLower.matchAll(/\bphase\s+\d+\b/g),
    ...queryLower.matchAll(/\bold\b/g),
    ...queryLower.matchAll(/\blegacy\b/g),
    ...queryLower.matchAll(/\bdeprecated\b/g),
    ...queryLower.matchAll(/\bappendix\b/g),
  ].map((match) => match[0].trim());
}
