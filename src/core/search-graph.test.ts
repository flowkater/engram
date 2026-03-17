import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { memoryAdd } from "../tools/add.js";
import { memoryPromote } from "../tools/promote.js";
import { runGraphSearch } from "./search-graph.js";
import {
  markCanonicalCandidateProcessing,
  markCanonicalCandidateRejected,
} from "./canonical-candidates.js";
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

  it("returns confirmed canonicals separately from candidate rows", async () => {
    const canonicalRaw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    const candidateRaw = await memoryAdd(inst.db, { content: "Auth rollout note pending review.", scope: "todait-backend" });
    await memoryPromote(inst.db, {
      memoryIds: [canonicalRaw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });
    const candidateRow = inst.db.prepare(`
      SELECT id
      FROM canonical_candidates
      WHERE raw_memory_id = ?
    `).get(candidateRaw.id) as { id: string };
    markCanonicalCandidateProcessing(inst.db, candidateRow.id, "2026-03-15T00:00:00.000Z");
    markCanonicalCandidateRejected(inst.db, {
      id: candidateRow.id,
      confidence: 0.2,
      rationale: "Needs stronger evidence",
      matchedCanonicalId: null,
      now: "2026-03-15T00:01:00.000Z",
    });

    const result = await runGraphSearch(inst.db, { query: "jwt auth", scope: "todait-backend", limit: 5, hopDepth: 1 });
    expect(result.confirmed.every((row) => row.isCanonical === true)).toBe(true);
    expect(result.candidates.some((row) => row.rawMemoryId === candidateRaw.id)).toBe(true);
    expect(result.candidates.some((row) => row.rationale === "Needs stronger evidence")).toBe(true);
    expect(result.graph.meta.seedCount).toBeGreaterThan(0);
  });

  it("filters candidate rows to those relevant to the active query", async () => {
    await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });
    await memoryAdd(inst.db, {
      content: "Billing invoices are reconciled monthly.",
      scope: "todait-backend",
    });

    const result = await runGraphSearch(inst.db, {
      query: "jwt auth",
      scope: "todait-backend",
      limit: 5,
      hopDepth: 1,
    });

    expect(result.candidates.some((row) => row.content.includes("JWT"))).toBe(true);
    expect(result.candidates.some((row) => row.content.includes("Billing invoices"))).toBe(false);
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
    expect(result.confirmed.some((row) => row.hasConflict)).toBe(true);
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
    expect(result.confirmed.every((row) => row.kind !== ("raw" as never))).toBe(true);
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

    expect(february.confirmed[0].content).toContain("cookie sessions");
    expect(april.confirmed[0].content).toContain("JWT access tokens");
  });

  it("hides superseded duplicates from confirmed results while keeping them in the graph", async () => {
    const olderRaw = await memoryAdd(inst.db, {
      content: "Authentication uses cookie sessions.",
      scope: "todait-backend",
    });
    const newerRaw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });
    const olderCanon = await memoryPromote(inst.db, {
      memoryIds: [olderRaw.id],
      kind: "fact",
      title: "Auth mechanism v1",
      content: "Authentication uses cookie sessions.",
      scope: "todait-backend",
      validFrom: "2026-01-01T00:00:00.000Z",
    });
    const newerCanon = await memoryPromote(inst.db, {
      memoryIds: [newerRaw.id],
      kind: "fact",
      title: "Auth mechanism v2",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      validFrom: "2026-03-01T00:00:00.000Z",
      supersedes: [olderCanon.canonicalId],
    });

    const result = await runGraphSearch(inst.db, {
      query: "auth mechanism",
      scope: "todait-backend",
      limit: 5,
      hopDepth: 1,
    });

    expect(result.confirmed.some((row) => row.id === newerCanon.canonicalId)).toBe(true);
    expect(result.confirmed.some((row) => row.id === olderCanon.canonicalId)).toBe(false);
    expect(result.graph.nodes.some((node) => node.id === olderCanon.canonicalId)).toBe(true);
  });

  it("keeps superseded canonicals in confirmed results for explicit version queries", async () => {
    const v5Raw = await memoryAdd(inst.db, {
      content: "Todait API Server PRD v5 defines the older API server scope.",
      scope: "project/todait-backend-v2",
    });
    const v7Raw = await memoryAdd(inst.db, {
      content: "Todait API Server PRD v7 defines the current API server scope.",
      scope: "project/todait-backend-v2",
    });
    const v5 = await memoryPromote(inst.db, {
      memoryIds: [v5Raw.id],
      kind: "decision",
      title: "Todait API Server PRD v5",
      content: "Todait API Server PRD v5 defines the older API server scope.",
      scope: "project/todait-backend-v2",
      validFrom: "2026-01-01T00:00:00.000Z",
    });
    await memoryPromote(inst.db, {
      memoryIds: [v7Raw.id],
      kind: "decision",
      title: "Todait API Server PRD v7",
      content: "Todait API Server PRD v7 defines the current API server scope.",
      scope: "project/todait-backend-v2",
      validFrom: "2026-03-01T00:00:00.000Z",
      supersedes: [v5.canonicalId],
    });

    const explicitVersion = await runGraphSearch(inst.db, {
      query: "Todait API Server PRD v5",
      scope: "project/todait-backend-v2",
      limit: 5,
      hopDepth: 1,
    });

    expect(explicitVersion.confirmed.some((row) => row.id === v5.canonicalId)).toBe(true);
  });

  it("boosts stronger title overlap during canonical-first seed selection", async () => {
    const broadRaw = await memoryAdd(inst.db, {
      content: "The system updates plans and settings.",
      scope: "todait-ios",
    });
    const exactRaw = await memoryAdd(inst.db, {
      content: "Quantity type selector determines range amount and checklist plan modes.",
      scope: "todait-ios",
    });
    await memoryPromote(inst.db, {
      memoryIds: [broadRaw.id],
      kind: "decision",
      title: "Plan settings roadmap",
      content: "The system updates plans and settings.",
      scope: "todait-ios",
    });
    await memoryPromote(inst.db, {
      memoryIds: [exactRaw.id],
      kind: "fact",
      title: "Quantity Type Selector specification",
      content: "Quantity type selector determines range amount and checklist plan modes.",
      scope: "todait-ios",
    });

    const result = await runGraphSearch(inst.db, {
      query: "quantity type selector",
      scope: "todait-ios",
      limit: 5,
      hopDepth: 1,
    });

    expect(result.confirmed[0].summary).toBe("Quantity Type Selector specification");
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
