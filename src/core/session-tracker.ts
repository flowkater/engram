/**
 * Session Tracker — Automatically tracks MCP tool usage and generates
 * session summaries on session end (idle timeout or stdin close).
 */
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { memorySummary } from "../tools/summary.js";

export interface Activity {
  tool: string;
  detail: string;
  timestamp: string;
}

export interface SessionData {
  sessionId: string;
  agent: string;
  startedAt: string;
  lastActivityAt: string;
  activities: Activity[];
  scopeCounts: Record<string, number>;
}

export interface SessionTrackerOptions {
  /** Idle timeout in ms before auto-summary (default: 5 minutes) */
  idleTimeoutMs?: number;
  /** Check interval in ms (default: 30 seconds) */
  checkIntervalMs?: number;
  /** Logger function */
  log?: (message: string) => void;
}

const MAX_ACTIVITIES = 20;
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const DEFAULT_CHECK_INTERVAL = 30 * 1000; // 30 seconds

export class SessionTracker {
  private session: SessionData | null = null;
  private db: Database.Database;
  private idleTimeoutMs: number;
  private checkIntervalMs: number;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private flushed = false;
  private log: (message: string) => void;

  constructor(db: Database.Database, opts?: SessionTrackerOptions) {
    this.db = db;
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT;
    this.checkIntervalMs = opts?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL;
    this.log = opts?.log ?? (() => {});
  }

  /** Start idle-check interval and register stdin close handler. */
  start(): void {
    // Method A: Idle timeout check
    this.intervalHandle = setInterval(() => {
      this.checkIdle();
    }, this.checkIntervalMs);
    this.intervalHandle.unref();

    // Method B: stdin close (primary for stdio transport)
    process.stdin.on("end", () => {
      void this.flush();
    });
    process.stdin.on("close", () => {
      void this.flush();
    });
  }

  /** Record a tool invocation. Creates session on first call. */
  recordActivity(tool: string, params: Record<string, unknown>): void {
    const now = new Date().toISOString();

    if (!this.session) {
      this.session = {
        sessionId: uuidv7(),
        agent: process.env.MCP_AGENT || process.env.USER || "unknown",
        startedAt: now,
        lastActivityAt: now,
        activities: [],
        scopeCounts: {},
      };
    }

    this.session.lastActivityAt = now;

    // Extract a short detail from params
    const detail = extractDetail(tool, params);

    this.session.activities.push({ tool, detail, timestamp: now });

    // Keep only recent activities
    if (this.session.activities.length > MAX_ACTIVITIES) {
      this.session.activities = this.session.activities.slice(-MAX_ACTIVITIES);
    }

    // Track scope usage
    const scope = (params.scope as string) || (params.cwd as string) || undefined;
    if (scope) {
      this.session.scopeCounts[scope] = (this.session.scopeCounts[scope] || 0) + 1;
    }

    // Detect agent from params
    if (params.agent && typeof params.agent === "string") {
      this.session.agent = params.agent;
    }
  }

  /** Check if session is idle and auto-summarize if so. */
  private checkIdle(): void {
    if (!this.session || this.flushed) return;

    const elapsed = Date.now() - new Date(this.session.lastActivityAt).getTime();
    if (elapsed >= this.idleTimeoutMs) {
      this.flush();
    }
  }

