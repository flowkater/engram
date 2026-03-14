import type Database from "better-sqlite3";
import { memorySearch, type MemoryResult } from "../tools/search.js";

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
  results: SearchGraphResultItem[];
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
  valid_from: string | null;
  valid_to: string | null;
}

interface RawNodeRow {
  id: string;
  content: string;
  scope: string;
}

const RERANK_VERSION = "v1";
const CURRENT_CANONICAL_BONUS = 0.15;
const SUPERSEDED_PENALTY = 0.2;
const CONTRADICTION_PENALTY = 0.1;
const EVIDENCE_BONUS = 0.05;

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

  let frontier = new Set<string>(seeds.map((row) => row.id));
  for (let hop = 0; hop < hopDepth && frontier.size > 0; hop += 1) {
    const nextFrontier = new Set<string>();

    for (const canonicalId of frontier) {
      const edgeRows = db.prepare(`
        SELECT from_canonical_id, to_canonical_id, relation_type
        FROM canonical_edges
        WHERE from_canonical_id = ? OR to_canonical_id = ?
      `).all(canonicalId, canonicalId) as Array<{
        from_canonical_id: string;
        to_canonical_id: string;
        relation_type: "supersedes" | "contradicts";
      }>;

      for (const row of edgeRows) {
        const otherId = row.from_canonical_id === canonicalId
          ? row.to_canonical_id
          : row.from_canonical_id;
        const neighbor = getCanonicalNode(db, otherId);
        if (!neighbor || !isCanonicalVisible(neighbor, params.asOf)) continue;

        canonicalIds.add(neighbor.id);
        nextFrontier.add(neighbor.id);
        if (row.relation_type === "contradicts") {
          contradictionIds.add(canonicalId);
          contradictionIds.add(otherId);
        }

        upsertEdge(edges, {
          id: `${row.relation_type}:${row.from_canonical_id}:${row.to_canonical_id}`,
          source: row.from_canonical_id,
          target: row.to_canonical_id,
          type: row.relation_type,
        });
      }

      const evidenceRows = db.prepare(`
        SELECT canonical_id, memory_id
        FROM canonical_evidence
        WHERE canonical_id = ?
      `).all(canonicalId) as Array<{ canonical_id: string; memory_id: string }>;

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
    }

    frontier = nextFrontier;
  }

  const canonicalRows = Array.from(canonicalIds)
    .map((id) => getCanonicalNode(db, id))
    .filter((row): row is CanonicalNodeRow => Boolean(row))
    .filter((row) => isCanonicalVisible(row, params.asOf));

  const rawRows = Array.from(rawIds)
    .map((id) => getRawNode(db, id))
    .filter((row): row is RawNodeRow => Boolean(row));

  const seedScoreMap = new Map(seeds.map((row) => [row.id, row.score]));
  const scoredResults = canonicalRows
    .map((row) => {
      const baseScore = seedScoreMap.get(row.id) ?? 0;
      let score = baseScore;

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

  return {
    results: scoredResults,
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
    const baseline = await memorySearch(db, {
      query: params.query,
      scope: params.scope,
      limit: fetchLimit,
      asOf: params.asOf,
    });

    canonicalSeeds = baseline.filter(
      (row): row is MemoryResult & { isCanonical: true } => row.isCanonical === true
    );
    if (canonicalSeeds.length >= requestedLimit || baseline.length < fetchLimit) {
      break;
    }
  }

  return canonicalSeeds.slice(0, requestedLimit);
}

function getCanonicalNode(db: Database.Database, id: string): CanonicalNodeRow | undefined {
  return db.prepare(`
    SELECT id, kind, title, content, scope, valid_from, valid_to
    FROM canonical_memories
    WHERE id = ?
  `).get(id) as CanonicalNodeRow | undefined;
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
