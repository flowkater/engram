import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { memoryAdd } from "../tools/add.js";
import { memoryPromote } from "../tools/promote.js";
import { evaluateSearchGraphQueries } from "./search-graph-eval.js";
import path from "node:path";
import os from "node:os";

vi.mock("../core/embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-search-graph-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("evaluateSearchGraphQueries", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("filters logged queries to those with at least one canonical gold target", async () => {
    const raw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const report = await evaluateSearchGraphQueries(inst.db, [
      { tool: "memory.search", query: "jwt auth", scope: "todait-backend", timestamp: "2026-03-13T00:00:00.000Z" },
      { tool: "memory.search", query: "jwt auth", scope: "other-project", timestamp: "2026-03-13T00:00:00.000Z" },
    ]);

    expect(report.queriesConsidered).toBe(2);
    expect(report.queriesEvaluated).toBe(1);
  });

  it("reports hit@k, MRR, and top-1 precision for baseline and graph search", async () => {
    const raw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const report = await evaluateSearchGraphQueries(inst.db, [
      { tool: "memory.search", query: "jwt auth", scope: "todait-backend", timestamp: "2026-03-13T00:00:00.000Z" },
    ]);

    expect(report.baseline.hitAtK).toBeGreaterThanOrEqual(0);
    expect(report.graph.hitAtK).toBeGreaterThanOrEqual(0);
    expect(report.graph.mrr).toBeGreaterThanOrEqual(0);
    expect(report.graph.top1Precision).toBeGreaterThanOrEqual(0);
  });

  it("uses asOf when resolving canonical gold targets", async () => {
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

    const report = await evaluateSearchGraphQueries(inst.db, [
      {
        tool: "memory.search",
        query: "authentication",
        scope: "todait-backend",
        asOf: "2026-02-01T00:00:00.000Z",
        timestamp: "2026-03-13T00:00:00.000Z",
      },
    ]);

    expect(report.queriesEvaluated).toBe(1);
    expect(report.baseline.hitAtK).toBe(1);
  });
});
