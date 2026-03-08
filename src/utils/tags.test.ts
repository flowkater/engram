/**
 * Tests for tag normalization utilities and memory_tags table.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { parseTags, insertTags, deleteTags, deleteTagsBatch } from "./tags.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `unified-memory-tags-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

describe("parseTags", () => {
  it("parses string array", () => {
    expect(parseTags(["TypeScript", "MCP"])).toEqual(["typescript", "mcp"]);
  });

  it("parses JSON string", () => {
    expect(parseTags('["Foo", "Bar"]')).toEqual(["foo", "bar"]);
  });

  it("deduplicates and trims", () => {
    expect(parseTags(["a", " A ", "b", "a"])).toEqual(["a", "b"]);
  });

  it("returns empty for null/undefined", () => {
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
  });
});

describe("memory_tags table operations", () => {
  let dbInstance: DatabaseInstance;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    dbInstance = openDatabase(dbPath);
    // Insert a dummy memory
    dbInstance.db.prepare(
      "INSERT INTO memories (id, content, source, scope, tags, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("mem-1", "test", "manual", "global", "[]", 0.5, new Date().toISOString(), new Date().toISOString());
    dbInstance.db.prepare(
      "INSERT INTO memories (id, content, source, scope, tags, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("mem-2", "test2", "manual", "global", "[]", 0.5, new Date().toISOString(), new Date().toISOString());
  });

  afterEach(() => {
    dbInstance.close();
    try { fs.unlinkSync(dbPath); } catch {}
  });

  it("insertTags writes to memory_tags", () => {
    insertTags(dbInstance.db, "mem-1", ["typescript", "mcp"]);
    const rows = dbInstance.db.prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag").all("mem-1") as Array<{ tag: string }>;
    expect(rows.map(r => r.tag)).toEqual(["mcp", "typescript"]);
  });

  it("deleteTags removes tags for a memory", () => {
    insertTags(dbInstance.db, "mem-1", ["a", "b"]);
    deleteTags(dbInstance.db, "mem-1");
    const rows = dbInstance.db.prepare("SELECT COUNT(*) as c FROM memory_tags WHERE memory_id = ?").get("mem-1") as { c: number };
    expect(rows.c).toBe(0);
  });

  it("deleteTagsBatch removes tags for multiple memories", () => {
    insertTags(dbInstance.db, "mem-1", ["a"]);
    insertTags(dbInstance.db, "mem-2", ["b"]);
    deleteTagsBatch(dbInstance.db, ["mem-1", "mem-2"]);
    const rows = dbInstance.db.prepare("SELECT COUNT(*) as c FROM memory_tags").get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it("insertTags is idempotent (INSERT OR IGNORE)", () => {
    insertTags(dbInstance.db, "mem-1", ["x"]);
    insertTags(dbInstance.db, "mem-1", ["x"]);
    const rows = dbInstance.db.prepare("SELECT COUNT(*) as c FROM memory_tags WHERE memory_id = ?").get("mem-1") as { c: number };
    expect(rows.c).toBe(1);
  });
});
