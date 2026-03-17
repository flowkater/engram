import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase } from "./database.js";
import { memoryAdd } from "../tools/add.js";
import {
  addCanonicalEdge,
  appendCanonicalEvidence,
  createCanonicalMemory,
  getCanonicalMemory,
  listNearbyCanonicalMemories,
  listCanonicalEvidence,
  mergeCanonicalMemories,
  mergeCandidateIntoCanonical,
  removeCanonicalSearchArtifacts,
  replaceCanonicalSearchArtifacts,
  updateCanonicalMemory,
} from "./canonical-memory.js";
import path from "node:path";
import os from "node:os";

vi.mock("./embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-canonical-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function getSchemaObjects(db: ReturnType<typeof openDatabase>["db"]): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
  ).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe("canonical memory schema", () => {
  let inst: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("creates canonical tables and indexes", () => {
    const names = getSchemaObjects(inst.db);
    expect(names).toContain("canonical_memories");
    expect(names).toContain("canonical_evidence");
    expect(names).toContain("canonical_edges");
    expect(names).toContain("canonical_memory_fts");
    expect(names).toContain("canonical_memory_vec");
  });

  it("creates a canonical memory with evidence rows", async () => {
    const raw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const canonicalId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      evidenceMemoryIds: [raw.id],
    });

    const canonical = getCanonicalMemory(inst.db, canonicalId);
    const evidence = listCanonicalEvidence(inst.db, canonicalId);

    expect(canonical?.kind).toBe("fact");
    expect(evidence).toHaveLength(1);
    expect(evidence[0].memory_id).toBe(raw.id);
  });

  it("adds a supersedes edge and closes predecessor validity", () => {
    const olderId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Old auth mechanism",
      content: "Authentication used cookie sessions.",
      scope: "todait-backend",
      evidenceMemoryIds: [],
    });

    const newerId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      evidenceMemoryIds: [],
      validFrom: "2026-03-12T00:00:00.000Z",
    });

    addCanonicalEdge(inst.db, {
      fromId: newerId,
      toId: olderId,
      relationType: "supersedes",
    });

    const older = getCanonicalMemory(inst.db, olderId);
    expect(older?.valid_to).toBe("2026-03-12T00:00:00.000Z");
  });

  it("updates canonical text and confidence while preserving metadata", () => {
    const canonicalId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Old title",
      content: "Old content",
      scope: "todait-backend",
      importance: 0.9,
      confidence: 0.4,
      validFrom: "2026-03-10T00:00:00.000Z",
      validTo: "2026-03-20T00:00:00.000Z",
      decidedAt: "2026-03-11T00:00:00.000Z",
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
      evidenceMemoryIds: [],
    });

    updateCanonicalMemory(inst.db, {
      id: canonicalId,
      title: "New title",
      content: "New content",
      confidence: 0.88,
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    const row = getCanonicalMemory(inst.db, canonicalId);
    expect(row).toMatchObject({
      id: canonicalId,
      kind: "fact",
      title: "New title",
      content: "New content",
      scope: "todait-backend",
      importance: 0.9,
      confidence: 0.88,
      valid_from: "2026-03-10T00:00:00.000Z",
      valid_to: "2026-03-20T00:00:00.000Z",
      decided_at: "2026-03-11T00:00:00.000Z",
      created_at: "2026-03-12T00:00:00.000Z",
      updated_at: "2026-03-15T00:00:00.000Z",
    });
  });

  it("appends canonical evidence idempotently using the canonical kind role", async () => {
    const raw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });
    const canonicalId = createCanonicalMemory(inst.db, {
      kind: "decision",
      title: "JWT rollout approved",
      content: "The team decided to roll out JWT auth.",
      scope: "todait-backend",
      evidenceMemoryIds: [],
    });

    appendCanonicalEvidence(
      inst.db,
      canonicalId,
      "decision",
      [raw.id, raw.id],
      "2026-03-15T00:00:00.000Z"
    );

    const evidence = listCanonicalEvidence(inst.db, canonicalId);
    expect(evidence).toEqual([
      expect.objectContaining({
        canonical_id: canonicalId,
        memory_id: raw.id,
        evidence_role: "decision-context",
      }),
    ]);
  });

  it("replaces canonical search artifacts instead of appending", () => {
    const canonicalId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      evidenceMemoryIds: [],
    });

    replaceCanonicalSearchArtifacts(inst.db, {
      id: canonicalId,
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      embedding: new Float32Array(768).fill(0.1),
    });
    replaceCanonicalSearchArtifacts(inst.db, {
      id: canonicalId,
      title: "Auth uses JWT v2",
      content: "Authentication uses refreshed JWT access tokens.",
      scope: "todait-backend",
      embedding: new Float32Array(768).fill(0.2),
    });

    const vecRows = inst.db.prepare(
      "SELECT COUNT(*) as count FROM canonical_memory_vec WHERE id = ?"
    ).get(canonicalId) as { count: number };
    const ftsRows = inst.db.prepare(
      "SELECT title, content FROM canonical_memory_fts WHERE id = ?"
    ).get(canonicalId) as { title: string; content: string };

    expect(vecRows.count).toBe(1);
    expect(ftsRows).toMatchObject({
      title: "Auth uses JWT v2",
      content: "Authentication uses refreshed JWT access tokens.",
    });
  });

  it("removes canonical search artifacts without deleting the canonical row", () => {
    const canonicalId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      evidenceMemoryIds: [],
    });
    replaceCanonicalSearchArtifacts(inst.db, {
      id: canonicalId,
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      embedding: new Float32Array(768).fill(0.1),
    });

    removeCanonicalSearchArtifacts(inst.db, canonicalId);

    const vecCount = inst.db.prepare(
      "SELECT COUNT(*) as count FROM canonical_memory_vec WHERE id = ?"
    ).get(canonicalId) as { count: number };
    const ftsCount = inst.db.prepare(
      "SELECT COUNT(*) as count FROM canonical_memory_fts WHERE id = ?"
    ).get(canonicalId) as { count: number };
    expect(getCanonicalMemory(inst.db, canonicalId)?.id).toBe(canonicalId);
    expect(vecCount.count).toBe(0);
    expect(ftsCount.count).toBe(0);
  });

  it("merges candidate updates into an existing canonical and refreshes evidence/artifacts", async () => {
    const raw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens and rotates them daily.",
      scope: "todait-backend",
    });
    const canonicalId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      confidence: 0.5,
      evidenceMemoryIds: [],
    });

    mergeCandidateIntoCanonical(inst.db, {
      canonicalId,
      title: "Auth uses rotating JWT",
      content: "Authentication uses JWT access tokens and rotates them daily.",
      confidence: 0.92,
      evidenceMemoryIds: [raw.id],
      embedding: new Float32Array(768).fill(0.3),
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    const row = getCanonicalMemory(inst.db, canonicalId);
    const evidence = listCanonicalEvidence(inst.db, canonicalId);
    const ftsRow = inst.db.prepare(
      "SELECT title, content FROM canonical_memory_fts WHERE id = ?"
    ).get(canonicalId) as { title: string; content: string };

    expect(row).toMatchObject({
      title: "Auth uses rotating JWT",
      content: "Authentication uses JWT access tokens and rotates them daily.",
      confidence: 0.92,
      updated_at: "2026-03-15T00:00:00.000Z",
    });
    expect(evidence.some((item) => item.memory_id === raw.id && item.evidence_role === "source")).toBe(true);
    expect(ftsRow).toMatchObject({
      title: "Auth uses rotating JWT",
      content: "Authentication uses JWT access tokens and rotates them daily.",
    });
  });

  it("merges duplicate canonicals into a primary canonical and removes source search artifacts", async () => {
    const primaryRaw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });
    const duplicateRaw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT tokens.",
      scope: "todait-backend",
    });
    const thirdId = createCanonicalMemory(inst.db, {
      kind: "decision",
      title: "JWT rollout approved",
      content: "The team approved JWT rollout.",
      scope: "todait-backend",
      evidenceMemoryIds: [],
    });
    const sourceId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Old auth duplicate",
      content: "Authentication uses JWT tokens.",
      scope: "todait-backend",
      confidence: 0.9,
      evidenceMemoryIds: [duplicateRaw.id],
    });
    const targetId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Current auth",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      confidence: 0.4,
      evidenceMemoryIds: [primaryRaw.id],
    });
    replaceCanonicalSearchArtifacts(inst.db, {
      id: sourceId,
      title: "Old auth duplicate",
      content: "Authentication uses JWT tokens.",
      scope: "todait-backend",
      embedding: new Float32Array(768).fill(0.1),
    });
    replaceCanonicalSearchArtifacts(inst.db, {
      id: targetId,
      title: "Current auth",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      embedding: new Float32Array(768).fill(0.2),
    });
    addCanonicalEdge(inst.db, {
      fromId: sourceId,
      toId: thirdId,
      relationType: "contradicts",
      createdAt: "2026-03-15T00:00:00.000Z",
    });

    mergeCanonicalMemories(inst.db, {
      sourceCanonicalId: sourceId,
      targetCanonicalId: targetId,
      updatedAt: "2026-03-16T00:00:00.000Z",
    });

    const target = getCanonicalMemory(inst.db, targetId);
    const evidence = listCanonicalEvidence(inst.db, targetId);
    const sourceVecCount = inst.db.prepare(
      "SELECT COUNT(*) as count FROM canonical_memory_vec WHERE id = ?"
    ).get(sourceId) as { count: number };
    const sourceFtsCount = inst.db.prepare(
      "SELECT COUNT(*) as count FROM canonical_memory_fts WHERE id = ?"
    ).get(sourceId) as { count: number };
    const supersedesEdge = inst.db.prepare(`
      SELECT 1
      FROM canonical_edges
      WHERE from_canonical_id = ? AND to_canonical_id = ? AND relation_type = 'supersedes'
    `).get(targetId, sourceId);
    const contradictionEdge = inst.db.prepare(`
      SELECT 1
      FROM canonical_edges
      WHERE from_canonical_id = ? AND to_canonical_id = ? AND relation_type = 'contradicts'
    `).get(targetId, thirdId);

    expect(target?.confidence).toBe(0.9);
    expect(evidence.some((row) => row.memory_id === primaryRaw.id)).toBe(true);
    expect(evidence.some((row) => row.memory_id === duplicateRaw.id)).toBe(true);
    expect(sourceVecCount.count).toBe(0);
    expect(sourceFtsCount.count).toBe(0);
    expect(Boolean(supersedesEdge)).toBe(true);
    expect(Boolean(contradictionEdge)).toBe(true);
  });

  it("does not inherit incoming supersedes edges when merging a duplicate canonical", async () => {
    const sourceId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Auth duplicate",
      content: "Authentication uses JWT tokens.",
      scope: "todait-backend",
      confidence: 0.7,
      evidenceMemoryIds: [],
    });
    const targetId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Auth primary",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      confidence: 0.8,
      evidenceMemoryIds: [],
    });
    const newerId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Auth replacement",
      content: "Authentication uses rotating JWT access tokens.",
      scope: "todait-backend",
      validFrom: "2026-03-20T00:00:00.000Z",
      evidenceMemoryIds: [],
    });

    addCanonicalEdge(inst.db, {
      fromId: newerId,
      toId: sourceId,
      relationType: "supersedes",
      createdAt: "2026-03-21T00:00:00.000Z",
    });

    mergeCanonicalMemories(inst.db, {
      sourceCanonicalId: sourceId,
      targetCanonicalId: targetId,
      updatedAt: "2026-03-22T00:00:00.000Z",
    });

    const target = getCanonicalMemory(inst.db, targetId);
    const inheritedSupersedes = inst.db.prepare(`
      SELECT 1
      FROM canonical_edges
      WHERE from_canonical_id = ? AND to_canonical_id = ? AND relation_type = 'supersedes'
    `).get(newerId, targetId);

    expect(target?.valid_to).toBeNull();
    expect(Boolean(inheritedSupersedes)).toBe(false);
  });

  it("lists nearby active canonical memories by scope, recency, and confidence", () => {
    createCanonicalMemory(inst.db, {
      id: "canon-old",
      kind: "fact",
      title: "Old auth fact",
      content: "Authentication uses cookie sessions.",
      scope: "todait-backend",
      confidence: 0.4,
      createdAt: "2026-03-10T00:00:00.000Z",
      updatedAt: "2026-03-10T00:00:00.000Z",
      evidenceMemoryIds: [],
    });
    createCanonicalMemory(inst.db, {
      id: "canon-current",
      kind: "fact",
      title: "Current auth fact",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      confidence: 0.9,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
      evidenceMemoryIds: [],
    });
    createCanonicalMemory(inst.db, {
      id: "canon-future",
      kind: "fact",
      title: "Future auth fact",
      content: "Authentication will use passkeys.",
      scope: "todait-backend",
      confidence: 1,
      validFrom: "2026-04-01T00:00:00.000Z",
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
      evidenceMemoryIds: [],
    });
    createCanonicalMemory(inst.db, {
      id: "canon-inactive",
      kind: "fact",
      title: "Inactive auth fact",
      content: "Authentication used signed cookies.",
      scope: "todait-backend",
      confidence: 0.8,
      validTo: "2026-03-01T00:00:00.000Z",
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
      evidenceMemoryIds: [],
    });
    createCanonicalMemory(inst.db, {
      id: "canon-other-scope",
      kind: "fact",
      title: "Other scope fact",
      content: "iOS app uses Face ID.",
      scope: "todait-ios",
      confidence: 0.95,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
      evidenceMemoryIds: [],
    });

    const rows = listNearbyCanonicalMemories(
      inst.db,
      "todait-backend",
      2,
      "2026-03-15T12:00:00.000Z"
    );

    expect(rows.map((row) => row.id)).toEqual(["canon-current", "canon-old"]);
  });

  it("rolls back canonical row, evidence, vec, and fts changes together inside a surrounding transaction", async () => {
    const raw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });
    const canonicalId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      confidence: 0.5,
      evidenceMemoryIds: [],
    });
    replaceCanonicalSearchArtifacts(inst.db, {
      id: canonicalId,
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      embedding: new Float32Array(768).fill(0.1),
    });

    expect(() => {
      inst.db.transaction(() => {
        mergeCandidateIntoCanonical(inst.db, {
          canonicalId,
          title: "Auth uses rotating JWT",
          content: "Authentication uses JWT access tokens and rotates them daily.",
          confidence: 0.92,
          evidenceMemoryIds: [raw.id],
          embedding: new Float32Array(768).fill(0.3),
          updatedAt: "2026-03-15T00:00:00.000Z",
        });
        throw new Error("force rollback");
      })();
    }).toThrow("force rollback");

    const row = getCanonicalMemory(inst.db, canonicalId);
    const evidence = listCanonicalEvidence(inst.db, canonicalId);
    const vecRows = inst.db.prepare(
      "SELECT COUNT(*) as count FROM canonical_memory_vec WHERE id = ?"
    ).get(canonicalId) as { count: number };
    const ftsRow = inst.db.prepare(
      "SELECT title, content FROM canonical_memory_fts WHERE id = ?"
    ).get(canonicalId) as { title: string; content: string };

    expect(row).toMatchObject({
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      confidence: 0.5,
    });
    expect(evidence).toHaveLength(0);
    expect(vecRows.count).toBe(1);
    expect(ftsRow).toMatchObject({
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
    });
  });
});
