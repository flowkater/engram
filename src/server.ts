#!/usr/bin/env node
/**
 * Unified Memory MCP Server — stdio transport entry point.
 * Registers all 8 memory tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { openDatabase } from "./core/database.js";
import { getCurrentModelName } from "./core/embedder.js";
import { memoryAdd } from "./tools/add.js";
import { memorySearch } from "./tools/search.js";
import { memoryContext } from "./tools/context.js";
import { memorySummary } from "./tools/summary.js";
import { memoryIngest } from "./tools/ingest.js";
import { memoryPrune } from "./tools/prune.js";
import { memoryStats } from "./tools/stats.js";
import { memoryGraph } from "./tools/graph.js";
import { startWatcher } from "./core/watcher.js";
import { startScheduler } from "./core/scheduler.js";
import { SessionTracker } from "./core/session-tracker.js";

const DB_PATH = process.env.MEMORY_DB ||
  path.join(process.env.HOME || "~", ".unified-memory", "memory.db");
const VAULT_PATH = process.env.VAULT_PATH ||
  path.join(process.env.HOME || "~", "Obsidian", "flowkater", "flowkater");

// Ensure logs directory exists
const LOG_DIR = path.join(process.env.HOME || "~", ".unified-memory", "logs");
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Log to stderr and file.
 */
