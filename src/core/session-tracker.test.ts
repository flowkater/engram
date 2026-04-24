/**
 * Tests for SessionTracker — automatic session tracking and summary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { SessionTracker, buildSummaryText, type SessionData } from "./session-tracker.js";
import path from "node:path";
import os from "node:os";

vi.mock("../core/embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-tracker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("SessionTracker", () => {
  let inst: DatabaseInstance;
  let tracker: SessionTracker;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    tracker?.stop();
    inst.close();
  });

  it("creates session on first recordActivity", () => {
    tracker = new SessionTracker(inst.db);
    expect(tracker.getSession()).toBeNull();

    tracker.recordActivity("memory.search", { query: "test query" });

    const session = tracker.getSession();
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBeTruthy();
    expect(session!.activities).toHaveLength(1);
    expect(session!.activities[0].tool).toBe("memory.search");
    expect(session!.activities[0].detail).toBe("test query");
  });

  it("tracks multiple activities and scope counts", () => {
    tracker = new SessionTracker(inst.db);

    tracker.recordActivity("memory.search", { query: "q1", scope: "project-a" });
    tracker.recordActivity("memory.add", { content: "some content", scope: "project-a" });
    tracker.recordActivity("memory.search", { query: "q2", scope: "project-b" });

    const session = tracker.getSession()!;
    expect(session.activities).toHaveLength(3);
    expect(session.scopeCounts["project-a"]).toBe(2);
    expect(session.scopeCounts["project-b"]).toBe(1);
  });

  it("keeps only last 20 activities", () => {
    tracker = new SessionTracker(inst.db);

    for (let i = 0; i < 25; i++) {
      tracker.recordActivity("memory.search", { query: `query-${i}` });
    }

    const session = tracker.getSession()!;
    expect(session.activities).toHaveLength(20);
    expect(session.activities[0].detail).toBe("query-5");
    expect(session.activities[19].detail).toBe("query-24");
  });

  it("detects agent from params", () => {
    tracker = new SessionTracker(inst.db);

    tracker.recordActivity("memory.search", { query: "test", agent: "claude-code" });

    expect(tracker.getSession()!.agent).toBe("claude-code");
  });

  it("auto-summarizes on idle timeout", async () => {
    vi.useFakeTimers();

    tracker = new SessionTracker(inst.db, {
      idleTimeoutMs: 1000,
      checkIntervalMs: 500,
    });

    tracker.recordActivity("memory.search", { query: "test query", scope: "my-project" });
    tracker.recordActivity("memory.add", { content: "saved data", scope: "my-project" });

    // Start idle checking
    tracker.start();

    // Advance past idle timeout + check interval
    vi.advanceTimersByTime(1500);

    // flush is async, so wait for it
    await vi.runAllTimersAsync();

    // Check that session was saved to DB
    const sessions = inst.db.prepare("SELECT * FROM sessions").all() as any[];
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    const memories = inst.db.prepare("SELECT * FROM memories WHERE source = 'session'").all() as any[];
    expect(memories.length).toBeGreaterThanOrEqual(1);
    expect(memories[0].content).toContain("[Auto]");

    vi.useRealTimers();
  });

  it("flushes on explicit call and saves to DB", async () => {
    tracker = new SessionTracker(inst.db);

    tracker.recordActivity("memory.search", { query: "important query", scope: "backend" });
    tracker.recordActivity("memory.add", { content: "decision recorded", scope: "backend" });

    await tracker.flush();

    const sessions = inst.db.prepare("SELECT * FROM sessions").all() as any[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agent).toBe(process.env.MCP_AGENT || process.env.USER || "unknown");

    const memories = inst.db.prepare("SELECT * FROM memories WHERE source = 'session'").all() as any[];
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toContain("backend");
  });

  it("does not summarize empty sessions", async () => {
    tracker = new SessionTracker(inst.db);

    await tracker.flush();

    const sessions = inst.db.prepare("SELECT * FROM sessions").all() as any[];
    expect(sessions).toHaveLength(0);
  });

  it("flush is idempotent (safe to call multiple times)", async () => {
    tracker = new SessionTracker(inst.db);

    tracker.recordActivity("memory.search", { query: "test" });

    await tracker.flush();
    await tracker.flush();
    await tracker.flush();

    const sessions = inst.db.prepare("SELECT * FROM sessions").all() as any[];
    expect(sessions).toHaveLength(1);
  });

  it("logs on auto-summary", async () => {
    const logs: string[] = [];
    tracker = new SessionTracker(inst.db, {
      log: (msg) => logs.push(msg),
    });

    tracker.recordActivity("memory.search", { query: "test" });
    await tracker.flush();

    expect(logs.some((l) => l.includes("auto-summarized"))).toBe(true);
  });
});

describe("buildSummaryText", () => {
  it("produces correct format", () => {
    const session: SessionData = {
      sessionId: "test-id",
      agent: "claude-code",
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      activities: [
        { tool: "memory.search", detail: "auth flow", timestamp: new Date().toISOString() },
        { tool: "memory.add", detail: "decided on JWT", timestamp: new Date().toISOString() },
        { tool: "memory.search", detail: "database schema", timestamp: new Date().toISOString() },
      ],
      scopeCounts: { "backend": 3 },
    };

    const text = buildSummaryText(session);

    expect(text).toContain("[Auto]");
    expect(text).toContain("claude-code");
    expect(text).toContain("backend");
    expect(text).toContain("2 searches");
    expect(text).toContain("1 saves");
    expect(text).toContain("auth flow");
    expect(text).toContain("decided on JWT");
  });

  it("handles session with no searches or saves", () => {
    const session: SessionData = {
      sessionId: "test-id",
      agent: "unknown",
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      activities: [
        { tool: "memory.stats", detail: "memory.stats", timestamp: new Date().toISOString() },
      ],
      scopeCounts: {},
    };

    const text = buildSummaryText(session);

    expect(text).toContain("[Auto]");
    expect(text).toContain("0 searches");
    expect(text).toContain("0 saves");
    expect(text).not.toContain("Searches:");
    expect(text).not.toContain("Saved:");
  });
});

describe("SessionTracker — interval gated on active sessions", () => {
  let inst: DatabaseInstance;
  let tracker: SessionTracker;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    tracker?.stop();
    inst.close();
  });

  it("does not hold a timer when no sessions are active", () => {
    tracker = new SessionTracker(inst.db, { log: () => {} });
    tracker.start();
    // With no active sessions, no interval should be running
    const handle = (tracker as unknown as { intervalHandle?: unknown }).intervalHandle;
    expect(handle == null).toBe(true);
  });

  it("starts interval when a session is tracked, stops when flushed", async () => {
    tracker = new SessionTracker(inst.db, { log: () => {} });
    tracker.start();

    // Before any activity: no interval
    expect(
      (tracker as unknown as { intervalHandle?: unknown }).intervalHandle == null
    ).toBe(true);

    // Record a session — this should spin up the interval
    tracker.recordActivity("memory.search", { query: "test" });

    expect(
      (tracker as unknown as { intervalHandle?: unknown }).intervalHandle != null
    ).toBe(true);

    // Once flushed, the interval should be cleared
    await tracker.flush();

    expect(
      (tracker as unknown as { intervalHandle?: unknown }).intervalHandle == null
    ).toBe(true);
  });

  it("does not start an interval if recordActivity fires before start()", () => {
    tracker = new SessionTracker(inst.db, { log: () => {} });
    // Record before start — should not create an interval until start() is called
    tracker.recordActivity("memory.search", { query: "early" });
    expect(
      (tracker as unknown as { intervalHandle?: unknown }).intervalHandle == null
    ).toBe(true);

    // Now start — interval should spin up since a session already exists
    tracker.start();
    expect(
      (tracker as unknown as { intervalHandle?: unknown }).intervalHandle != null
    ).toBe(true);
  });
});
