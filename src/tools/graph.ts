/**
 * memory.graph — Explore memory connections via the graph layer.
 * Traverses memory_links table to find related memories up to N hops.
 */
import type Database from "better-sqlite3";
import { memorySearch, type SearchParams } from "./search.js";
import type { EmbedderOptions } from "../core/embedder.js";

/**
 * Hard cap on BFS hop depth. Prevents fan-out explosion when callers
 * pass large `hops` values. Common case (hops <= 3) is unaffected.
 */
export const MAX_GRAPH_HOP_DEPTH = 3;

export interface GraphParams {
  memoryId?: string;
  query?: string;
  hops?: number;
  linkType?: "wikilink" | "tag" | "scope" | "session" | "all";
  limit?: number;
}

export interface ConnectedMemory {
  memory: {
    id: string;
    content: string;
    source: string;
    scope: string;
  };
  linkType: string;
  hop: number;
  weight: number;
}

export interface GraphResult {
  root: {
    id: string;
    content: string;
    source: string;
    scope: string;
  } | null;
  connected: ConnectedMemory[];
  totalLinks: number;
}

type MemoryRow = { id: string; content: string; source: string; scope: string };

/**
 * Batch-fetch memories by id in a single SELECT ... WHERE id IN (...).
 * Skips ids we've already fetched (memoized in `cache`).
 */
function fetchMemoriesBatch(
  db: Database.Database,
  ids: string[],
  cache: Map<string, MemoryRow>
): void {
  const missing = ids.filter((id) => !cache.has(id));
  if (missing.length === 0) return;
  const ph = missing.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, content, source, scope FROM memories WHERE id IN (${ph}) AND deleted = 0`
    )
    .all(...missing) as MemoryRow[];
  for (const row of rows) cache.set(row.id, row);
}

/**
 * Explore the memory graph from a starting point.
 */
export async function memoryGraph(
  db: Database.Database,
  params: GraphParams,
  embedOpts?: EmbedderOptions
): Promise<GraphResult> {
  const hops = Math.min(params.hops ?? 2, MAX_GRAPH_HOP_DEPTH);
  const limit = params.limit ?? 10;
  const linkTypeFilter = params.linkType || "all";

  // Determine root memory
  let rootId: string | null = params.memoryId || null;

  if (!rootId && params.query) {
    // Find the most relevant memory via search
    const results = await memorySearch(db, { query: params.query, limit: 1 }, embedOpts);
    if (results.length > 0) {
      rootId = results[0].id;
    }
  }

  if (!rootId) {
    return { root: null, connected: [], totalLinks: 0 };
  }

  // Fetch root memory (single lookup — not part of BFS fan-out)
  const root = db
    .prepare("SELECT id, content, source, scope FROM memories WHERE id = ? AND deleted = 0")
    .get(rootId) as MemoryRow | undefined;

  if (!root) {
    return { root: null, connected: [], totalLinks: 0 };
  }

  // BFS traversal through links with batched per-hop memory fetch.
  const memoryCache = new Map<string, MemoryRow>();
  memoryCache.set(root.id, root);

  const visited = new Set<string>([rootId]);
  const connected: ConnectedMemory[] = [];
  let frontier = [rootId];

  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    // Collect all edges originating from (or pointing at) the current
    // frontier in a single batched query per direction.
    const framePh = frontier.map(() => "?").join(",");

    let outQuery = `
      SELECT from_id, to_id, link_type, weight
      FROM memory_links
      WHERE from_id IN (${framePh})
    `;
    const outParams: unknown[] = [...frontier];
    if (linkTypeFilter !== "all") {
      outQuery += " AND link_type = ?";
      outParams.push(linkTypeFilter);
    }
    const outLinks = db.prepare(outQuery).all(...outParams) as Array<{
      from_id: string;
      to_id: string;
      link_type: string;
      weight: number;
    }>;

    let inQuery = `
      SELECT from_id, to_id, link_type, weight
      FROM memory_links
      WHERE to_id IN (${framePh})
    `;
    const inParams: unknown[] = [...frontier];
    if (linkTypeFilter !== "all") {
      inQuery += " AND link_type = ?";
      inParams.push(linkTypeFilter);
    }
    const inLinks = db.prepare(inQuery).all(...inParams) as Array<{
      from_id: string;
      to_id: string;
      link_type: string;
      weight: number;
    }>;

    // Build per-frontier-node edge lists preserving original semantics:
    // for a node N in the frontier, outgoing = from_id=N, incoming reverse = to_id=N,
    // and in both cases the "neighbor" is the other endpoint.
    const neighborEdges: Array<{
      fromNode: string;
      toNode: string;
      link_type: string;
      weight: number;
    }> = [];
    for (const l of outLinks) {
      neighborEdges.push({ fromNode: l.from_id, toNode: l.to_id, link_type: l.link_type, weight: l.weight });
    }
    for (const l of inLinks) {
      // Treat `from_id` as the neighbor when traversing backwards.
      neighborEdges.push({ fromNode: l.to_id, toNode: l.from_id, link_type: l.link_type, weight: l.weight });
    }

    // Collect candidate neighbor ids (unvisited) for batched memory fetch.
    const candidates: string[] = [];
    const seenThisHop = new Set<string>();
    for (const e of neighborEdges) {
      if (visited.has(e.toNode)) continue;
      if (seenThisHop.has(e.toNode)) continue;
      seenThisHop.add(e.toNode);
      candidates.push(e.toNode);
    }

    // Batch-fetch memories for all candidates in ONE SELECT ... IN (...).
    fetchMemoriesBatch(db, candidates, memoryCache);

    const nextFrontier: string[] = [];
    for (const e of neighborEdges) {
      if (visited.has(e.toNode)) continue;
      const mem = memoryCache.get(e.toNode);
      if (!mem) continue; // deleted or missing — skip
      visited.add(e.toNode);
      connected.push({
        memory: mem,
        linkType: e.link_type,
        hop,
        weight: e.weight,
      });
      nextFrontier.push(e.toNode);
    }

    frontier = nextFrontier;
  }

  // Sort by hop then weight, limit results
  connected.sort((a, b) => a.hop - b.hop || b.weight - a.weight);
  const limited = connected.slice(0, limit);

  // Total link count for this root
  const totalLinks = (db.prepare(
    "SELECT COUNT(*) as c FROM memory_links WHERE from_id = ? OR to_id = ?"
  ).get(rootId, rootId) as { c: number }).c;

  return {
    root,
    connected: limited,
    totalLinks,
  };
}
