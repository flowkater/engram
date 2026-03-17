import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { openDatabase, type DatabaseInstance } from "./database.js";
import {
  CANONICAL_CANDIDATE_LEASE_MS,
  enqueueCanonicalCandidate,
  markCanonicalCandidateProcessing,
} from "./canonical-candidates.js";
import { createCanonicalMemory, getCanonicalMemory, listCanonicalEvidence } from "./canonical-memory.js";

vi.mock("./embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-candidate-worker-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function waitFor(predicate: () => boolean, timeoutMs = 1500, intervalMs = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function insertRawMemory(
  db: DatabaseInstance["db"],
  id: string,
  content: string,
  scope = "todait-backend"
): void {
  const now = "2026-03-15T00:00:00.000Z";
  db.prepare(`
    INSERT INTO memories (
      id, content, summary, source, scope, tags, importance, created_at, updated_at, deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, content, null, "manual", scope, "[]", 0.5, now, now);
}

describe("canonical candidate worker", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("approves a queued candidate into a new canonical memory", async () => {
    insertRawMemory(inst.db, "raw-create", "Authentication uses JWT access tokens.");
    const candidate = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: "raw-create",
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses JWT",
      candidateContent: "Authentication uses JWT access tokens.",
      priorityScore: 1,
      contentFingerprint: "fp-create",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    const { startCanonicalCandidateWorker } = await import("./canonical-candidate-worker.js");
    const worker = startCanonicalCandidateWorker(inst.db, {
      pollMs: 10,
      judgeCandidate: async () => ({
        action: "approve",
        canonicalKind: "fact",
        title: "Auth uses JWT",
        content: "Authentication uses JWT access tokens.",
        confidence: 0.91,
        rationale: "Clear factual statement",
      }),
      embedCanonical: async () => new Float32Array(768).fill(0.1),
    });

    await waitFor(() => {
      const row = inst.db.prepare("SELECT status FROM canonical_candidates WHERE id = ?").get(candidate.id) as { status: string } | undefined;
      return row?.status === "approved";
    });

    const candidateRow = inst.db.prepare(
      "SELECT status FROM canonical_candidates WHERE id = ?"
    ).get(candidate.id) as { status: string };
    const canonicalRows = inst.db.prepare(
      "SELECT id FROM canonical_memories WHERE title = ?"
    ).all("Auth uses JWT") as Array<{ id: string }>;

    expect(candidateRow.status).toBe("approved");
    expect(canonicalRows).toHaveLength(1);
    expect(listCanonicalEvidence(inst.db, canonicalRows[0].id).some((row) => row.memory_id === "raw-create")).toBe(true);

    await worker.stop();
  });

  it("merges into a matched canonical and appends evidence", async () => {
    insertRawMemory(inst.db, "raw-merge", "Authentication uses JWT access tokens and rotates them daily.");
    const candidate = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: "raw-merge",
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses rotating JWT",
      candidateContent: "Authentication uses JWT access tokens and rotates them daily.",
      priorityScore: 1,
      contentFingerprint: "fp-merge",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    const canonicalId = createCanonicalMemory(inst.db, {
      id: "canon-merge",
      kind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      evidenceMemoryIds: [],
    });

    const { startCanonicalCandidateWorker } = await import("./canonical-candidate-worker.js");
    const worker = startCanonicalCandidateWorker(inst.db, {
      pollMs: 10,
      judgeCandidate: async () => ({
        action: "approve",
        canonicalKind: "fact",
        title: "Auth uses rotating JWT",
        content: "Authentication uses JWT access tokens and rotates them daily.",
        confidence: 0.95,
        rationale: "Merged factual update",
        matchedCanonicalId: canonicalId,
      }),
      embedCanonical: async () => new Float32Array(768).fill(0.2),
    });

    await waitFor(() => {
      const row = inst.db.prepare("SELECT status FROM canonical_candidates WHERE id = ?").get(candidate.id) as { status: string } | undefined;
      return row?.status === "merged";
    });

    const canonical = getCanonicalMemory(inst.db, canonicalId);
    expect(canonical).toMatchObject({
      title: "Auth uses rotating JWT",
      content: "Authentication uses JWT access tokens and rotates them daily.",
      confidence: 0.95,
    });
    expect(listCanonicalEvidence(inst.db, canonicalId).some((row) => row.memory_id === "raw-merge")).toBe(true);

    await worker.stop();
  });

  it("stores reject rationale and leaves canonical tables untouched", async () => {
    insertRawMemory(inst.db, "raw-reject", "Need to think more about auth.");
    const candidate = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: "raw-reject",
      scope: "todait-backend",
      candidateKind: "unknown",
      candidateTitle: "Auth note",
      candidateContent: "Need to think more about auth.",
      priorityScore: 1,
      contentFingerprint: "fp-reject",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    const { startCanonicalCandidateWorker } = await import("./canonical-candidate-worker.js");
    const worker = startCanonicalCandidateWorker(inst.db, {
      pollMs: 10,
      judgeCandidate: async () => ({
        action: "reject",
        confidence: 0.11,
        rationale: "Not enough evidence",
      }),
      embedCanonical: async () => new Float32Array(768).fill(0.3),
    });

    await waitFor(() => {
      const row = inst.db.prepare("SELECT status FROM canonical_candidates WHERE id = ?").get(candidate.id) as { status: string } | undefined;
      return row?.status === "rejected";
    });

    const candidateRow = inst.db.prepare(
      "SELECT status, rationale FROM canonical_candidates WHERE id = ?"
    ).get(candidate.id) as { status: string; rationale: string };
    const canonicalCount = inst.db.prepare(
      "SELECT COUNT(*) as count FROM canonical_memories"
    ).get() as { count: number };

    expect(candidateRow).toMatchObject({
      status: "rejected",
      rationale: "Not enough evidence",
    });
    expect(canonicalCount.count).toBe(0);

    await worker.stop();
  });

  it("requeues transient judge failures without mutating canonical tables", async () => {
    insertRawMemory(inst.db, "raw-retry", "Authentication uses JWT access tokens.");
    const candidate = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: "raw-retry",
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses JWT",
      candidateContent: "Authentication uses JWT access tokens.",
      priorityScore: 1,
      contentFingerprint: "fp-retry",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    const { startCanonicalCandidateWorker } = await import("./canonical-candidate-worker.js");
    const worker = startCanonicalCandidateWorker(inst.db, {
      pollMs: 10,
      judgeCandidate: async () => ({
        action: "retry",
        reason: "connection",
        rationale: "Local Ollama judge failed",
      }),
      embedCanonical: async () => new Float32Array(768).fill(0.1),
    });

    await waitFor(() => {
      const row = inst.db.prepare("SELECT retry_count FROM canonical_candidates WHERE id = ?").get(candidate.id) as { retry_count: number } | undefined;
      return (row?.retry_count ?? 0) >= 1;
    });

    const candidateRow = inst.db.prepare(
      "SELECT status, retry_count FROM canonical_candidates WHERE id = ?"
    ).get(candidate.id) as { status: string; retry_count: number };
    const canonicalCount = inst.db.prepare(
      "SELECT COUNT(*) as count FROM canonical_memories"
    ).get() as { count: number };

    expect(candidateRow.status).toBe("queued");
    expect(candidateRow.retry_count).toBeGreaterThanOrEqual(1);
    expect(canonicalCount.count).toBe(0);

    await worker.stop();
  });

  it("requeues approved candidates when embedding fails", async () => {
    insertRawMemory(inst.db, "raw-embed-fail", "Authentication uses JWT access tokens.");
    const candidate = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: "raw-embed-fail",
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses JWT",
      candidateContent: "Authentication uses JWT access tokens.",
      priorityScore: 1,
      contentFingerprint: "fp-embed-fail",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    const { startCanonicalCandidateWorker } = await import("./canonical-candidate-worker.js");
    const worker = startCanonicalCandidateWorker(inst.db, {
      pollMs: 10,
      judgeCandidate: async () => ({
        action: "approve",
        canonicalKind: "fact",
        title: "Auth uses JWT",
        content: "Authentication uses JWT access tokens.",
        confidence: 0.91,
        rationale: "Clear factual statement",
      }),
      embedCanonical: async () => {
        throw new Error("embedding unavailable");
      },
    });

    await waitFor(() => {
      const row = inst.db.prepare("SELECT retry_count FROM canonical_candidates WHERE id = ?").get(candidate.id) as { retry_count: number } | undefined;
      return (row?.retry_count ?? 0) >= 1;
    });

    const candidateRow = inst.db.prepare(
      "SELECT status, retry_count FROM canonical_candidates WHERE id = ?"
    ).get(candidate.id) as { status: string; retry_count: number };
    const canonicalCount = inst.db.prepare(
      "SELECT COUNT(*) as count FROM canonical_memories"
    ).get() as { count: number };

    expect(candidateRow.status).toBe("queued");
    expect(candidateRow.retry_count).toBeGreaterThanOrEqual(1);
    expect(canonicalCount.count).toBe(0);

    await worker.stop();
  });

  it("reclaims stale processing rows on startup and processes them once", async () => {
    insertRawMemory(inst.db, "raw-stale", "Authentication uses JWT access tokens.");
    const candidate = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: "raw-stale",
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses JWT",
      candidateContent: "Authentication uses JWT access tokens.",
      priorityScore: 1,
      contentFingerprint: "fp-stale",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    markCanonicalCandidateProcessing(inst.db, candidate.id, "2026-03-15T00:00:00.000Z");

    const { startCanonicalCandidateWorker } = await import("./canonical-candidate-worker.js");
    let judgeCalls = 0;
    const worker = startCanonicalCandidateWorker(inst.db, {
      pollMs: 10,
      now: () => new Date(Date.parse("2026-03-15T00:00:00.000Z") + CANONICAL_CANDIDATE_LEASE_MS + 5).toISOString(),
      judgeCandidate: async () => {
        judgeCalls += 1;
        return {
          action: "approve" as const,
          canonicalKind: "fact" as const,
          title: "Auth uses JWT",
          content: "Authentication uses JWT access tokens.",
          confidence: 0.91,
          rationale: "Clear factual statement",
        };
      },
      embedCanonical: async () => new Float32Array(768).fill(0.1),
    });

    await waitFor(() => {
      const row = inst.db.prepare("SELECT status FROM canonical_candidates WHERE id = ?").get(candidate.id) as { status: string } | undefined;
      return row?.status === "approved";
    });

    expect(judgeCalls).toBe(1);
    await worker.stop();
  });

  it("does not steal fresh processing rows that are still inside the lease", async () => {
    insertRawMemory(inst.db, "raw-fresh", "Authentication uses JWT access tokens.");
    const candidate = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: "raw-fresh",
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses JWT",
      candidateContent: "Authentication uses JWT access tokens.",
      priorityScore: 1,
      contentFingerprint: "fp-fresh",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    markCanonicalCandidateProcessing(inst.db, candidate.id, "2026-03-15T00:00:20.000Z");

    const { startCanonicalCandidateWorker } = await import("./canonical-candidate-worker.js");
    const worker = startCanonicalCandidateWorker(inst.db, {
      pollMs: 10,
      now: () => new Date(Date.parse("2026-03-15T00:00:20.000Z") + CANONICAL_CANDIDATE_LEASE_MS - 5).toISOString(),
      judgeCandidate: async () => ({
        action: "approve",
        canonicalKind: "fact",
        title: "Auth uses JWT",
        content: "Authentication uses JWT access tokens.",
        confidence: 0.91,
        rationale: "Clear factual statement",
      }),
      embedCanonical: async () => new Float32Array(768).fill(0.1),
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    const candidateRow = inst.db.prepare(
      "SELECT status FROM canonical_candidates WHERE id = ?"
    ).get(candidate.id) as { status: string };
    const canonicalCount = inst.db.prepare(
      "SELECT COUNT(*) as count FROM canonical_memories"
    ).get() as { count: number };

    expect(candidateRow.status).toBe("processing");
    expect(canonicalCount.count).toBe(0);

    await worker.stop();
  });
});
