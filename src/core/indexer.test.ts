/**
 * Tests for the indexing pipeline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { indexFile, indexDirectory, isAlreadyIndexed, softDeleteByPath } from "./indexer.js";
import { acquireRuntimeLease, buildIndexLeaseKey, releaseRuntimeLease } from "./runtime-leases.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
vi.mock("./embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-idx-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `um-idx-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("indexer", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("indexes a single markdown file", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "test.md");
    fs.writeFileSync(filePath, `# Test Note\n\nSome content about testing.\n\n## Section\n\nMore content here.`);

    const result = await indexFile(inst.db, filePath, "test.md", { source: "obsidian" });
    expect(result.skipped).toBe(false);
    expect(result.chunks).toBeGreaterThanOrEqual(1);

    // source_path should be normalized to absolute
    const resolvedPath = path.resolve("test.md");
    const rows = inst.db.prepare("SELECT * FROM memories WHERE source_path = ? AND deleted = 0").all(resolvedPath);
    expect(rows.length).toBe(result.chunks);

    // Verify embed_model is stored
    const row = inst.db.prepare("SELECT embed_model FROM memories WHERE source_path = ? AND deleted = 0 LIMIT 1").get(resolvedPath) as any;
    expect(row.embed_model).toBe("test-model");
  });

  it("skips already indexed file with same hash", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "test.md");
    fs.writeFileSync(filePath, "# Test\n\nContent here.");

    await indexFile(inst.db, filePath, filePath, { source: "obsidian" });
    const result2 = await indexFile(inst.db, filePath, filePath, { source: "obsidian" });

    expect(result2.skipped).toBe(true);
    expect(result2.chunks).toBe(0);
  });

  it("re-indexes when file content changes", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "test.md");
    fs.writeFileSync(filePath, "# Test\n\nOriginal content.");

    await indexFile(inst.db, filePath, filePath, { source: "obsidian" });

    // Modify file
    fs.writeFileSync(filePath, "# Test\n\nUpdated content with more text.");
    const result = await indexFile(inst.db, filePath, filePath, { source: "obsidian" });

    expect(result.skipped).toBe(false);
    // Old chunks should be soft-deleted
    const deleted = inst.db.prepare("SELECT COUNT(*) as c FROM memories WHERE source_path = ? AND deleted = 1").get(filePath) as { c: number };
    expect(deleted.c).toBeGreaterThanOrEqual(1);
  });

  it("indexes a directory of markdown files", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.md"), "# Note A\n\nContent A.");
    fs.writeFileSync(path.join(dir, "b.md"), "# Note B\n\nContent B.");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sub", "c.md"), "# Note C\n\nContent C.");

    const results = await indexDirectory(inst.db, dir, { source: "obsidian" });

    expect(results).toHaveLength(3);
    const totalChunks = results.reduce((s, r) => s + r.chunks, 0);
    expect(totalChunks).toBeGreaterThanOrEqual(3);

    // Verify all source_paths in DB are absolute
    const rows = inst.db.prepare("SELECT DISTINCT source_path FROM memories WHERE deleted = 0").all() as Array<{ source_path: string }>;
    for (const row of rows) {
      expect(path.isAbsolute(row.source_path)).toBe(true);
    }
  });

  it("ignores .obsidian and .trash directories", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "note.md"), "# Note\n\nContent.");
    fs.mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".obsidian", "config.md"), "config");
    fs.mkdirSync(path.join(dir, ".trash"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".trash", "deleted.md"), "deleted");

    const results = await indexDirectory(inst.db, dir, { source: "obsidian" });
    expect(results).toHaveLength(1);
    expect(path.isAbsolute(results[0].file)).toBe(true);
    expect(results[0].file).toBe(path.resolve(path.join(dir, "note.md")));
  });

  it("softDeleteByPath marks chunks as deleted", () => {
    const now = new Date().toISOString();
    inst.db.prepare(
      "INSERT INTO memories (id, content, source, source_path, source_hash, scope, tags, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("test-id-1", "content", "obsidian", "test.md", "hash1", "global", "[]", 0.5, now, now);

    const changes = softDeleteByPath(inst.db, "test.md");
    expect(changes).toBe(1);

    const row = inst.db.prepare("SELECT deleted FROM memories WHERE id = ?").get("test-id-1") as { deleted: number };
    expect(row.deleted).toBe(1);
  });

  it("stores correct source and scope", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "test.md");
    fs.writeFileSync(filePath, `---\nscope: todait-backend\ntags: [api]\n---\n\n# Test\n\nAPI content.`);

    await indexFile(inst.db, filePath, filePath, { source: "obsidian" });

    const row = inst.db.prepare("SELECT source, scope, tags FROM memories WHERE source_path = ? AND deleted = 0").get(filePath) as any;
    expect(row.source).toBe("obsidian");
    expect(row.scope).toBe("todait-backend");
    expect(JSON.parse(row.tags)).toContain("api");
  });

  it("creates wikilink-based memory_links", async () => {
    const dir = tmpDir();
    // First, create a note that will be the link target
    const targetPath = path.join(dir, "Task Processing.md");
    fs.writeFileSync(targetPath, "# Task Processing\n\nDetails about task processing.");
    await indexFile(inst.db, targetPath, targetPath, { source: "obsidian" });

    // Now create a note with a wikilink to it
    const sourcePath = path.join(dir, "policy.md");
    fs.writeFileSync(sourcePath, "# Policy\n\nSee [[Task Processing]] for details.");
    await indexFile(inst.db, sourcePath, sourcePath, { source: "obsidian" });

    // Check that a wikilink was created
    const links = inst.db.prepare(
      "SELECT * FROM memory_links WHERE link_type = 'wikilink'"
    ).all() as any[];
    expect(links.length).toBeGreaterThanOrEqual(1);
  });

  it("normalizes relative source_path to absolute", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "test.md");
    fs.writeFileSync(filePath, "# Test\n\nContent for normalization test.");

    // Pass relative path — should be stored as absolute
    const result = await indexFile(inst.db, filePath, "test.md", { source: "obsidian" });
    expect(result.skipped).toBe(false);

    const row = inst.db.prepare("SELECT source_path FROM memories WHERE deleted = 0 LIMIT 1").get() as { source_path: string };
    expect(path.isAbsolute(row.source_path)).toBe(true);
    expect(row.source_path).toBe(path.resolve("test.md"));
  });

  it("keeps absolute source_path unchanged", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "test.md");
    fs.writeFileSync(filePath, "# Test\n\nAbsolute path test.");

    // Pass absolute path — should be stored as-is
    const result = await indexFile(inst.db, filePath, filePath, { source: "obsidian" });
    expect(result.skipped).toBe(false);

    const row = inst.db.prepare("SELECT source_path FROM memories WHERE deleted = 0 LIMIT 1").get() as { source_path: string };
    expect(row.source_path).toBe(filePath);
  });

  it("reports progress during directory indexing", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.md"), "# A\n\nContent.");
    fs.writeFileSync(path.join(dir, "b.md"), "# B\n\nContent.");

    const progress: Array<[number, number]> = [];
    await indexDirectory(inst.db, dir, { source: "obsidian" }, (indexed, total) => {
      progress.push([indexed, total]);
    });

    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress[progress.length - 1][0]).toBe(progress[progress.length - 1][1]);
  });

  it("skips indexing when another process holds the file lease", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "test.md");
    fs.writeFileSync(filePath, "# Test\n\nLease protected content.");

    const lease = acquireRuntimeLease(inst.db, buildIndexLeaseKey(filePath), "other-process");
    expect(lease.acquired).toBe(true);

    const result = await indexFile(inst.db, filePath, filePath, { source: "obsidian" });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("locked");

    const count = inst.db.prepare("SELECT COUNT(*) as c FROM memories WHERE source_path = ? AND deleted = 0").get(filePath) as { c: number };
    expect(count.c).toBe(0);

    releaseRuntimeLease(inst.db, buildIndexLeaseKey(filePath), "other-process");
  });
});
