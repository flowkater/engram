/**
 * Tests for memory.prune tool.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { enqueueCanonicalCandidate } from "../core/canonical-candidates.js";
import { memoryPrune } from "./prune.js";
import { createCanonicalMemory } from "../core/canonical-memory.js";
import path from "node:path";
import os from "node:os";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-prune-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function insertOldMemory(db: any, id: string, daysAgo: number, accessCount: number = 0, scope: string = "global") {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const created = date.toISOString();
  db.prepare(
    "INSERT INTO memories (id, content, source, scope, tags, importance, access_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, `Content for ${id}`, "manual", scope, "[]", 0.5, accessCount, created, created);
}

describe("memory.prune", () => {
  let inst: DatabaseInstance;

  beforeEach(() => { inst = openDatabase(tmpDbPath()); });
  afterEach(() => { inst.close(); });

  it("dry run returns candidates without deleting", () => {
    insertOldMemory(inst.db, "old1", 100);
    insertOldMemory(inst.db, "new1", 10);

    const result = memoryPrune(inst.db, { olderThanDays: 90, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.candidates).toBe(1);
    expect(result.pruned).toBe(0);
    expect(result.items[0].id).toBe("old1");

    // Verify not deleted
    const row = inst.db.prepare("SELECT deleted FROM memories WHERE id = ?").get("old1") as { deleted: number };
    expect(row.deleted).toBe(0);
  });

  it("actually deletes when dryRun=false", () => {
    insertOldMemory(inst.db, "old2", 100);

    const result = memoryPrune(inst.db, { olderThanDays: 90, dryRun: false });
    expect(result.pruned).toBe(1);

    const row = inst.db.prepare("SELECT deleted FROM memories WHERE id = ?").get("old2") as { deleted: number };
    expect(row.deleted).toBe(1);
  });

  it("respects minAccessCount filter", () => {
    insertOldMemory(inst.db, "accessed", 100, 5);
    insertOldMemory(inst.db, "unaccessed", 100, 0);

    const result = memoryPrune(inst.db, { olderThanDays: 90, minAccessCount: 0 });
    expect(result.candidates).toBe(1);
    expect(result.items[0].id).toBe("unaccessed");
  });

  it("filters by scope", () => {
    insertOldMemory(inst.db, "backend-old", 100, 0, "todait-backend");
    insertOldMemory(inst.db, "ios-old", 100, 0, "todait-ios");

    const result = memoryPrune(inst.db, { olderThanDays: 90, scope: "todait-backend" });
    expect(result.candidates).toBe(1);
    expect(result.items[0].id).toBe("backend-old");
  });

  it("returns empty when no candidates", () => {
    insertOldMemory(inst.db, "recent", 5);

    const result = memoryPrune(inst.db, { olderThanDays: 90 });
    expect(result.candidates).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  it("does not prune raw memories referenced by active canonical memories", () => {
    insertOldMemory(inst.db, "protected-raw", 100, 0, "global");
    createCanonicalMemory(inst.db, {
      id: "canon-protected",
      kind: "fact",
      title: "Protected fact",
      content: "Protected fact content",
      scope: "global",
      evidenceMemoryIds: ["protected-raw"],
    });

    const result = memoryPrune(inst.db, { olderThanDays: 90, dryRun: false });
    expect(result.pruned).toBe(0);

    const row = inst.db.prepare("SELECT deleted FROM memories WHERE id = ?").get("protected-raw") as { deleted: number };
    expect(row.deleted).toBe(0);
  });

  it("removes canonical candidates for pruned raw memories", () => {
    insertOldMemory(inst.db, "candidate-raw", 100, 0, "global");
    enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: "candidate-raw",
      scope: "global",
      candidateKind: "fact",
      candidateTitle: "Prunable candidate",
      candidateContent: "Prunable candidate content",
      priorityScore: 0.5,
      contentFingerprint: "fp-prunable",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    const result = memoryPrune(inst.db, { olderThanDays: 90, dryRun: false });
    expect(result.pruned).toBe(1);

    const candidateRows = inst.db.prepare(
      "SELECT COUNT(*) as count FROM canonical_candidates WHERE raw_memory_id = ?"
    ).get("candidate-raw") as { count: number };

    expect(candidateRows.count).toBe(0);
  });
});
