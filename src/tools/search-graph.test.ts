import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryAdd } from "./add.js";
import { memoryPromote } from "./promote.js";
import { memorySearchGraph } from "./search-graph.js";
import path from "node:path";
import os from "node:os";

vi.mock("../core/embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-search-graph-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("memory.search_graph", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("returns canonical-only ranked results plus graph payload", async () => {
    const raw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      source: "manual",
    });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const result = await memorySearchGraph(inst.db, {
      query: "jwt auth",
      scope: "todait-backend",
      limit: 5,
      hopDepth: 1,
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((item) => item.isCanonical === true)).toBe(true);
    expect(result.graph.nodes.length).toBeGreaterThan(0);
    expect(result.graph.meta.hopDepth).toBe(1);
    expect(result.graph.meta.seedCount).toBeGreaterThan(0);
  });

  it("passes asOf and hopDepth through to the core response meta", async () => {
    const raw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      validFrom: "2026-03-01T00:00:00.000Z",
    });

    const result = await memorySearchGraph(inst.db, {
      query: "auth mechanism",
      scope: "todait-backend",
      asOf: "2026-04-01T00:00:00.000Z",
      hopDepth: 2,
    });

    expect(result.graph.meta.hopDepth).toBe(2);
  });
});
