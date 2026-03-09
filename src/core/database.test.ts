/**
 * Tests for database initialization and basic operations.
 */
import { describe, it, expect, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `unified-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("database", () => {
  const dbs: DatabaseInstance[] = [];

  function open(p?: string) {
    const inst = openDatabase(p || tmpDbPath());
    dbs.push(inst);
    return inst;
  }

  afterEach(() => {
    for (const inst of dbs) {
      try { inst.close(); } catch {}
    }
    dbs.length = 0;
  });

  it("creates all tables", () => {
    const { db } = open();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("memories");
    expect(names).toContain("memory_vec");
    expect(names).toContain("memory_fts");
    expect(names).toContain("memory_links");
    expect(names).toContain("sessions");
  });

  it("uses WAL mode", () => {
    const { db } = open();
    const mode = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    expect(mode[0].journal_mode).toBe("wal");
  });

  it("sqlite-vec is loaded", () => {
    const { db } = open();
    const ver = db.prepare("SELECT vec_version() as v").get() as { v: string };
    expect(ver.v).toMatch(/^v\d/);
  });

  it("can insert and query vector", () => {
    const { db } = open();
    const vec = new Float32Array(768);
    vec[0] = 1.0;

    db.prepare("INSERT INTO memory_vec (id, embedding) VALUES (?, ?)").run(
      "test-1",
      Buffer.from(vec.buffer)
    );

    const results = db
      .prepare("SELECT id, distance FROM memory_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1")
      .all(Buffer.from(vec.buffer)) as Array<{ id: string; distance: number }>;

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("test-1");
    expect(results[0].distance).toBe(0);
  });

  it("can insert and query FTS5", () => {
    const { db } = open();
    db.prepare(
      "INSERT INTO memory_fts (id, content, summary, tags, scope) VALUES (?, ?, ?, ?, ?)"
    ).run("test-1", "redistribution policy for task handling", "", "[]", "global");

    const results = db
      .prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH ?")
      .all('"redistribution"') as Array<{ id: string }>;

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("test-1");
  });

  it("soft-deletes records with relative source_path on open", () => {
    const p = tmpDbPath();
    // First open to create schema
    const inst1 = openDatabase(p);

    // Insert records with relative paths (legacy Phase 0 data)
    const now = new Date().toISOString();
    inst1.db.prepare(
      "INSERT INTO memories (id, content, source, source_path, source_hash, scope, tags, importance, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("rel-1", "relative path record", "obsidian", "notes/test.md", "hash1", "global", "[]", 0.5, now, now, 0);
    inst1.db.prepare(
      "INSERT INTO memories (id, content, source, source_path, source_hash, scope, tags, importance, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("abs-1", "absolute path record", "obsidian", "/Users/test/notes/test.md", "hash2", "global", "[]", 0.5, now, now, 0);
    inst1.close();

    // Re-open — migration should soft-delete relative path records
    const inst2 = openDatabase(p);
    dbs.push(inst2);

    const relRow = inst2.db.prepare("SELECT deleted FROM memories WHERE id = ?").get("rel-1") as { deleted: number };
    expect(relRow.deleted).toBe(1);

    const absRow = inst2.db.prepare("SELECT deleted FROM memories WHERE id = ?").get("abs-1") as { deleted: number };
    expect(absRow.deleted).toBe(0);
  });

  it("new DB has embed_model column in CREATE TABLE", () => {
    const { db } = open();
    const cols = db.pragma("table_info(memories)") as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("embed_model");
  });

  it("is idempotent (open twice same db)", () => {
    const p = tmpDbPath();
    const inst1 = openDatabase(p);
    inst1.close();
    const inst2 = openDatabase(p);
    dbs.push(inst2);

    const tables = inst2.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .get();
    expect(tables).toBeTruthy();
  });
});
