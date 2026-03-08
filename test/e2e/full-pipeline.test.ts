/**
 * E2E Integration Tests — Full pipeline from vault indexing through search, graph, lifecycle, and health.
 * Uses mock embedder (random 768-dim vectors) to test pipeline correctness, not search accuracy.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Mock embedder with random 768-dim vectors
vi.mock("../../src/core/embedder.js", () => {
  function fakeEmbed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(768);
    // Deterministic-ish based on text content for consistency within a test run
    let seed = 0;
    for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) & 0x7fffffff;
    for (let i = 0; i < 768; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      vec[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < 768; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < 768; i++) vec[i] /= norm;
    return Promise.resolve(vec);
  }
  return { embed: fakeEmbed, EMBEDDING_DIM: 768, getCurrentModelName: () => "test-model" };
});

import { openDatabase, type DatabaseInstance } from "../../src/core/database.js";
import { memoryIngest } from "../../src/tools/ingest.js";
import { memorySearch } from "../../src/tools/search.js";
import { memoryStats } from "../../src/tools/stats.js";
import { memoryGraph } from "../../src/tools/graph.js";
import { memoryAdd } from "../../src/tools/add.js";
import { memoryPrune } from "../../src/tools/prune.js";
import { memoryHealth } from "../../src/tools/health.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_VAULT = path.join(__dirname, "fixtures", "sample-vault");

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("E2E Full Pipeline", () => {
  let inst: DatabaseInstance;
  let dbPath: string;

  beforeAll(async () => {
    dbPath = tmpDbPath();
    inst = openDatabase(dbPath);

    // Ingest the fixture vault
    await memoryIngest(inst.db, {
      path: FIXTURE_VAULT,
      source: "obsidian",
      recursive: true,
    });
  }, 60000);

  afterAll(() => {
    inst.close();
    try { fs.unlinkSync(dbPath); } catch {}
  });

  it("1. vault indexing produces memories with correct stats", () => {
    const stats = memoryStats(inst.db, dbPath);
    // We have 12 .md files in the fixture vault
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.bySource?.obsidian).toBeGreaterThan(0);

    // Verify multiple scopes exist
    const scopes = Object.keys(stats.byScope || {});
    expect(scopes.length).toBeGreaterThanOrEqual(3); // todait-backend, todait-ios, unified-memory, global
  });

  it("2. keyword search returns relevant results", async () => {
    const results = await memorySearch(inst.db, {
      query: "Go concurrency goroutine",
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    const hasRelevant = results.some(
      (r) => r.content.toLowerCase().includes("concurrency") || r.content.toLowerCase().includes("goroutine")
    );
    expect(hasRelevant).toBe(true);
  });

  it("3. scope filter returns only matching scope", async () => {
    const results = await memorySearch(inst.db, {
      query: "architecture design",
      scope: "todait-ios",
      limit: 20,
    });

    for (const r of results) {
      expect(r.scope).toBe("todait-ios");
    }
  });

  it("4. graph traversal finds wikilink connections", async () => {
    const searchResults = await memorySearch(inst.db, {
      query: "Todait Backend Architecture gRPC",
      limit: 1,
    });

    expect(searchResults.length).toBeGreaterThan(0);
    const startId = searchResults[0].id;

    const graphResult = await memoryGraph(inst.db, {
      memoryId: startId,
      hops: 2,
      linkType: "all",
      limit: 20,
    });

    expect(graphResult.connected.length).toBeGreaterThanOrEqual(1);
  });

  it("5. add → search → prune → search lifecycle", async () => {
    const addResult = await memoryAdd(inst.db, {
      content: "Ephemeral test memory for lifecycle validation XYZ123",
      scope: "e2e-test",
      tags: ["ephemeral", "lifecycle"],
      importance: 0.1,
    });
    expect(addResult.id).toBeDefined();

    const found = await memorySearch(inst.db, {
      query: "Ephemeral lifecycle XYZ123",
      scope: "e2e-test",
      limit: 5,
    });
    expect(found.length).toBeGreaterThan(0);

    // Prune it (set created_at far in the past first)
    inst.db.prepare(
      "UPDATE memories SET created_at = ?, access_count = 0 WHERE id = ?"
    ).run("2020-01-01T00:00:00.000Z", addResult.id);

    const pruneResult = memoryPrune(inst.db, {
      olderThanDays: 1,
      minAccessCount: 0,
      scope: "e2e-test",
      dryRun: false,
    });
    expect(pruneResult.pruned).toBeGreaterThanOrEqual(1);

    const notFound = await memorySearch(inst.db, {
      query: "Ephemeral lifecycle XYZ123",
      scope: "e2e-test",
      limit: 5,
    });
    const stillThere = notFound.some(
      (r) => r.id === addResult.id
    );
    expect(stillThere).toBe(false);
  });

  it("6. health tool reports no integrity issues", () => {
    const health = memoryHealth(inst.db);

    expect(health.orphanedMemories).toBe(0);
    expect(health.orphanedVectors).toBe(0);
    expect(health.orphanedFts).toBe(0);
    expect(health.brokenLinks).toBe(0);
    expect(health.totalMemories).toBeGreaterThan(0);
  });
});
