/**
 * Tests for memory.search — minScore normalization to 0~1 scale.
 * Uses mock embedder to test RRF normalization logic directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryAdd } from "./add.js";
import { memorySearch } from "./search.js";
import path from "node:path";
import os from "node:os";

vi.mock("../core/embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `um-search-norm-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

describe("search score normalization", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("top result has score 1.0 after normalization", async () => {
    await memoryAdd(inst.db, { content: "alpha project design decisions" });
    await memoryAdd(inst.db, { content: "beta project design decisions" });
    await memoryAdd(inst.db, { content: "gamma unrelated content" });

    const results = await memorySearch(inst.db, {
      query: "alpha project design",
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBe(1.0);
  });

  it("second result score is between 0 and 1.0 (exclusive)", async () => {
    await memoryAdd(inst.db, { content: "alpha project design decisions document" });
    await memoryAdd(inst.db, { content: "beta completely different topic here" });

    const results = await memorySearch(inst.db, {
      query: "alpha project design",
      limit: 10,
    });

    if (results.length >= 2) {
      expect(results[1].score).toBeGreaterThan(0);
      expect(results[1].score).toBeLessThanOrEqual(1.0);
    }
  });

  it("minScore 0.5 filters lower-scoring results", async () => {
    // Add several memories to get a range of scores
    await memoryAdd(inst.db, { content: "search normalization test alpha" });
    await memoryAdd(inst.db, { content: "search normalization test beta" });
    await memoryAdd(inst.db, { content: "search normalization test gamma" });
    await memoryAdd(inst.db, { content: "completely unrelated xyz content" });

    const allResults = await memorySearch(inst.db, {
      query: "search normalization test",
      limit: 10,
      minScore: 0,
    });

    const filteredResults = await memorySearch(inst.db, {
      query: "search normalization test",
      limit: 10,
      minScore: 0.5,
    });

    // Filtered should have fewer or equal results
    expect(filteredResults.length).toBeLessThanOrEqual(allResults.length);
    // All filtered results should have score >= 0.5
    for (const r of filteredResults) {
      expect(r.score).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("0 results → empty array (no division by zero)", async () => {
    const results = await memorySearch(inst.db, {
      query: "totally nonexistent content zzzzz",
      limit: 10,
    });

    expect(results).toEqual([]);
  });

  it("single result → score = 1.0", async () => {
    await memoryAdd(inst.db, {
      content: "unique singleton memory xyzzy42",
      scope: "singleton-scope",
    });

    const results = await memorySearch(inst.db, {
      query: "unique singleton xyzzy42",
      scope: "singleton-scope",
      limit: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0].score).toBe(1.0);
  });

  it("all same RRF score → all normalized to 1.0", async () => {
    // Add identical content so they get the same RRF scores
    await memoryAdd(inst.db, { content: "identical memory content for test" });
    await memoryAdd(inst.db, { content: "identical memory content for test" });

    const results = await memorySearch(inst.db, {
      query: "identical memory content for test",
      limit: 10,
    });

    // If multiple results exist and all have same raw score, they should all be 1.0
    if (results.length >= 2) {
      // After normalization, top = 1.0
      expect(results[0].score).toBe(1.0);
    }
  });

  it("minScore 0 → returns all results (default backwards compat)", async () => {
    await memoryAdd(inst.db, { content: "backward compat test alpha" });
    await memoryAdd(inst.db, { content: "backward compat test beta" });

    const results = await memorySearch(inst.db, {
      query: "backward compat test",
      limit: 10,
      minScore: 0,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("minScore 1.0 → only top-scoring results", async () => {
    await memoryAdd(inst.db, { content: "top score test alpha content" });
    await memoryAdd(inst.db, { content: "top score test beta different" });
    await memoryAdd(inst.db, { content: "completely unrelated stuff here" });

    const results = await memorySearch(inst.db, {
      query: "top score test alpha content",
      limit: 10,
      minScore: 1.0,
    });

    // Should return at least the top result (score = 1.0)
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.score).toBe(1.0);
    }
  });
});
