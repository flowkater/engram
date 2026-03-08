/**
 * Tests for memory.ingest — source_path normalization.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryIngest } from "./ingest.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
vi.mock("../core/embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `um-ingest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-ingest-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("memory.ingest source_path normalization", () => {
  let inst: DatabaseInstance;
  let dir: string;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
    dir = tmpDir();
  });

  afterEach(() => {
    inst.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("single file ingest stores path beyond just basename", async () => {
    // Create a nested file
    const subDir = path.join(dir, "sub");
    fs.mkdirSync(subDir);
    const filePath = path.join(subDir, "note.md");
    fs.writeFileSync(filePath, "# Test\nSome content here for embedding.");

    await memoryIngest(inst.db, { path: filePath });

    const rows = inst.db.prepare("SELECT source_path FROM memories WHERE deleted = 0").all() as Array<{ source_path: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // source_path should NOT be just "note.md" (basename only)
    // It should include the full absolute path for single file ingest
    for (const row of rows) {
      expect(row.source_path).not.toBe("note.md");
      expect(row.source_path).toContain("note.md");
    }

    // Verify embed_model is stored
    const emRow = inst.db.prepare("SELECT embed_model FROM memories WHERE deleted = 0 LIMIT 1").get() as any;
    expect(emRow.embed_model).toBe("test-model");
  });

  it("two files with same basename in different dirs stored as distinct source_paths", async () => {
    // Create two dirs with same filename
    const dirA = path.join(dir, "projA");
    const dirB = path.join(dir, "projB");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    fs.writeFileSync(path.join(dirA, "README.md"), "# Project A\nContent A");
    fs.writeFileSync(path.join(dirB, "README.md"), "# Project B\nContent B");

    await memoryIngest(inst.db, { path: path.join(dirA, "README.md") });
    await memoryIngest(inst.db, { path: path.join(dirB, "README.md") });

    const rows = inst.db.prepare(
      "SELECT DISTINCT source_path FROM memories WHERE deleted = 0"
    ).all() as Array<{ source_path: string }>;

    // Should have 2 distinct source_paths, not both "README.md"
    expect(rows.length).toBe(2);
    expect(rows[0].source_path).not.toBe(rows[1].source_path);
  });
});