function log(message: string) {
  const line = `[unified-memory] ${message}`;
  console.error(line);
  try {
    const logFile = path.join(LOG_DIR, `server-${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

// Open database with error handling
let dbInstance: ReturnType<typeof openDatabase>;
try {
  dbInstance = openDatabase(DB_PATH);
} catch (err) {
  log(`Fatal: Failed to open database at ${DB_PATH}: ${(err as Error).message}`);
  process.exit(1);
}
const db = dbInstance.db;

// Check for embedding model mismatch
{
  const currentModel = getCurrentModelName();
  const existing = db.prepare(
    "SELECT DISTINCT embed_model FROM memories WHERE embed_model IS NOT NULL AND deleted = 0 LIMIT 10"
  ).all() as Array<{ embed_model: string }>;
  const mismatched = existing.filter((r) => r.embed_model !== currentModel);
  if (mismatched.length > 0) {
    const models = mismatched.map((r) => r.embed_model).join(", ");
    log(`⚠️  Embedding model mismatch detected! Current: ${currentModel}, existing records use: ${models}. Consider re-indexing for consistent similarity search.`);
  }
}

const server = new McpServer({
  name: "unified-memory",
  version: "0.1.0",
});

const sessionTracker = new SessionTracker(db, { log });

/**
 * Helper for tool error responses.
 */
function errorResponse(toolName: string, err: unknown) {
  const msg = (err as Error).message;
  log(`${toolName} error: ${msg}`);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

// --- memory.add ---
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
      sessionTracker.recordActivity("memory.add", { content, scope, tags, importance, summary });
      const result = await memoryAdd(db, { content, scope, tags, importance, summary });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse("memory.add", err);
    }
  }
);

// --- memory.search ---
server.tool(
  "memory.search",
  "Semantic + keyword hybrid search across all memories.",
  {
    query: z.string().describe("Search query"),
    scope: z.string().optional().describe("Project scope filter"),
    limit: z.number().optional().describe("Max results (default 10)"),
    source: z.enum(["obsidian", "session", "manual", "notion", "memory-md"]).optional().describe("Source filter"),
    agent: z.string().optional().describe("Agent filter"),
    minScore: z.number().optional().describe("Minimum relevance score (0-1)"),
  },
  async ({ query, scope, limit, source, agent, minScore }) => {
    try {
      sessionTracker.recordActivity("memory.search", { query, scope, limit, source, agent, minScore });
      const results = await memorySearch(db, { query, scope, limit, source, agent, minScore });
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return errorResponse("memory.search", err);
    }
  }
);

// --- memory.context ---
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
      sessionTracker.recordActivity("memory.context", { cwd, limit, recent });
      const result = memoryContext(db, { cwd, limit, recent });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse("memory.context", err);
    }
  }
);

// --- memory.summary ---
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
      sessionTracker.recordActivity("memory.summary", { summary, sessionId, scope, tags, agent });
      const result = await memorySummary(db, { summary, sessionId, scope, tags, agent });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse("memory.summary", err);
    }
  }
);

// --- memory.ingest ---
server.tool(
  "memory.ingest",
  "Index a file or directory into the memory store. Use for initial setup or adding new sources.",
  {
    path: z.string().describe("File or directory path"),
    source: z.enum(["obsidian", "manual", "memory-md"]).optional().describe("Source type (default: manual)"),
    scope: z.string().optional().describe("Project scope"),
    recursive: z.boolean().optional().describe("Recurse into subdirectories (default: true)"),
  },
  async ({ path: targetPath, source, scope, recursive }) => {
    try {
      sessionTracker.recordActivity("memory.ingest", { path: targetPath, source, scope, recursive });
      const result = await memoryIngest(db, { path: targetPath, source, scope, recursive });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse("memory.ingest", err);
    }
  }
);

// --- memory.prune ---
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
      sessionTracker.recordActivity("memory.prune", { olderThanDays, minAccessCount, scope, dryRun });
      const result = memoryPrune(db, { olderThanDays, minAccessCount, scope, dryRun });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse("memory.prune", err);
    }
  }
);

// --- memory.stats ---
server.tool(
  "memory.stats",
  "View memory store statistics: totals, by scope, by source, DB size.",
  {},
  async () => {
    try {
      sessionTracker.recordActivity("memory.stats", {});
      const result = memoryStats(db, DB_PATH);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse("memory.stats", err);
    }
  }
);

// --- memory.graph ---
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
      sessionTracker.recordActivity("memory.graph", { memoryId, query, hops, linkType, limit });
      const result = await memoryGraph(db, { memoryId, query, hops, linkType, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return errorResponse("memory.graph", err);
    }
  }
);

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server started (stdio)");

  // Start session tracker
  sessionTracker.start();

  // Track resources for unified shutdown
  let watcher: Awaited<ReturnType<typeof startWatcher>> | null = null;
  let scheduler: ReturnType<typeof startScheduler> | null = null;

  // Start file watcher if vault exists
  if (fs.existsSync(VAULT_PATH)) {
    try {
      watcher = startWatcher(db, {
        vaultPath: VAULT_PATH,
        onIndexed: (file, chunks) => log(`Indexed ${file} (${chunks} chunks)`),
        onDeleted: (file) => log(`Soft-deleted ${file}`),
        onError: (err) => log(`Watcher error: ${err.message}`),
      });
      log(`Watching vault: ${VAULT_PATH}`);
    } catch (err) {
      log(`Warning: Could not start watcher: ${(err as Error).message}`);
    }
  } else {
    log(`Vault not found at ${VAULT_PATH}, skipping watcher`);
  }

  // Start scheduler
  try {
    scheduler = startScheduler(db, {
      onLog: (msg) => log(msg),
    });
  } catch (err) {
    log(`Warning: Could not start scheduler: ${(err as Error).message}`);
  }

  // Unified shutdown handler
  let shutdownOnce = false;
  async function shutdown(signal: string) {
    if (shutdownOnce) return;
    shutdownOnce = true;
    log(`Received ${signal}, shutting down...`);
    try { await sessionTracker.flush(); } catch (e) { log(`sessionTracker.flush error: ${(e as Error).message}`); }
    try { if (watcher) await watcher.close(); } catch (e) { log(`watcher.close error: ${(e as Error).message}`); }
    try { if (scheduler) scheduler.stop(); } catch (e) { log(`scheduler.stop error: ${(e as Error).message}`); }
    try { dbInstance.close(); } catch (e) { log(`db.close error: ${(e as Error).message}`); }
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
