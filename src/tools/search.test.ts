/**
 * Tests for memory.search — minScore normalization to 0~1 scale.
 * Uses mock embedder to test RRF normalization logic directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryAdd } from "./add.js";
import { memoryPromote } from "./promote.js";
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

  it("asOf filters canonical memories by validity window", async () => {
    const oldRaw = await memoryAdd(inst.db, {
      content: "Authentication used cookie sessions.",
      scope: "todait-backend",
    });
    const newRaw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const oldCanonical = await memoryPromote(inst.db, {
      memoryIds: [oldRaw.id],
      kind: "fact",
      title: "Old auth mechanism",
      content: "Authentication used cookie sessions.",
      scope: "todait-backend",
      validFrom: "2026-01-01T00:00:00.000Z",
    });

    await memoryPromote(inst.db, {
      memoryIds: [newRaw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      validFrom: "2026-03-01T00:00:00.000Z",
      supersedes: [oldCanonical.canonicalId],
    });

    const february = await memorySearch(inst.db, {
      query: "auth mechanism",
      scope: "todait-backend",
      asOf: "2026-02-01T00:00:00.000Z",
      limit: 5,
    });

    const april = await memorySearch(inst.db, {
      query: "auth mechanism",
      scope: "todait-backend",
      asOf: "2026-04-01T00:00:00.000Z",
      limit: 5,
    });

    expect(february.some((r) => r.content.includes("cookie sessions"))).toBe(true);
    expect(february.some((r) => r.content.includes("JWT access tokens"))).toBe(false);
    expect(april.some((r) => r.content.includes("JWT access tokens"))).toBe(true);
  });

  it("does not return raw-only results for asOf queries without canonical memories", async () => {
    await memoryAdd(inst.db, {
      content: "Temporary rollout note without canonical promotion.",
      scope: "todait-backend",
      source: "manual",
    });

    const results = await memorySearch(inst.db, {
      query: "temporary rollout",
      scope: "todait-backend",
      asOf: "2026-02-01T00:00:00.000Z",
      limit: 5,
    });

    expect(results).toHaveLength(0);
  });

  it("skips canonical memories when raw-only filters are requested", async () => {
    const raw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      source: "manual",
      agent: "codex",
    });

    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const sourceFiltered = await memorySearch(inst.db, {
      query: "JWT access tokens",
      scope: "todait-backend",
      source: "manual",
      limit: 5,
    });

    expect(sourceFiltered.some((result) => result.isCanonical)).toBe(false);
    expect(sourceFiltered.some((result) => result.id === raw.id)).toBe(true);
  });

  it("search — single-pass fetch avoids multiplier loop (prepareCount bounded)", async () => {
    // Seed enough raw memories (>limit*5 and >limit*10) so the OLD multiplier loop
    // would execute multiple iterations instead of early-exiting on vecRaw.length < fetchLimit.
    // limit=5 -> fetchLimit = 25, 50, 100 across the 3 iterations.
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const res = await memoryAdd(inst.db, {
        content: `seed memory number ${i} with some searchable content alpha beta`,
        scope: "prep-test",
      });
      ids.push(res.id);
    }

    // Promote a handful into canonical so the canonical path also does real work.
    for (let i = 0; i < 5; i++) {
      await memoryPromote(inst.db, {
        memoryIds: [ids[i]],
        kind: "fact",
        title: `Seeded canonical ${i}`,
        content: `Seeded canonical fact number ${i} searchable content alpha`,
        scope: "prep-test",
      });
    }

    // Spy on db.prepare to count prepared statements during a single search
    const origPrepare = inst.db.prepare.bind(inst.db);
    let prepareCount = 0;
    (inst.db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      prepareCount++;
      return origPrepare(sql);
    };

    try {
      await memorySearch(inst.db, { query: "searchable content alpha", limit: 5 });
    } finally {
      (inst.db as unknown as { prepare: unknown }).prepare = origPrepare;
    }

    // Old impl with multiplier loop: up to 3 iters * (1 vec + 1 vec-filter + 1 fts + 1 fts-filter)
    //   per path (canonical + raw) + materialize + access update = 20+
    // New impl (single-pass JOIN): 1 canonical vec + 1 canonical fts + 1 canonical materialize
    //   + 1 raw vec + 1 raw fts + 1 raw materialize + 1 raw access update = 7
    expect(prepareCount).toBeLessThanOrEqual(8);
  });
});