  /** Force flush: generate summary and save. Safe to call multiple times. */
  async flush(): Promise<void> {
    if (this.flushed || !this.session) return;
    if (this.session.activities.length < 1) return;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    try {
      const summary = buildSummaryText(this.session);
      const scope = getMostUsedScope(this.session.scopeCounts);
      const duration = formatDuration(
        new Date(this.session.startedAt).getTime(),
        new Date(this.session.lastActivityAt).getTime()
      );

      await memorySummary(this.db, {
        summary,
        sessionId: this.session.sessionId,
        scope,
        agent: this.session.agent,
        tags: ["auto-summary", "session"],
      });

      this.flushed = true;
      this.log(
        `Session ${this.session.sessionId} auto-summarized after ${duration}`
      );
    } catch (err) {
      this.log(
        `Session auto-summary failed: ${(err as Error).message}`
      );
      // Dump session data to local file for recovery
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const logsDir = path.join(
          process.env.HOME || "~",
          ".unified-memory",
          "logs"
        );
        fs.mkdirSync(logsDir, { recursive: true });
        const dumpPath = path.join(
          logsDir,
          `session-dump-${Date.now()}.json`
        );
        fs.writeFileSync(dumpPath, JSON.stringify(this.session, null, 2));
        this.log(`Session data dumped to ${dumpPath}`);
      } catch (dumpErr) {
        this.log(
          `Session dump also failed: ${(dumpErr as Error).message}`
        );
      }
      // Mark flushed to prevent retry loops
      this.flushed = true;
    }
  }

  /** Expose session for testing. */
  getSession(): SessionData | null {
    return this.session;
  }

  /** Stop the tracker without flushing. For cleanup in tests. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}

/** Extract a short detail string from tool params. */
function extractDetail(tool: string, params: Record<string, unknown>): string {
  if (params.query && typeof params.query === "string") {
    return truncate(params.query, 80);
  }
  if (params.content && typeof params.content === "string") {
    return truncate(params.content, 80);
  }
  if (params.summary && typeof params.summary === "string") {
    return truncate(params.summary, 80);
  }
  if (params.path && typeof params.path === "string") {
    return truncate(params.path, 80);
  }
  if (params.cwd && typeof params.cwd === "string") {
    return truncate(params.cwd, 80);
  }
  return tool;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/** Build a structured summary from session activities. */
export function buildSummaryText(session: SessionData): string {
  const toolCounts: Record<string, number> = {};
  const searchQueries: string[] = [];
  const addContents: string[] = [];

  for (const act of session.activities) {
    toolCounts[act.tool] = (toolCounts[act.tool] || 0) + 1;

    if (act.tool === "memory.search" || act.tool === "memory.context") {
      searchQueries.push(act.detail);
    }
    if (act.tool === "memory.add" || act.tool === "memory.ingest") {
      addContents.push(act.detail);
    }
  }

  const scope = getMostUsedScope(session.scopeCounts) || "global";
  const searchCount = (toolCounts["memory.search"] || 0) + (toolCounts["memory.context"] || 0);
  const addCount = (toolCounts["memory.add"] || 0) + (toolCounts["memory.ingest"] || 0);

  const parts: string[] = [];
  const agentLabel = session.agent === "unknown" ? "unnamed-agent" : session.agent;
  parts.push(
    `[Auto] ${agentLabel} session in scope '${scope}'.`
  );
  parts.push(
    `${searchCount} searches, ${addCount} saves, ${session.activities.length} total actions.`
  );

  if (searchQueries.length > 0) {
    const topQueries = searchQueries.slice(-3).join("; ");
    parts.push(`Searches: ${topQueries}.`);
  }

  if (addContents.length > 0) {
    const topContents = addContents.slice(-3).join("; ");
    parts.push(`Saved: ${topContents}.`);
  }

  // Extract unique keywords from all activities for better retrieval
  const keywords = new Set<string>();
  for (const act of session.activities) {
    const words = act.detail.split(/\s+/).filter((w) => w.length > 2);
    for (const w of words.slice(0, 5)) keywords.add(w.toLowerCase());
  }
  if (keywords.size > 0) {
    parts.push(`Keywords: ${[...keywords].slice(0, 10).join(", ")}.`);
  }

  return parts.join(" ");
}

function getMostUsedScope(counts: Record<string, number>): string {
  let best = "global";
  let max = 0;
  for (const [scope, count] of Object.entries(counts)) {
    if (count > max) {
      max = count;
      best = scope;
    }
  }
  return best;
}

function formatDuration(startMs: number, endMs: number): string {
  const diffSec = Math.round((endMs - startMs) / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const min = Math.floor(diffSec / 60);
  const sec = diffSec % 60;
  return sec > 0 ? `${min}m${sec}s` : `${min}m`;
}
