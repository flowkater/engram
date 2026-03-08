/**
 * memory.graph — Explore memory connections via the graph layer.
 * Traverses memory_links table to find related memories up to N hops.
 */
import type Database from "better-sqlite3";
import { memorySearch, type SearchParams } from "./search.js";
import type { EmbedderOptions } from "../core/embedder.js";

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

/**
 * Explore the memory graph from a starting point.
 */
export async function memoryGraph(
  db: Database.Database,
  params: GraphParams,
  embedOpts?: EmbedderOptions
): Promise<GraphResult> {
  const hops = Math.min(params.hops ?? 2, 3);
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

  // Fetch root memory
  const root = db.prepare(
    "SELECT id, content, source, scope FROM memories WHERE id = ? AND deleted = 0"
  ).get(rootId) as { id: string; content: string; source: string; scope: string } | undefined;

  if (!root) {
    return { root: null, connected: [], totalLinks: 0 };
  }

  // BFS traversal through links
  const visited = new Set<string>([rootId]);
  const connected: ConnectedMemory[] = [];
  let frontier = [rootId];

  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      // Get outgoing links
      let linkQuery = `
        SELECT to_id, link_type, weight FROM memory_links
        WHERE from_id = ?
      `;
      const linkParams: unknown[] = [nodeId];

      if (linkTypeFilter !== "all") {
        linkQuery += " AND link_type = ?";
        linkParams.push(linkTypeFilter);
      }

      const links = db.prepare(linkQuery).all(...linkParams) as Array<{
        to_id: string;
        link_type: string;
        weight: number;
      }>;

      // Also check incoming links (bidirectional)
      let inLinkQuery = `
        SELECT from_id as to_id, link_type, weight FROM memory_links
        WHERE to_id = ?
      `;
      const inLinkParams: unknown[] = [nodeId];

      if (linkTypeFilter !== "all") {
        inLinkQuery += " AND link_type = ?";
        inLinkParams.push(linkTypeFilter);
      }

      const inLinks = db.prepare(inLinkQuery).all(...inLinkParams) as Array<{
        to_id: string;
        link_type: string;
        weight: number;
      }>;

      const allLinks = [...links, ...inLinks];

      for (const link of allLinks) {
        if (visited.has(link.to_id)) continue;
        visited.add(link.to_id);

        const mem = db.prepare(
          "SELECT id, content, source, scope FROM memories WHERE id = ? AND deleted = 0"
        ).get(link.to_id) as { id: string; content: string; source: string; scope: string } | undefined;

        if (mem) {
          connected.push({
            memory: mem,
            linkType: link.link_type,
            hop,
            weight: link.weight,
          });
          nextFrontier.push(link.to_id);
        }
      }
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
