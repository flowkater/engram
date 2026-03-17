import type Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { memoryAdd } from "../tools/add.js";
import { memorySearch } from "../tools/search.js";
import { memorySearchGraph } from "../tools/search-graph.js";
import { memoryContext } from "../tools/context.js";
import { memorySummary } from "../tools/summary.js";
import { memoryIngest } from "../tools/ingest.js";
import { memoryPrune } from "../tools/prune.js";
import { memoryStats } from "../tools/stats.js";
import { memoryGraph } from "../tools/graph.js";
import { memoryHealth } from "../tools/health.js";
import { memoryRestore } from "../tools/restore.js";
import { memoryPromote } from "../tools/promote.js";
import { appendSearchQueryLog, resolveSearchQueryLogPath } from "./query-log.js";

export interface SessionTrackerLike {
  recordActivity(toolName: string, payload: Record<string, unknown>): void;
}

export interface CreateEngramServerArgs {
  db: Database.Database;
  dbPath: string;
  log: (message: string) => void;
  sessionTracker: SessionTrackerLike;
}

function errorResponse(log: (message: string) => void, toolName: string, err: unknown) {
  const message = (err as Error).message;
  log(`${toolName} error: ${message}`);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function safeAppendSearchQueryLog(
  log: (message: string) => void,
  entry: {
    tool: "memory.search" | "memory.search_graph";
    query: string;
    scope?: string;
    asOf?: string;
    timestamp: string;
  }
) {
  try {
    appendSearchQueryLog(resolveSearchQueryLogPath(), entry);
  } catch (err) {
    log(`query log append failed: ${(err as Error).message}`);
  }
}

export function createEngramServer(args: CreateEngramServerArgs): McpServer {
  const server = new McpServer({
    name: "engram",
    version: "0.1.0",
  });

  server.tool(
    "memory.add",
    "Save a new memory. Record decisions, learnings, and context.",
    {
      content: z.string().describe("Content to remember"),
      scope: z.string().optional().describe("Project scope (e.g. 'todait-backend')"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      importance: z.number().min(0).max(1).optional().describe("Importance score (0-1)"),
      summary: z.string().optional().describe("One-line summary (optional)"),
    },
    async ({ content, scope, tags, importance, summary }) => {
      try {
        args.sessionTracker.recordActivity("memory.add", { content, scope, tags, importance, summary });
        const result = await memoryAdd(args.db, { content, scope, tags, importance, summary });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResponse(args.log, "memory.add", err);
      }
    }
  );

  server.tool(
    "memory.search",
    "Semantic + keyword hybrid search across all memories.",
    {
      query: z.string().describe("Search query"),
      scope: z.string().optional().describe("Project scope filter"),
      limit: z.number().optional().describe("Max results (default 10)"),
      source: z.enum(["obsidian", "session", "manual", "notion", "memory-md"]).optional().describe("Source filter"),
      agent: z.string().optional().describe("Agent filter"),
      minScore: z.number().optional().describe("Minimum relevance score (0~1 normalized, where 1.0 = best match). Default: 0"),
      asOf: z.string().optional().describe("Optional ISO timestamp for time-aware canonical search"),
    },
    async ({ query, scope, limit, source, agent, minScore, asOf }) => {
      try {
        args.sessionTracker.recordActivity("memory.search", { query, scope, limit, source, agent, minScore, asOf });
        const results = await memorySearch(args.db, { query, scope, limit, source, agent, minScore, asOf });
        safeAppendSearchQueryLog(args.log, {
          tool: "memory.search",
          query,
          scope,
          asOf,
          timestamp: new Date().toISOString(),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return errorResponse(args.log, "memory.search", err);
      }
    }
  );

  server.tool(
    "memory.search_graph",
    "Experimental canonical-first graph-assisted search.",
    {
      query: z.string().describe("Search query"),
      scope: z.string().optional().describe("Project scope filter"),
      limit: z.number().optional().describe("Max results (default 10)"),
      asOf: z.string().optional().describe("Optional ISO timestamp for time-aware canonical search"),
      hopDepth: z.union([z.literal(1), z.literal(2)]).optional().describe("Graph expansion depth"),
    },
    async ({ query, scope, limit, asOf, hopDepth }) => {
      try {
        args.sessionTracker.recordActivity("memory.search_graph", { query, scope, limit, asOf, hopDepth });
        const results = await memorySearchGraph(args.db, { query, scope, limit, asOf, hopDepth });
        safeAppendSearchQueryLog(args.log, {
          tool: "memory.search_graph",
          query,
          scope,
          asOf,
          timestamp: new Date().toISOString(),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return errorResponse(args.log, "memory.search_graph", err);
      }
    }
  );

  server.tool(
    "memory.context",
    "Auto-load relevant memories based on current working directory. Detects project scope from cwd.",
    {
      cwd: z.string().optional().describe("Current working directory (auto-detected if omitted)"),
      limit: z.number().optional().describe("Max results (default 5)"),
      recent: z.boolean().optional().describe("Prioritize recent items (default true)"),
    },
    async ({ cwd, limit, recent }) => {
      try {
        args.sessionTracker.recordActivity("memory.context", { cwd, limit, recent });
        const result = memoryContext(args.db, { cwd, limit, recent });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResponse(args.log, "memory.context", err);
      }
    }
  );

  server.tool(
    "memory.summary",
    "Save a session summary. Call at session end to preserve context for future sessions.",
    {
      summary: z.string().describe("Session summary text"),
      sessionId: z.string().optional().describe("Session ID"),
      scope: z.string().optional().describe("Project scope"),
      tags: z.array(z.string()).optional().describe("Tags"),
      agent: z.string().optional().describe("Agent name (codex, claude-code, etc.)"),
    },
    async ({ summary, sessionId, scope, tags, agent }) => {
      try {
        args.sessionTracker.recordActivity("memory.summary", { summary, sessionId, scope, tags, agent });
        const result = await memorySummary(args.db, { summary, sessionId, scope, tags, agent });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResponse(args.log, "memory.summary", err);
      }
    }
  );

  server.tool(
    "memory.ingest",
    "Index a file or directory into the memory store. Use for initial setup or adding new sources.",
    {
      path: z.string().describe("File or directory path"),
      source: z.enum(["obsidian", "manual", "memory-md"]).optional().describe("Source type (default: manual)"),
      scope: z.string().optional().describe("Project scope"),
    },
    async ({ path: targetPath, source, scope }) => {
      try {
        args.sessionTracker.recordActivity("memory.ingest", { path: targetPath, source, scope });
        const result = await memoryIngest(args.db, { path: targetPath, source, scope });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResponse(args.log, "memory.ingest", err);
      }
    }
  );

  server.tool(
    "memory.prune",
    "Clean up old, low-access memories. Dry-run by default for safety.",
    {
      olderThanDays: z.number().optional().describe("Prune memories older than N days (default: 90)"),
      minAccessCount: z.number().optional().describe("Only prune if access count <= this (default: 0)"),
      scope: z.string().optional().describe("Scope filter"),
      dryRun: z.boolean().optional().describe("Preview only, don't delete (default: true)"),
    },
    async ({ olderThanDays, minAccessCount, scope, dryRun }) => {
      try {
        args.sessionTracker.recordActivity("memory.prune", { olderThanDays, minAccessCount, scope, dryRun });
        const result = memoryPrune(args.db, { olderThanDays, minAccessCount, scope, dryRun });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResponse(args.log, "memory.prune", err);
      }
    }
  );

  server.tool(
    "memory.stats",
    "View memory store statistics: totals, by scope, by source, DB size.",
    {},
    async () => {
      try {
        args.sessionTracker.recordActivity("memory.stats", {});
        const result = memoryStats(args.db, args.dbPath);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResponse(args.log, "memory.stats", err);
      }
    }
  );

  server.tool(
    "memory.graph",
    "Explore memory connections. Traverse wikilink/tag/scope/session relationships 1-3 hops.",
    {
      memoryId: z.string().optional().describe("Starting memory ID"),
      query: z.string().optional().describe("Or search query to find starting point"),
      hops: z.number().optional().describe("Traversal depth 1-3 (default: 2)"),
      linkType: z.enum(["wikilink", "tag", "scope", "session", "all"]).optional().describe("Link type filter (default: all)"),
      limit: z.number().optional().describe("Max connected results (default: 10)"),
    },
    async ({ memoryId, query, hops, linkType, limit }) => {
      try {
        args.sessionTracker.recordActivity("memory.graph", { memoryId, query, hops, linkType, limit });
        const result = await memoryGraph(args.db, { memoryId, query, hops, linkType, limit });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResponse(args.log, "memory.graph", err);
      }
    }
  );

  server.tool(
    "memory.restore",
    "Restore a soft-deleted memory. Re-embeds and re-inserts into all indexes.",
    {
      id: z.string().describe("Memory ID to restore"),
    },
    async ({ id }) => {
      try {
        args.sessionTracker.recordActivity("memory.restore", { id });
        const result = await memoryRestore(args.db, { id });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResponse(args.log, "memory.restore", err);
      }
    }
  );

  server.tool(
    "memory.promote",
    "Promote raw memories into canonical facts or decisions.",
    {
      memoryIds: z.array(z.string()).min(1).describe("Raw memory IDs to use as evidence"),
      kind: z.enum(["fact", "decision"]).describe("Canonical memory type"),
      title: z.string().describe("Short canonical title"),
      content: z.string().describe("Canonical memory statement"),
      scope: z.string().optional().describe("Project scope"),
      confidence: z.number().min(0).max(1).optional().describe("Confidence score (0-1)"),
      importance: z.number().min(0).max(1).optional().describe("Importance score (0-1)"),
      validFrom: z.string().optional().describe("Validity start time (ISO-8601)"),
      decidedAt: z.string().optional().describe("Decision timestamp (ISO-8601)"),
      supersedes: z.array(z.string()).optional().describe("Canonical memory IDs superseded by this one"),
      contradicts: z.array(z.string()).optional().describe("Canonical memory IDs contradicted by this one"),
    },
    async ({ memoryIds, kind, title, content, scope, confidence, importance, validFrom, decidedAt, supersedes, contradicts }) => {
      try {
        args.sessionTracker.recordActivity("memory.promote", { memoryIds, kind, title, content, scope, confidence, importance, validFrom, decidedAt, supersedes, contradicts });
        const result = await memoryPromote(args.db, {
          memoryIds,
          kind,
          title,
          content,
          scope,
          confidence,
          importance,
          validFrom,
          decidedAt,
          supersedes,
          contradicts,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResponse(args.log, "memory.promote", err);
      }
    }
  );

  server.tool(
    "memory.health",
    "Diagnose database integrity: orphaned records, model mismatches, broken links",
    {},
    async () => {
      try {
        args.sessionTracker.recordActivity("memory.health", {});
        const result = memoryHealth(args.db);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResponse(args.log, "memory.health", err);
      }
    }
  );

  return server;
}
