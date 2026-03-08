/**
 * Tests for memory.health diagnostics tool.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryHealth } from "./health.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `unified-memory-health-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

function insertFullMemory(db: import("better-sqlite3").Database, id: string, opts?: { deleted?: number; embedModel?: string; tags?: string[] }) {
  const now = new Date().toISOString();
  const deleted = opts?.deleted ?? 0;
  const model = opts?.embedModel ?? "test-model";
  db.prepare(
    "INSERT INTO memories (id, content, source, scope, tags, importance, created_at, updated_at, deleted, embed_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, "content", "manual", "global", "[]", 0.5, now, now, deleted, model);

  if (!deleted) {
    const vec = new Float32Array(768);
    vec[0] = 1.0;
    db.prepare("INSERT INTO memory_vec (id, embedding) VALUES (?, ?)").run(id, Buffer.from(vec.buffer));
    db.prepare("INSERT INTO memory_fts (id, content, summary, tags, scope) VALUES (?, ?, ?, ?, ?)").run(id, "content", "", "[]", "global");
  }

  if (opts?.tags) {
    const stmt = db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)");
    for (const t of opts.tags) stmt.run(id, t);
  }
}

describe("memory.health", () => {
  let dbInstance: DatabaseInstance;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    dbInstance = openDatabase(dbPath);
  });

  afterEach(() => {
    dbInstance.close();
    try { fs.unlinkSync(dbPath); } catch {}
  });

  it("reports healthy for consistent database", () => {
    insertFullMemory(dbInstance.db, "m1");
    insertFullMemory(dbInstance.db, "m2");
    const result = memoryHealth(dbInstance.db);
    expect(result.healthy).toBe(true);
    expect(result.orphanedMemories).toBe(0);
    expect(result.orphanedVectors).toBe(0);
    expect(result.orphanedFts).toBe(0);
    expect(result.orphanedTags).toBe(0);
    expect(result.brokenLinks).toBe(0);
    expect(result.totalMemories).toBe(2);
  });

  it("detects orphaned records", () => {
    insertFullMemory(dbInstance.db, "m1");
    // Create orphaned vector (no corresponding active memory)
    const vec = new Float32Array(768);
    vec[0] = 0.5;
    dbInstance.db.prepare("INSERT INTO memory_vec (id, embedding) VALUES (?, ?)").run("orphan-vec", Buffer.from(vec.buffer));
    // Create orphaned FTS
    dbInstance.db.prepare("INSERT INTO memory_fts (id, content, summary, tags, scope) VALUES (?, ?, ?, ?, ?)").run("orphan-fts", "x", "", "[]", "global");
    // Create orphaned tag (insert a deleted memory first to satisfy FK, then add tag)
    const now2 = new Date().toISOString();
    dbInstance.db.prepare(
      "INSERT INTO memories (id, content, source, scope, tags, importance, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("deleted-mem", "deleted", "manual", "global", "[]", 0.5, now2, now2, 1);
    dbInstance.db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run("deleted-mem", "test");

    const result = memoryHealth(dbInstance.db);
    expect(result.healthy).toBe(false);
    expect(result.orphanedVectors).toBe(1);
    expect(result.orphanedFts).toBe(1);
    expect(result.orphanedTags).toBe(1);
  });

  it("detects model mismatch", () => {
    insertFullMemory(dbInstance.db, "m1", { embedModel: "model-a" });
    insertFullMemory(dbInstance.db, "m2", { embedModel: "model-b" });
    const result = memoryHealth(dbInstance.db);
    expect(Object.keys(result.modelMismatch).length).toBe(2);
    expect(result.modelMismatch["model-a"]).toBe(1);
    expect(result.modelMismatch["model-b"]).toBe(1);
  });
});
