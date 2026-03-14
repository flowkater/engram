import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type DatabaseInstance } from "./database.js";
import {
  planFileBackedDuplicateRepair,
  repairFileBackedDuplicates,
  planNullSourceSessionDuplicates,
  repairNullSourceSessionDuplicates,
} from "./duplicate-repair.js";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-duplicate-repair-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "um-duplicate-repair-dir-"));
}

function insertMemory(
  db: DatabaseInstance["db"],
  row: {
    id: string;
    sourcePath?: string | null;
    sourceHash: string | null;
    chunkIndex: number;
    updatedAt: string;
    source?: string;
  }
): void {
  const source = row.source ?? "obsidian";
  db.prepare(`
    INSERT INTO memories (
      id, content, summary, source, source_path, source_hash, chunk_index, scope,
      agent, tags, importance, created_at, updated_at, access_count, deleted, embed_model
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    `content-${row.id}`,
    `summary-${row.id}`,
    source,
    row.sourcePath ?? null,
    row.sourceHash,
    row.chunkIndex,
    "global",
    null,
    "[]",
    0.5,
    row.updatedAt,
    row.updatedAt,
    0,
    0,
    "test-model"
  );

  const vec = new Float32Array(768);
  vec[0] = row.chunkIndex + 1;
  db.prepare("INSERT INTO memory_vec (id, embedding) VALUES (?, ?)").run(
    row.id,
    Buffer.from(vec.buffer)
  );
  db.prepare(
    "INSERT INTO memory_fts (id, content, summary, tags, scope) VALUES (?, ?, ?, ?, ?)"
  ).run(row.id, `content-${row.id}`, `summary-${row.id}`, "[]", "global");
  db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run(row.id, "dup");
}

describe("duplicate repair", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
    inst.db.exec("DROP INDEX IF EXISTS idx_memories_active_file_chunk_unique");
  });

  afterEach(() => {
    inst.close();
  });

  it("plans and repairs same-hash duplicates while preserving one row per chunk", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "note.md");
    fs.writeFileSync(filePath, "# note\n");

    insertMemory(inst.db, {
      id: "keep-0",
      sourcePath: filePath,
      sourceHash: "hash-a",
      chunkIndex: 0,
      updatedAt: "2026-03-13T01:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "drop-0",
      sourcePath: filePath,
      sourceHash: "hash-a",
      chunkIndex: 0,
      updatedAt: "2026-03-13T00:59:00.000Z",
    });
    insertMemory(inst.db, {
      id: "keep-1",
      sourcePath: filePath,
      sourceHash: "hash-a",
      chunkIndex: 1,
      updatedAt: "2026-03-13T01:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "drop-1",
      sourcePath: filePath,
      sourceHash: "hash-a",
      chunkIndex: 1,
      updatedAt: "2026-03-13T00:59:00.000Z",
    });

    const plan = planFileBackedDuplicateRepair(inst.db);
    expect(plan.candidates).toBe(1);
    expect(plan.duplicateRows).toBe(2);
    expect(plan.items[0].keepIds).toEqual(["keep-0", "keep-1"]);
    expect(plan.items[0].deleteIds.sort()).toEqual(["drop-0", "drop-1"]);

    const result = repairFileBackedDuplicates(inst.db, { dryRun: false });
    expect(result.repairedFiles).toBe(1);
    expect(result.repairedRows).toBe(2);

    const active = inst.db.prepare(
      "SELECT id FROM memories WHERE source_path = ? AND deleted = 0 ORDER BY id"
    ).all(filePath) as Array<{ id: string }>;
    expect(active.map((row) => row.id)).toEqual(["keep-0", "keep-1"]);

    const deleted = inst.db.prepare(
      "SELECT id FROM memories WHERE source_path = ? AND deleted = 1 ORDER BY id"
    ).all(filePath) as Array<{ id: string }>;
    expect(deleted.map((row) => row.id)).toEqual(["drop-0", "drop-1"]);

    const vecRows = inst.db.prepare(
      "SELECT id FROM memory_vec WHERE id IN ('drop-0', 'drop-1')"
    ).all();
    expect(vecRows).toHaveLength(0);

    const ftsRows = inst.db.prepare(
      "SELECT id FROM memory_fts WHERE id IN ('drop-0', 'drop-1')"
    ).all();
    expect(ftsRows).toHaveLength(0);

    const tagRows = inst.db.prepare(
      "SELECT memory_id FROM memory_tags WHERE memory_id IN ('drop-0', 'drop-1')"
    ).all();
    expect(tagRows).toHaveLength(0);
  });

  it("keeps the newest hash-set when multiple active hashes exist for a file", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "multi.md");
    fs.writeFileSync(filePath, "# multi\n");

    insertMemory(inst.db, {
      id: "old-0",
      sourcePath: filePath,
      sourceHash: "hash-old",
      chunkIndex: 0,
      updatedAt: "2026-03-13T01:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "old-1",
      sourcePath: filePath,
      sourceHash: "hash-old",
      chunkIndex: 1,
      updatedAt: "2026-03-13T01:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "new-0-a",
      sourcePath: filePath,
      sourceHash: "hash-new",
      chunkIndex: 0,
      updatedAt: "2026-03-13T02:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "new-0-b",
      sourcePath: filePath,
      sourceHash: "hash-new",
      chunkIndex: 0,
      updatedAt: "2026-03-13T01:59:00.000Z",
    });
    insertMemory(inst.db, {
      id: "new-1",
      sourcePath: filePath,
      sourceHash: "hash-new",
      chunkIndex: 1,
      updatedAt: "2026-03-13T02:00:00.000Z",
    });

    const result = repairFileBackedDuplicates(inst.db, { dryRun: false });
    expect(result.repairedRows).toBe(3);

    const active = inst.db.prepare(
      "SELECT id FROM memories WHERE source_path = ? AND deleted = 0 ORDER BY id"
    ).all(filePath) as Array<{ id: string }>;
    expect(active.map((row) => row.id)).toEqual(["new-0-a", "new-1"]);
  });

  it("prefers the newest complete hash-set over a newer partial hash-set", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "partial.md");
    fs.writeFileSync(filePath, "# partial\n");

    insertMemory(inst.db, {
      id: "complete-0",
      sourcePath: filePath,
      sourceHash: "hash-complete",
      chunkIndex: 0,
      updatedAt: "2026-03-13T01:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "complete-1",
      sourcePath: filePath,
      sourceHash: "hash-complete",
      chunkIndex: 1,
      updatedAt: "2026-03-13T01:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "partial-0",
      sourcePath: filePath,
      sourceHash: "hash-partial",
      chunkIndex: 0,
      updatedAt: "2026-03-13T02:00:00.000Z",
    });

    const plan = planFileBackedDuplicateRepair(inst.db);
    expect(plan.items[0].keepHash).toBe("hash-complete");
    expect(plan.items[0].keepIds).toEqual(["complete-0", "complete-1"]);
    expect(plan.items[0].deleteIds).toEqual(["partial-0"]);
  });

  it("upserts or deletes file checkpoints during repair and ignores non-file-backed duplicates", () => {
    const dir = tmpDir();
    const existingFile = path.join(dir, "existing.md");
    fs.writeFileSync(existingFile, "# existing\n");
    const missingFile = path.join(dir, "missing.md");

    insertMemory(inst.db, {
      id: "existing-keep",
      sourcePath: existingFile,
      sourceHash: "hash-existing",
      chunkIndex: 0,
      updatedAt: "2026-03-13T03:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "existing-drop",
      sourcePath: existingFile,
      sourceHash: "hash-existing",
      chunkIndex: 0,
      updatedAt: "2026-03-13T02:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "missing-keep",
      sourcePath: missingFile,
      sourceHash: "hash-missing",
      chunkIndex: 0,
      updatedAt: "2026-03-13T03:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "missing-drop",
      sourcePath: missingFile,
      sourceHash: "hash-missing",
      chunkIndex: 0,
      updatedAt: "2026-03-13T02:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "no-path-a",
      sourcePath: null,
      sourceHash: "hash-nopath",
      chunkIndex: 0,
      updatedAt: "2026-03-13T04:00:00.000Z",
      source: "manual",
    });
    insertMemory(inst.db, {
      id: "no-path-b",
      sourcePath: null,
      sourceHash: "hash-nopath",
      chunkIndex: 0,
      updatedAt: "2026-03-13T03:00:00.000Z",
      source: "manual",
    });

    inst.db.prepare(
      "INSERT INTO file_checkpoints (source_path, source, file_mtime_ms, indexed_at) VALUES (?, ?, ?, ?)"
    ).run(existingFile, "obsidian", 1, "2026-03-13T00:00:00.000Z");
    inst.db.prepare(
      "INSERT INTO file_checkpoints (source_path, source, file_mtime_ms, indexed_at) VALUES (?, ?, ?, ?)"
    ).run(missingFile, "obsidian", 1, "2026-03-13T00:00:00.000Z");

    const result = repairFileBackedDuplicates(inst.db, { dryRun: false });
    expect(result.repairedFiles).toBe(2);

    const existingCheckpoint = inst.db.prepare(
      "SELECT file_mtime_ms FROM file_checkpoints WHERE source_path = ?"
    ).get(existingFile) as { file_mtime_ms: number };
    expect(existingCheckpoint.file_mtime_ms).toBe(fs.statSync(existingFile).mtimeMs);

    const missingCheckpoint = inst.db.prepare(
      "SELECT * FROM file_checkpoints WHERE source_path = ?"
    ).get(missingFile);
    expect(missingCheckpoint).toBeUndefined();

    const noPathRows = inst.db.prepare(
      "SELECT id, deleted FROM memories WHERE id IN ('no-path-a', 'no-path-b') ORDER BY id"
    ).all() as Array<{ id: string; deleted: number }>;
    expect(noPathRows).toEqual([
      { id: "no-path-a", deleted: 0 },
      { id: "no-path-b", deleted: 0 },
    ]);
  });

  it("detects duplicate candidates when file-backed rows have null source hashes", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "null-hash.md");
    fs.writeFileSync(filePath, "# null hash\n");

    insertMemory(inst.db, {
      id: "null-keep",
      sourcePath: filePath,
      sourceHash: null,
      chunkIndex: 0,
      updatedAt: "2026-03-13T03:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "null-drop",
      sourcePath: filePath,
      sourceHash: null,
      chunkIndex: 0,
      updatedAt: "2026-03-13T02:00:00.000Z",
    });

    const plan = planFileBackedDuplicateRepair(inst.db);
    expect(plan.candidates).toBe(1);
    expect(plan.items[0].keepIds).toEqual(["null-keep"]);
    expect(plan.items[0].deleteIds).toEqual(["null-drop"]);
  });

  it("treats checkpoint planning as delete when file disappears before stat", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "vanish.md");
    fs.writeFileSync(filePath, "# vanish\n");

    insertMemory(inst.db, {
      id: "vanish-keep",
      sourcePath: filePath,
      sourceHash: "hash-a",
      chunkIndex: 0,
      updatedAt: "2026-03-13T03:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "vanish-drop",
      sourcePath: filePath,
      sourceHash: "hash-a",
      chunkIndex: 0,
      updatedAt: "2026-03-13T02:00:00.000Z",
    });

    const realExistsSync = fs.existsSync.bind(fs);
    const realStatSync = fs.statSync.bind(fs);

    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((target) => {
      if (String(target) === filePath) return true;
      return realExistsSync(target);
    });
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((target) => {
      if (String(target) === filePath) {
        throw new Error("ENOENT");
      }
      return realStatSync(target);
    });

    const plan = planFileBackedDuplicateRepair(inst.db);
    expect(plan.items[0].checkpoint.action).toBe("delete");

    existsSpy.mockRestore();
    statSpy.mockRestore();
  });

  it("limits planning to explicit target paths when provided", () => {
    const dir = tmpDir();
    const fileA = path.join(dir, "a.md");
    const fileB = path.join(dir, "b.md");
    fs.writeFileSync(fileA, "# a\n");
    fs.writeFileSync(fileB, "# b\n");

    insertMemory(inst.db, {
      id: "a-keep",
      sourcePath: fileA,
      sourceHash: "hash-a",
      chunkIndex: 0,
      updatedAt: "2026-03-13T03:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "a-drop",
      sourcePath: fileA,
      sourceHash: "hash-a",
      chunkIndex: 0,
      updatedAt: "2026-03-13T02:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "b-keep",
      sourcePath: fileB,
      sourceHash: "hash-b",
      chunkIndex: 0,
      updatedAt: "2026-03-13T03:00:00.000Z",
    });
    insertMemory(inst.db, {
      id: "b-drop",
      sourcePath: fileB,
      sourceHash: "hash-b",
      chunkIndex: 0,
      updatedAt: "2026-03-13T02:00:00.000Z",
    });

    const plan = planFileBackedDuplicateRepair(inst.db, { targetPaths: [fileB] });
    expect(plan.candidates).toBe(1);
    expect(plan.items[0].sourcePath).toBe(fileB);
    expect(plan.items[0].deleteIds).toEqual(["b-drop"]);
  });

  it("repairs large duplicate batches without exceeding SQLite variable limits", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "large.md");
    fs.writeFileSync(filePath, "# large\n");

    for (let copy = 0; copy < 3; copy += 1) {
      for (let chunkIndex = 0; chunkIndex < 450; chunkIndex += 1) {
        insertMemory(inst.db, {
          id: `row-${copy}-${chunkIndex}`,
          sourcePath: filePath,
          sourceHash: "hash-large",
          chunkIndex,
          updatedAt: `2026-03-13T0${3 - copy}:00:00.000Z`,
        });
      }
    }

    const result = repairFileBackedDuplicates(inst.db, { dryRun: false });
    expect(result.repairedFiles).toBe(1);
    expect(result.repairedRows).toBe(900);

    const counts = inst.db.prepare(`
      SELECT
        sum(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS active_count,
        sum(CASE WHEN deleted = 1 THEN 1 ELSE 0 END) AS deleted_count
      FROM memories
      WHERE source_path = ?
    `).get(filePath) as { active_count: number; deleted_count: number };
    expect(counts).toEqual({ active_count: 450, deleted_count: 900 });

    const orphanVec = inst.db.prepare(
      "SELECT count(*) as count FROM memory_vec WHERE id LIKE 'row-%'"
    ).get() as { count: number };
    expect(orphanVec.count).toBe(450);
  });

  it("repairs exact-duplicate null-source session rows while preserving aggregated metadata", () => {
    insertMemory(inst.db, {
      id: "session-old",
      sourcePath: null,
      sourceHash: null,
      chunkIndex: 0,
      updatedAt: "2026-03-13T02:00:00.000Z",
      source: "session",
    });
    insertMemory(inst.db, {
      id: "session-new",
      sourcePath: null,
      sourceHash: null,
      chunkIndex: 0,
      updatedAt: "2026-03-13T03:00:00.000Z",
      source: "session",
    });
    inst.db.prepare(`
      UPDATE memories
      SET scope = ?, agent = ?, content = ?, summary = ?, access_count = ?, accessed_at = ?, created_at = ?
      WHERE id = ?
    `).run(
      "todait-ios",
      "flowkater",
      "[Auto] session summary",
      "[Auto] session summary",
      3,
      "2026-03-13T02:10:00.000Z",
      "2026-03-13T02:00:00.000Z",
      "session-old"
    );
    inst.db.prepare(`
      UPDATE memories
      SET scope = ?, agent = ?, content = ?, summary = ?, access_count = ?, accessed_at = ?, created_at = ?
      WHERE id = ?
    `).run(
      "todait-ios",
      "flowkater",
      "[Auto] session summary",
      "[Auto] session summary",
      5,
      "2026-03-13T03:10:00.000Z",
      "2026-03-13T03:00:00.000Z",
      "session-new"
    );
    inst.db.prepare(`
      INSERT INTO sessions (id, agent, scope, started_at, ended_at, summary, memory_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "sess-1",
      "flowkater",
      "todait-ios",
      "2026-03-13T02:00:00.000Z",
      "2026-03-13T03:00:00.000Z",
      "[Auto] session summary",
      JSON.stringify(["session-old", "session-new"])
    );

    insertMemory(inst.db, {
      id: "manual-keep",
      sourcePath: null,
      sourceHash: null,
      chunkIndex: 0,
      updatedAt: "2026-03-13T03:00:00.000Z",
      source: "manual",
    });

    const plan = planNullSourceSessionDuplicates(inst.db);
    expect(plan.candidates).toBe(1);
    expect(plan.items[0].keepId).toBe("session-new");
    expect(plan.items[0].deleteIds).toEqual(["session-old"]);
    expect(plan.items[0].accessCount).toBe(8);

    const result = repairNullSourceSessionDuplicates(inst.db, false);
    expect(result.repairedGroups).toBe(1);
    expect(result.repairedRows).toBe(1);

    const kept = inst.db.prepare(`
      SELECT deleted, access_count, accessed_at, created_at, updated_at
      FROM memories
      WHERE id = ?
    `).get("session-new") as {
      deleted: number;
      access_count: number;
      accessed_at: string;
      created_at: string;
      updated_at: string;
    };
    expect(kept).toEqual({
      deleted: 0,
      access_count: 8,
      accessed_at: "2026-03-13T03:10:00.000Z",
      created_at: "2026-03-13T02:00:00.000Z",
      updated_at: "2026-03-13T03:00:00.000Z",
    });

    const dropped = inst.db.prepare(
      "SELECT deleted FROM memories WHERE id = ?"
    ).get("session-old") as { deleted: number };
    expect(dropped.deleted).toBe(1);

    const manual = inst.db.prepare(
      "SELECT deleted FROM memories WHERE id = ?"
    ).get("manual-keep") as { deleted: number };
    expect(manual.deleted).toBe(0);

    const session = inst.db.prepare(
      "SELECT memory_ids FROM sessions WHERE id = ?"
    ).get("sess-1") as { memory_ids: string };
    expect(JSON.parse(session.memory_ids)).toEqual(["session-new"]);
  });
});
