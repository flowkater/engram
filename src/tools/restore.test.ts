/**
 * Tests for memory.restore tool.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryRestore } from "./restore.js";
import path from "node:path";
import os from "node:os";

// Mock embedder
vi.mock("../core/embedder.js", () => {
  function fakeEmbed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(768);
    for (let i = 0; i < Math.min(text.length, 768); i++) {
      vec[i] = text.charCodeAt(i) / 256;
    }
    let norm = 0;
    for (let i = 0; i < 768; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < 768; i++) vec[i] /= norm;
    return Promise.resolve(vec);
  }
  return { embed: fakeEmbed, EMBEDDING_DIM: 768, getCurrentModelName: () => "test-model" };
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-restore-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("memory.restore", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("restores a soft-deleted memory", async () => {
    const now = new Date().toISOString();
    inst.db.prepare(
      "INSERT INTO memories (id, content, source, source_path, source_hash, scope, tags, importance, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("restore-1", "important content", "manual", null, null, "global", '["test"]', 0.5, now, now, 1);

    const result = await memoryRestore(inst.db, { id: "restore-1" });

    expect(result.restored).toBe(true);

    // Verify memory is active
    const mem = inst.db.prepare("SELECT deleted FROM memories WHERE id = ?").get("restore-1") as { deleted: number };
    expect(mem.deleted).toBe(0);

    // Verify vec inserted
    const vec = inst.db.prepare("SELECT id FROM memory_vec WHERE id = ?").get("restore-1");
    expect(vec).toBeDefined();

    // Verify FTS inserted
    const fts = inst.db.prepare("SELECT id FROM memory_fts WHERE id = ?").get("restore-1");
    expect(fts).toBeDefined();

    // Verify tags inserted
    const tags = inst.db.prepare("SELECT tag FROM memory_tags WHERE memory_id = ?").all("restore-1") as Array<{ tag: string }>;
    expect(tags.length).toBe(1);
    expect(tags[0].tag).toBe("test");
  });

  it("throws error for already active memory", async () => {
    const now = new Date().toISOString();
    inst.db.prepare(
      "INSERT INTO memories (id, content, source, source_path, source_hash, scope, tags, importance, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("active-1", "active content", "manual", null, null, "global", "[]", 0.5, now, now, 0);

    await expect(memoryRestore(inst.db, { id: "active-1" })).rejects.toThrow("already active");
  });

  it("throws error for non-existent memory", async () => {
    await expect(memoryRestore(inst.db, { id: "nonexistent-id" })).rejects.toThrow("not found");
  });
});
