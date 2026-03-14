import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { memoryAdd } from "../tools/add.js";
import { memoryPromote } from "../tools/promote.js";
import { runGraphSearch } from "./search-graph.js";
import path from "node:path";
import os from "node:os";

vi.mock("../core/embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-search-graph-core-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("runGraphSearch", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("uses canonical seeds and returns canonical-only ranked results", async () => {
    const raw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const result = await runGraphSearch(inst.db, { query: "jwt auth", scope: "todait-backend", limit: 5, hopDepth: 1 });
    expect(result.results.every((row) => row.isCanonical === true)).toBe(true);
    expect(result.graph.meta.seedCount).toBeGreaterThan(0);
  });

  it("sets hasConflict when contradiction edges are expanded", async () => {
    const oldRaw = await memoryAdd(inst.db, { content: "Authentication uses cookie sessions.", scope: "todait-backend" });
    const newRaw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    const oldCanon = await memoryPromote(inst.db, {
      memoryIds: [oldRaw.id],
      kind: "fact",
      title: "Old auth",
      content: "Authentication uses cookie sessions.",
      scope: "todait-backend",
    });
    await memoryPromote(inst.db, {
      memoryIds: [newRaw.id],
      kind: "fact",
      title: "Current auth",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      contradicts: [oldCanon.canonicalId],
    });

    const result = await runGraphSearch(inst.db, { query: "authentication", scope: "todait-backend", limit: 5, hopDepth: 1 });
    expect(result.results.some((row) => row.hasConflict)).toBe(true);
    expect(result.graph.edges.some((edge) => edge.type === "contradicts")).toBe(true);
  });

  it("adds raw evidence only to graph payload after expansion", async () => {
    const raw = await memoryAdd(inst.db, { content: "Procedure note: rotate JWT signing keys monthly.", scope: "todait-backend" });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "decision",
      title: "JWT signing key rotation",
      content: "JWT signing keys rotate monthly.",
      scope: "todait-backend",
    });

    const result = await runGraphSearch(inst.db, { query: "signing keys", scope: "todait-backend", limit: 5, hopDepth: 1 });
    expect(result.results.every((row) => row.kind !== ("raw" as never))).toBe(true);
    expect(result.graph.nodes.some((node) => node.kind === "raw")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.type === "canonical_evidence")).toBe(true);
  });

  it("honors asOf and prefers current canonical truth over superseded truth", async () => {
    const oldRaw = await memoryAdd(inst.db, { content: "Authentication uses cookie sessions.", scope: "todait-backend" });
    const newRaw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    const oldCanon = await memoryPromote(inst.db, {
      memoryIds: [oldRaw.id],
      kind: "fact",
      title: "Old auth",
      content: "Authentication uses cookie sessions.",
      scope: "todait-backend",
      validFrom: "2026-01-01T00:00:00.000Z",
    });
    await memoryPromote(inst.db, {
      memoryIds: [newRaw.id],
      kind: "fact",
      title: "Current auth",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      validFrom: "2026-03-01T00:00:00.000Z",
      supersedes: [oldCanon.canonicalId],
    });

    const february = await runGraphSearch(inst.db, {
      query: "authentication",
      scope: "todait-backend",
      asOf: "2026-02-01T00:00:00.000Z",
      limit: 5,
      hopDepth: 1,
    });
    const april = await runGraphSearch(inst.db, {
      query: "authentication",
      scope: "todait-backend",
      asOf: "2026-04-01T00:00:00.000Z",
      limit: 5,
      hopDepth: 1,
    });

    expect(february.results[0].content).toContain("cookie sessions");
    expect(april.results[0].content).toContain("JWT access tokens");
  });

  it("fills graph.meta with the agreed debug fields", async () => {
    const raw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const result = await runGraphSearch(inst.db, { query: "jwt auth", scope: "todait-backend", limit: 5, hopDepth: 1 });
    expect(result.graph.meta.seedCount).toBeGreaterThan(0);
    expect(result.graph.meta.expandedNodeCount).toBeGreaterThanOrEqual(0);
    expect(result.graph.meta.rerankVersion).toBe("v1");
  });
});
