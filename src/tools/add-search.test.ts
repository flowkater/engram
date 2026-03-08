/**
 * Integration test: memory.add → memory.search roundtrip.
 * Uses a mock embedder to avoid Ollama dependency in tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryAdd } from "./add.js";
import { memorySearch } from "./search.js";
import path from "node:path";
import os from "node:os";

// Mock the embedder to return deterministic vectors
vi.mock("../core/embedder.js", () => {
  // Simple hash-based embedding: creates a distinct 768-dim vector per string
  function fakeEmbed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(768);
    // Seed from text content to make similar texts produce similar vectors
    for (let i = 0; i < text.length && i < 768; i++) {
      vec[i] = text.charCodeAt(i) / 256;
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < 768; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < 768; i++) vec[i] /= norm;
    return Promise.resolve(vec);
  }

  return {
    embed: fakeEmbed,
    EMBEDDING_DIM: 768,
    getCurrentModelName: () => "test/fake-model",
  };
});

function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `unified-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

describe("memory.add + memory.search integration", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("add and search roundtrip", async () => {
    // Add 3 memories
    await memoryAdd(inst.db, {
      content: "재분배 정책은 task 플랫 처리로 변경됨",
      scope: "todait-backend",
      tags: ["redistribution", "policy"],
    });
    await memoryAdd(inst.db, {
      content: "iOS 앱 빌드 시 코드 사이닝 이슈 해결",
      scope: "todait-ios",
      tags: ["ios", "build"],
    });
    await memoryAdd(inst.db, {
      content: "redistribution engine refactored for flat processing",
      scope: "todait-backend",
      tags: ["redistribution", "refactor"],
    });

    // Search for redistribution-related content
    const results = await memorySearch(inst.db, {
      query: "redistribution policy",
      limit: 10,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);

    // The redistribution-related memories should appear in results
    const contents = results.map((r) => r.content);
    const hasRedist = contents.some(
      (c) => c.includes("재분배") || c.includes("redistribution")
    );
    expect(hasRedist).toBe(true);
  });

  it("filters by scope", async () => {
    await memoryAdd(inst.db, {
      content: "backend task processing update",
      scope: "todait-backend",
    });
    await memoryAdd(inst.db, {
      content: "iOS navigation fix",
      scope: "todait-ios",
    });

    const results = await memorySearch(inst.db, {
      query: "task processing",
      scope: "todait-backend",
    });

    for (const r of results) {
      expect(r.scope).toBe("todait-backend");
    }
  });

  it("updates access_count on search", async () => {
    const added = await memoryAdd(inst.db, {
      content: "test memory for access count",
    });

    await memorySearch(inst.db, { query: "test memory" });

    const row = inst.db
      .prepare("SELECT access_count FROM memories WHERE id = ?")
      .get(added.id) as { access_count: number };

    expect(row.access_count).toBe(1);
  });

  it("returns empty array for no matches", async () => {
    const results = await memorySearch(inst.db, {
      query: "nonexistent query xyz",
    });
    expect(results).toEqual([]);
  });
});
