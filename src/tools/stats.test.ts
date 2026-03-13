/**
 * Tests for memory.stats tool.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { createCanonicalMemory } from "../core/canonical-memory.js";
import { memoryStats } from "./stats.js";
import path from "node:path";
import os from "node:os";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-stats-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("memory.stats", () => {
  let inst: DatabaseInstance;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    inst = openDatabase(dbPath);
  });
  afterEach(() => { inst.close(); });

  it("returns correct totals", () => {
    const now = new Date().toISOString();
    inst.db.prepare(
      "INSERT INTO memories (id, content, source, scope, tags, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("s1", "content1", "obsidian", "todait-backend", "[]", 0.5, now, now);
    inst.db.prepare(
      "INSERT INTO memories (id, content, source, scope, tags, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("s2", "content2", "manual", "global", "[]", 0.5, now, now);
    inst.db.prepare(
      "INSERT INTO memories (id, content, source, scope, tags, importance, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)"
    ).run("s3", "deleted", "manual", "global", "[]", 0.5, now, now);

    const stats = memoryStats(inst.db, dbPath);
    expect(stats.total).toBe(2);
    expect(stats.deleted).toBe(1);
    expect(stats.byScope["todait-backend"]).toBe(1);
    expect(stats.byScope["global"]).toBe(1);
    expect(stats.bySource["obsidian"]).toBe(1);
    expect(stats.bySource["manual"]).toBe(1);
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
  });

  it("returns null timestamps when empty", () => {
    const stats = memoryStats(inst.db);
    expect(stats.total).toBe(0);
    expect(stats.lastIndexed).toBeNull();
    expect(stats.oldestMemory).toBeNull();
  });

  it("counts sessions", () => {
    const now = new Date().toISOString();
    inst.db.prepare(
      "INSERT INTO sessions (id, agent, started_at) VALUES (?, ?, ?)"
    ).run("sess1", "codex", now);
    inst.db.prepare(
      "INSERT INTO sessions (id, agent, started_at) VALUES (?, ?, ?)"
    ).run("sess2", "claude-code", now);

    const stats = memoryStats(inst.db);
    expect(stats.totalSessions).toBe(2);
  });

  it("includes canonical memory counts", () => {
    createCanonicalMemory(inst.db, {
      id: "canon-1",
      kind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "global",
      evidenceMemoryIds: [],
    });

    const stats = memoryStats(inst.db);
    expect(stats.totalCanonical).toBe(1);
    expect(stats.byCanonicalKind["fact"]).toBe(1);
  });
});
