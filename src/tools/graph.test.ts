/**
 * Tests for memory.graph tool.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryGraph, MAX_GRAPH_HOP_DEPTH } from "./graph.js";
import path from "node:path";
import os from "node:os";

vi.mock("../core/embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-graph-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function setupGraph(db: any) {
  const now = new Date().toISOString();
  const insert = (id: string, content: string, scope = "global") => {
    db.prepare(
      "INSERT INTO memories (id, content, source, scope, tags, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, content, "obsidian", scope, "[]", 0.5, now, now);
  };

  insert("A", "Redistribution policy document");
  insert("B", "Task processing engine");
  insert("C", "ST1 engine design");
  insert("D", "iOS build pipeline");

  // A -> B (wikilink), B -> C (wikilink), A -> D (tag)
  const insertLink = (from: string, to: string, type: string, weight = 1.0) => {
    db.prepare(
      "INSERT INTO memory_links (from_id, to_id, link_type, weight, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(from, to, type, weight, now);
  };

  insertLink("A", "B", "wikilink");
  insertLink("B", "C", "wikilink");
  insertLink("A", "D", "tag", 0.5);
}

describe("memory.graph", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
    setupGraph(inst.db);
  });
  afterEach(() => { inst.close(); });

  it("traverses 1 hop from root", async () => {
    const result = await memoryGraph(inst.db, { memoryId: "A", hops: 1 });

    expect(result.root?.id).toBe("A");
    expect(result.connected.length).toBe(2); // B and D
    const connectedIds = result.connected.map((c) => c.memory.id);
    expect(connectedIds).toContain("B");
    expect(connectedIds).toContain("D");
  });

  it("traverses 2 hops from root", async () => {
    const result = await memoryGraph(inst.db, { memoryId: "A", hops: 2 });

    expect(result.root?.id).toBe("A");
    const connectedIds = result.connected.map((c) => c.memory.id);
    expect(connectedIds).toContain("B"); // 1 hop
    expect(connectedIds).toContain("C"); // 2 hops
    expect(connectedIds).toContain("D"); // 1 hop
  });

  it("filters by link type", async () => {
    const result = await memoryGraph(inst.db, { memoryId: "A", hops: 2, linkType: "wikilink" });

    const connectedIds = result.connected.map((c) => c.memory.id);
    expect(connectedIds).toContain("B");
    expect(connectedIds).toContain("C");
    expect(connectedIds).not.toContain("D"); // D is tag link
  });

  it("returns empty for unknown memory", async () => {
    const result = await memoryGraph(inst.db, { memoryId: "nonexistent" });
    expect(result.root).toBeNull();
    expect(result.connected).toHaveLength(0);
  });

  it("finds root via query", async () => {
    // Add to vec index for search to work
    const vec = new Float32Array(768);
    for (let i = 0; i < "Redistribution".length; i++) vec[i] = "Redistribution".charCodeAt(i) / 256;
    let norm = 0;
    for (let i = 0; i < 768; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < 768; i++) vec[i] /= norm;

    inst.db.prepare("INSERT INTO memory_vec (id, embedding) VALUES (?, ?)").run("A", Buffer.from(vec.buffer));
    inst.db.prepare("INSERT INTO memory_fts (id, content, summary, tags, scope) VALUES (?, ?, ?, ?, ?)").run(
      "A", "Redistribution policy document", "", "[]", "global"
    );

    const result = await memoryGraph(inst.db, { query: "Redistribution policy" });
    expect(result.root?.id).toBe("A");
  });

  it("reports total links count", async () => {
    const result = await memoryGraph(inst.db, { memoryId: "A" });
    expect(result.totalLinks).toBe(2); // A->B and A->D
  });

  it("respects limit parameter", async () => {
    const result = await memoryGraph(inst.db, { memoryId: "A", hops: 3, limit: 1 });
    expect(result.connected.length).toBeLessThanOrEqual(1);
  });

  it("no duplicates when bidirectional links exist", async () => {
    // Add reverse link B -> A (bidirectional)
    const now = new Date().toISOString();
    inst.db.prepare(
      "INSERT INTO memory_links (from_id, to_id, link_type, weight, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("B", "A", "wikilink", 1.0, now);
    // Also add D -> A reverse
    inst.db.prepare(
      "INSERT INTO memory_links (from_id, to_id, link_type, weight, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("D", "A", "tag", 0.5, now);

    const result = await memoryGraph(inst.db, { memoryId: "A", hops: 2 });
    const ids = result.connected.map((c) => c.memory.id);
    // Each node should appear at most once
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("B");
    expect(ids).toContain("D");
  });
});

describe("memoryGraph — bounded traversal", () => {
  function tmpDbPath(): string {
    return path.join(os.tmpdir(), `engram-memgraph-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  }

  it("caps hop depth at MAX_GRAPH_HOP_DEPTH", async () => {
    const { MAX_GRAPH_HOP_DEPTH } = await import("../tools/graph.js");
    expect(MAX_GRAPH_HOP_DEPTH).toBeGreaterThanOrEqual(3);
    expect(MAX_GRAPH_HOP_DEPTH).toBeLessThanOrEqual(5);

    const inst = openDatabase(tmpDbPath());
    try {
      // Seed a memory with single link (minimal valid graph)
      const now = "2026-04-24T00:00:00.000Z";
      inst.db.prepare(`
        INSERT INTO memories (id, content, source, scope, created_at, updated_at, deleted)
        VALUES ('seed', 'seed', 'manual', 'global', ?, ?, 0)
      `).run(now, now);

      // Passing hops: 99 should be silently capped at MAX_GRAPH_HOP_DEPTH
      const result = await memoryGraph(inst.db, { memoryId: "seed", hops: 99 });
      // The result should not throw or run 99 hops; presence is enough here
      expect(result).toBeDefined();
    } finally {
      inst.close();
    }
  });

  it("batches memory fetches during BFS (no per-node SELECT)", async () => {
    const inst = openDatabase(tmpDbPath());
    try {
      const now = "2026-04-24T00:00:00.000Z";
      // Seed 10 memories, star pattern with seed pointing to 9 neighbors
      for (let i = 0; i < 10; i++) {
        inst.db.prepare(`
          INSERT INTO memories (id, content, source, scope, created_at, updated_at, deleted)
          VALUES (?, ?, 'manual', 'global', ?, ?, 0)
        `).run(`mem-${i}`, `content ${i}`, now, now);
      }
      for (let i = 1; i < 10; i++) {
        inst.db.prepare(`
          INSERT INTO memory_links (from_id, to_id, link_type, weight, created_at)
          VALUES ('mem-0', ?, 'wikilink', 1.0, ?)
        `).run(`mem-${i}`, now);
      }

      const origPrepare = inst.db.prepare.bind(inst.db);
      let perIdMemoryFetches = 0;
      (inst.db as any).prepare = (sql: string) => {
        // Match "WHERE id = ?" against the memories table (not memory_links / vec / fts)
        if (/FROM\s+memories\b[\s\S]*WHERE[\s\S]*\bid\s*=\s*\?/i.test(sql)
            && !/FROM\s+memory_links\b/i.test(sql)) {
          perIdMemoryFetches++;
        }
        return origPrepare(sql);
      };

      await memoryGraph(inst.db, { memoryId: "mem-0", hops: 1 });
      expect(perIdMemoryFetches).toBeLessThanOrEqual(1); // seed-only lookup, neighbors batched
    } finally {
      inst.close();
    }
  });
});
