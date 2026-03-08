/**
 * Tests for memory.summary tool.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memorySummary } from "./summary.js";
import path from "node:path";
import os from "node:os";

vi.mock("../core/embedder.js", () => {
  function fakeEmbed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(768);
    for (let i = 0; i < Math.min(text.length, 768); i++) vec[i] = text.charCodeAt(i) / 256;
    let norm = 0;
    for (let i = 0; i < 768; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < 768; i++) vec[i] /= norm;
    return Promise.resolve(vec);
  }
  return { embed: fakeEmbed, EMBEDDING_DIM: 768, getCurrentModelName: () => "test/fake-model" };
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-sum-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("memory.summary", () => {
  let inst: DatabaseInstance;

  beforeEach(() => { inst = openDatabase(tmpDbPath()); });
  afterEach(() => { inst.close(); });

  it("saves session summary as memory", async () => {
    const result = await memorySummary(inst.db, {
      summary: "Refactored redistribution engine to use flat processing",
      scope: "todait-backend",
      agent: "codex",
    });

    expect(result.memoryId).toBeTruthy();
    expect(result.sessionId).toBeTruthy();

    const mem = inst.db.prepare("SELECT * FROM memories WHERE id = ?").get(result.memoryId) as any;
    expect(mem.source).toBe("session");
    expect(mem.scope).toBe("todait-backend");
    expect(mem.importance).toBe(0.7);
  });

  it("creates session record", async () => {
    const result = await memorySummary(inst.db, {
      summary: "Fixed iOS build issues",
      sessionId: "session-123",
      agent: "claude-code",
    });

    const session = inst.db.prepare("SELECT * FROM sessions WHERE id = ?").get("session-123") as any;
    expect(session).toBeTruthy();
    expect(session.agent).toBe("claude-code");
    expect(JSON.parse(session.memory_ids)).toContain(result.memoryId);
  });

  it("adds to existing session", async () => {
    await memorySummary(inst.db, {
      summary: "First summary",
      sessionId: "session-456",
    });
    const result2 = await memorySummary(inst.db, {
      summary: "Second summary",
      sessionId: "session-456",
    });

    const session = inst.db.prepare("SELECT * FROM sessions WHERE id = ?").get("session-456") as any;
    const memIds = JSON.parse(session.memory_ids);
    expect(memIds).toContain(result2.memoryId);
  });

  it("stores in vector and FTS indexes", async () => {
    const result = await memorySummary(inst.db, {
      summary: "API endpoint optimization completed",
    });

    const vec = inst.db.prepare("SELECT id FROM memory_vec WHERE id = ?").get(result.memoryId);
    expect(vec).toBeTruthy();

    const fts = inst.db.prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH ?").all('"optimization"');
    expect(fts.length).toBeGreaterThanOrEqual(1);
  });
});
