/**
 * Tests for memory.context tool.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryContext } from "./context.js";
import { resetScopeConfigCache } from "../utils/scope.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function insertMemory(db: any, id: string, content: string, scope: string, importance: number = 0.5, source: string = "manual") {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO memories (id, content, source, scope, tags, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, content, source, scope, "[]", importance, now, now);
}

describe("memory.context", () => {
  let inst: DatabaseInstance;
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
    // Set up scope config so tests don't depend on hardcoded defaults
    originalHome = process.env.HOME;
    tmpHome = path.join(os.tmpdir(), `um-ctx-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const engramDir = path.join(tmpHome, ".engram");
    fs.mkdirSync(engramDir, { recursive: true });
    fs.writeFileSync(
      path.join(engramDir, "config.json"),
      JSON.stringify({
        scopeMap: {
          "todait-backend": "/workspace/todait/todait/todait-backend",
          "todait-ios": "/workspace/todait/todait/todait-ios",
        },
      })
    );
    process.env.HOME = tmpHome;
    resetScopeConfigCache();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    resetScopeConfigCache();
    inst.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("detects scope from cwd and returns matching memories", () => {
    insertMemory(inst.db, "m1", "Backend API design", "todait-backend", 0.8);
    insertMemory(inst.db, "m2", "iOS layout fix", "todait-ios", 0.5);
    insertMemory(inst.db, "m3", "Global note", "global", 0.5);

    const result = memoryContext(inst.db, {
      cwd: "/workspace/todait/todait/todait-backend/src",
    });

    expect(result.scope).toBe("todait-backend");
    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain("m1");
    expect(ids).toContain("m3"); // global included
    expect(ids).not.toContain("m2"); // different scope
  });

  it("returns global scope when cwd doesn't match any known path", () => {
    insertMemory(inst.db, "g1", "Global memory", "global", 0.5);

    const result = memoryContext(inst.db, {
      cwd: "/some/unknown/path",
    });

    expect(result.scope).toBe("global");
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      insertMemory(inst.db, `lim-${i}`, `Memory ${i}`, "global", 0.5);
    }

    const result = memoryContext(inst.db, { cwd: "/tmp", limit: 3 });
    expect(result.memories).toHaveLength(3);
  });

  it("orders by importance when recent=false", () => {
    insertMemory(inst.db, "low", "Low importance", "global", 0.1);
    insertMemory(inst.db, "high", "High importance", "global", 0.9);

    const result = memoryContext(inst.db, {
      cwd: "/tmp",
      recent: false,
      limit: 10,
    });

    expect(result.memories[0].id).toBe("high");
  });

  it("excludes deleted memories", () => {
    insertMemory(inst.db, "alive", "Alive", "global");
    insertMemory(inst.db, "dead", "Dead", "global");
    inst.db.prepare("UPDATE memories SET deleted = 1 WHERE id = ?").run("dead");

    const result = memoryContext(inst.db, { cwd: "/tmp" });
    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain("alive");
    expect(ids).not.toContain("dead");
  });

  it("updates access_count on retrieval", () => {
    insertMemory(inst.db, "acc1", "Access test", "global");

    memoryContext(inst.db, { cwd: "/tmp" });

    const row = inst.db.prepare("SELECT access_count FROM memories WHERE id = ?").get("acc1") as { access_count: number };
    expect(row.access_count).toBe(1);
  });
});
