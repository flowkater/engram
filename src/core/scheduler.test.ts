/**
 * Tests for cron scheduler.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { startScheduler } from "./scheduler.js";
import { createCanonicalMemory } from "./canonical-memory.js";
import path from "node:path";
import os from "node:os";

vi.mock("./embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-sched-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function insertOldMemory(db: DatabaseInstance["db"], id: string, daysOld: number): void {
  const createdAt = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO memories (id, content, source, scope, tags, importance, created_at, updated_at, access_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, `Old memory ${id}`, "manual", "global", "[]", 0.4, createdAt, createdAt, 0);
}

describe("scheduler", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });
  afterEach(() => {
    inst.close();
  });

  it("starts and stops without error", () => {
    const logs: string[] = [];
    const scheduler = startScheduler(inst.db, {
      onLog: (msg) => logs.push(msg),
    });

    expect(scheduler.tasks).toHaveLength(4);
    expect(logs.some((l) => l.includes("Scheduler started"))).toBe(true);

    scheduler.stop();
    expect(logs.some((l) => l.includes("Scheduler stopped"))).toBe(true);
  });

  it("creates four scheduled tasks (reindex, prune, log-rotate, backup)", () => {
    const scheduler = startScheduler(inst.db, {
      onLog: () => {},
    });

    expect(scheduler.tasks).toHaveLength(4);

    scheduler.stop();
  });

  it("weekly prune keeps raw evidence referenced by active canonical memories", () => {
    insertOldMemory(inst.db, "protected-raw", 200);
    createCanonicalMemory(inst.db, {
      id: "canon-protected",
      kind: "fact",
      title: "Protected memory",
      content: "Protected memory",
      scope: "global",
      evidenceMemoryIds: ["protected-raw"],
    });

    const scheduler = startScheduler(inst.db, {
      onLog: () => {},
    });

    (scheduler.tasks[1] as { now(): void }).now();

    const row = inst.db.prepare("SELECT deleted FROM memories WHERE id = ?").get("protected-raw") as { deleted: number };
    expect(row.deleted).toBe(0);

    scheduler.stop();
  });
});
