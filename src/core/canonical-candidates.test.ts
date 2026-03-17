import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { openDatabase } from "./database.js";
import {
  CANONICAL_CANDIDATE_LEASE_MS,
  buildCandidateFingerprint,
  deriveCandidateContent,
  deriveCandidateTitle,
  enqueueCanonicalCandidate,
  inferCandidateKind,
  listQueuedCanonicalCandidates,
  markCanonicalCandidateApproved,
  markCanonicalCandidateMerged,
  markCanonicalCandidateProcessing,
  markCanonicalCandidateRejected,
  reclaimStaleProcessingCandidates,
  requeueCanonicalCandidateAfterTransientFailure,
  scoreCandidatePriority,
  shouldRequeueRejectedCandidate,
} from "./canonical-candidates.js";
import { createCanonicalMemory } from "./canonical-memory.js";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-canonical-candidates-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function insertRawMemory(
  db: ReturnType<typeof openDatabase>["db"],
  overrides: Partial<{
    id: string;
    content: string;
    summary: string | null;
    scope: string;
    tags: string;
    importance: number;
    createdAt: string;
  }> = {}
): string {
  const id = overrides.id ?? `raw-${Math.random().toString(36).slice(2)}`;
  const createdAt = overrides.createdAt ?? "2026-03-15T00:00:00.000Z";
  db.prepare(`
    INSERT INTO memories (
      id, content, summary, source, scope, tags, importance, created_at, updated_at, deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    overrides.content ?? "Default raw content",
    overrides.summary ?? null,
    "manual",
    overrides.scope ?? "global",
    overrides.tags ?? "[]",
    overrides.importance ?? 0.5,
    createdAt,
    createdAt
  );
  return id;
}

describe("canonical candidate helpers", () => {
  let inst: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("builds stable fingerprints regardless of tag order", () => {
    const first = buildCandidateFingerprint({
      content: "Authentication uses JWT.",
      summary: "JWT auth",
      scope: "todait-backend",
      tags: ["auth", "jwt"],
      importance: 0.7,
    });

    const second = buildCandidateFingerprint({
      content: "Authentication uses JWT.",
      summary: "JWT auth",
      scope: "todait-backend",
      tags: ["jwt", "auth"],
      importance: 0.7,
    });

    const third = buildCandidateFingerprint({
      content: "Authentication uses opaque session cookies.",
      summary: "Cookie auth",
      scope: "todait-backend",
      tags: ["auth", "jwt"],
      importance: 0.7,
    });

    expect(first).toBe(second);
    expect(first).not.toBe(third);
  });

  it("derives kind, title, content, and priority from raw memory inputs", () => {
    expect(inferCandidateKind({
      content: "We decided to migrate auth from cookies to JWT.",
      tags: ["decision", "auth"],
    })).toBe("decision");
    expect(inferCandidateKind({
      content: "Authentication uses JWT access tokens.",
      tags: ["auth"],
    })).toBe("fact");
    expect(inferCandidateKind({
      content: "Need to think more about auth.",
      tags: [],
    })).toBe("unknown");

    expect(deriveCandidateTitle({
      content: "Authentication uses JWT access tokens. Tokens are rotated daily.",
      summary: "JWT auth uses access tokens",
    })).toBe("JWT auth uses access tokens");
    expect(deriveCandidateTitle({
      content: "Authentication uses JWT access tokens. Tokens are rotated daily.",
    })).toBe("Authentication uses JWT access tokens.");

    expect(deriveCandidateContent({
      content: "Authentication uses JWT access tokens.",
      summary: "JWT auth uses access tokens",
    })).toBe("Authentication uses JWT access tokens.");

    expect(scoreCandidatePriority({
      content: "We decided to migrate auth from cookies to JWT.",
      summary: "JWT auth decision",
      tags: ["decision", "auth"],
      importance: 0.9,
    })).toBeGreaterThan(
      scoreCandidatePriority({
        content: "Need to think more about auth.",
        tags: [],
        importance: 0.2,
      })
    );
  });

  it("enqueues a candidate and reuses active duplicates with the same fingerprint", () => {
    const rawMemoryId = insertRawMemory(inst.db, { scope: "todait-backend" });

    const first = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses JWT",
      candidateContent: "Authentication uses JWT access tokens.",
      priorityScore: 0.9,
      contentFingerprint: "fp-auth-jwt",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    const second = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses JWT",
      candidateContent: "Authentication uses JWT access tokens.",
      priorityScore: 0.9,
      contentFingerprint: "fp-auth-jwt",
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z",
    });

    const rows = inst.db.prepare(`
      SELECT id, status, created_at
      FROM canonical_candidates
      WHERE raw_memory_id = ?
      ORDER BY created_at ASC
    `).all(rawMemoryId) as Array<{ id: string; status: string; created_at: string }>;

    expect(rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(rows[0]).toMatchObject({
      id: first.id,
      status: "queued",
      created_at: "2026-03-15T00:00:00.000Z",
    });
  });

  it("requeues after reject only when the fingerprint changes", () => {
    const rawMemoryId = insertRawMemory(inst.db, { scope: "todait-backend" });

    const original = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "todait-backend",
      candidateKind: "unknown",
      candidateTitle: "Auth note",
      candidateContent: "Auth approach still unclear.",
      priorityScore: 0.2,
      contentFingerprint: "fp-auth-note",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    markCanonicalCandidateRejected(inst.db, {
      id: original.id,
      confidence: 0.1,
      rationale: "Insufficient evidence",
      matchedCanonicalId: null,
      now: "2026-03-15T01:00:00.000Z",
    });

    const unchanged = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "todait-backend",
      candidateKind: "unknown",
      candidateTitle: "Auth note",
      candidateContent: "Auth approach still unclear.",
      priorityScore: 0.2,
      contentFingerprint: "fp-auth-note",
      createdAt: "2026-03-15T02:00:00.000Z",
      updatedAt: "2026-03-15T02:00:00.000Z",
    });

    const changed = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses JWT",
      candidateContent: "Authentication uses JWT access tokens.",
      priorityScore: 0.8,
      contentFingerprint: "fp-auth-jwt",
      createdAt: "2026-03-15T03:00:00.000Z",
      updatedAt: "2026-03-15T03:00:00.000Z",
    });

    const rows = inst.db.prepare(`
      SELECT id, status, content_fingerprint, retry_count, created_at
      FROM canonical_candidates
      WHERE raw_memory_id = ?
      ORDER BY created_at ASC
    `).all(rawMemoryId) as Array<{
      id: string;
      status: string;
      content_fingerprint: string;
      retry_count: number;
      created_at: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(unchanged.id).toBe(original.id);
    expect(changed.id).not.toBe(original.id);
    expect(rows[0]).toMatchObject({
      id: original.id,
      status: "rejected",
      content_fingerprint: "fp-auth-note",
      retry_count: 1,
    });
    expect(rows[1]).toMatchObject({
      id: changed.id,
      status: "queued",
      content_fingerprint: "fp-auth-jwt",
      created_at: "2026-03-15T03:00:00.000Z",
    });

    expect(shouldRequeueRejectedCandidate(
      { status: "rejected", contentFingerprint: "fp-auth-note" },
      "fp-auth-note"
    )).toBe(false);
    expect(shouldRequeueRejectedCandidate(
      { status: "rejected", contentFingerprint: "fp-auth-note" },
      "fp-auth-jwt"
    )).toBe(true);
  });

  it("allows changed fingerprints after approved or merged history", () => {
    const matchedCanonicalId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      evidenceMemoryIds: [],
    });
    const rawMemoryId = insertRawMemory(inst.db, { scope: "todait-backend" });

    const approved = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses cookie sessions",
      candidateContent: "Authentication uses cookie sessions.",
      priorityScore: 0.6,
      contentFingerprint: "fp-cookie",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    markCanonicalCandidateApproved(inst.db, {
      id: approved.id,
      candidateKind: "fact",
      candidateTitle: "Auth uses cookie sessions",
      candidateContent: "Authentication uses cookie sessions.",
      confidence: 0.7,
      rationale: "Previously true",
      matchedCanonicalId: null,
      now: "2026-03-15T00:10:00.000Z",
    });

    const sameApproved = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses cookie sessions",
      candidateContent: "Authentication uses cookie sessions.",
      priorityScore: 0.6,
      contentFingerprint: "fp-cookie",
      createdAt: "2026-03-15T00:20:00.000Z",
      updatedAt: "2026-03-15T00:20:00.000Z",
    });
    const changedAfterApproved = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses JWT",
      candidateContent: "Authentication uses JWT access tokens.",
      priorityScore: 0.9,
      contentFingerprint: "fp-jwt",
      createdAt: "2026-03-15T00:30:00.000Z",
      updatedAt: "2026-03-15T00:30:00.000Z",
    });
    markCanonicalCandidateMerged(inst.db, {
      id: changedAfterApproved.id,
      candidateKind: "fact",
      candidateTitle: "Auth uses JWT",
      candidateContent: "Authentication uses JWT access tokens.",
      confidence: 0.91,
      rationale: "Merged into current canonical",
      matchedCanonicalId,
      now: "2026-03-15T00:40:00.000Z",
    });

    const sameMerged = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "todait-backend",
      candidateKind: "fact",
      candidateTitle: "Auth uses JWT",
      candidateContent: "Authentication uses JWT access tokens.",
      priorityScore: 0.9,
      contentFingerprint: "fp-jwt",
      createdAt: "2026-03-15T00:50:00.000Z",
      updatedAt: "2026-03-15T00:50:00.000Z",
    });
    const changedAfterMerged = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "todait-backend",
      candidateKind: "decision",
      candidateTitle: "JWT auth rollout decision",
      candidateContent: "The team decided to roll out JWT auth to production.",
      priorityScore: 1,
      contentFingerprint: "fp-jwt-rollout",
      createdAt: "2026-03-15T01:00:00.000Z",
      updatedAt: "2026-03-15T01:00:00.000Z",
    });

    const rows = inst.db.prepare(`
      SELECT id, status, content_fingerprint, created_at
      FROM canonical_candidates
      WHERE raw_memory_id = ?
      ORDER BY created_at ASC
    `).all(rawMemoryId) as Array<{
      id: string;
      status: string;
      content_fingerprint: string;
      created_at: string;
    }>;

    expect(sameApproved.id).toBe(approved.id);
    expect(sameMerged.id).toBe(changedAfterApproved.id);
    expect(changedAfterApproved.id).not.toBe(approved.id);
    expect(changedAfterMerged.id).not.toBe(changedAfterApproved.id);
    expect(rows).toEqual([
      expect.objectContaining({
        id: approved.id,
        status: "approved",
        content_fingerprint: "fp-cookie",
        created_at: "2026-03-15T00:00:00.000Z",
      }),
      expect.objectContaining({
        id: changedAfterApproved.id,
        status: "merged",
        content_fingerprint: "fp-jwt",
        created_at: "2026-03-15T00:30:00.000Z",
      }),
      expect.objectContaining({
        id: changedAfterMerged.id,
        status: "queued",
        content_fingerprint: "fp-jwt-rollout",
        created_at: "2026-03-15T01:00:00.000Z",
      }),
    ]);
  });

  it("lists only queued candidates ordered by priority and recency", () => {
    const rawA = insertRawMemory(inst.db, { id: "raw-a" });
    const rawB = insertRawMemory(inst.db, { id: "raw-b" });
    const rawC = insertRawMemory(inst.db, { id: "raw-c" });
    const rawD = insertRawMemory(inst.db, { id: "raw-d" });
    const rawE = insertRawMemory(inst.db, { id: "raw-e" });

    enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: rawA,
      scope: "global",
      candidateKind: "fact",
      candidateTitle: "A",
      candidateContent: "A",
      priorityScore: 0.9,
      contentFingerprint: "fp-a",
      createdAt: "2026-03-15T01:00:00.000Z",
      updatedAt: "2026-03-15T01:00:00.000Z",
    });
    enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: rawB,
      scope: "global",
      candidateKind: "fact",
      candidateTitle: "B",
      candidateContent: "B",
      priorityScore: 0.9,
      contentFingerprint: "fp-b",
      createdAt: "2026-03-15T02:00:00.000Z",
      updatedAt: "2026-03-15T02:00:00.000Z",
    });
    enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: rawC,
      scope: "global",
      candidateKind: "fact",
      candidateTitle: "C",
      candidateContent: "C",
      priorityScore: 0.8,
      contentFingerprint: "fp-c",
      createdAt: "2026-03-15T03:00:00.000Z",
      updatedAt: "2026-03-15T03:00:00.000Z",
    });
    const processing = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: rawD,
      scope: "global",
      candidateKind: "fact",
      candidateTitle: "D",
      candidateContent: "D",
      priorityScore: 1,
      contentFingerprint: "fp-d",
      createdAt: "2026-03-15T04:00:00.000Z",
      updatedAt: "2026-03-15T04:00:00.000Z",
    });
    markCanonicalCandidateProcessing(inst.db, processing.id, "2026-03-15T04:01:00.000Z");
    const rejected = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: rawE,
      scope: "global",
      candidateKind: "fact",
      candidateTitle: "E",
      candidateContent: "E",
      priorityScore: 1,
      contentFingerprint: "fp-e",
      createdAt: "2026-03-15T05:00:00.000Z",
      updatedAt: "2026-03-15T05:00:00.000Z",
    });
    markCanonicalCandidateRejected(inst.db, {
      id: rejected.id,
      confidence: 0.2,
      rationale: "Noisy",
      matchedCanonicalId: null,
      now: "2026-03-15T05:01:00.000Z",
    });

    const queued = listQueuedCanonicalCandidates(inst.db, 2);

    expect(queued).toHaveLength(2);
    expect(queued.map((row) => row.id)).toEqual(["raw-b", "raw-a"].map((rawId) => {
      const row = inst.db.prepare(
        "SELECT id FROM canonical_candidates WHERE raw_memory_id = ?"
      ).get(rawId) as { id: string };
      return row.id;
    }));
  });

  it("does not list queued candidates for soft-deleted raw memories", () => {
    const rawMemoryId = insertRawMemory(inst.db, { id: "deleted-raw" });
    const candidate = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "global",
      candidateKind: "fact",
      candidateTitle: "Deleted raw candidate",
      candidateContent: "This candidate should disappear from the queue.",
      priorityScore: 1,
      contentFingerprint: "fp-deleted",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    inst.db.prepare("UPDATE memories SET deleted = 1, updated_at = ? WHERE id = ?").run(
      "2026-03-15T01:00:00.000Z",
      rawMemoryId
    );

    const queued = listQueuedCanonicalCandidates(inst.db, 10);

    expect(queued.some((row) => row.id === candidate.id)).toBe(false);
  });

  it("requeues transient failures while preserving candidate content fields", () => {
    const rawMemoryId = insertRawMemory(inst.db, { id: "retry-raw" });
    const candidate = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "global",
      candidateKind: "decision",
      candidateTitle: "JWT rollout decision",
      candidateContent: "The team decided to roll out JWT auth.",
      priorityScore: 0.8,
      contentFingerprint: "fp-retry",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    markCanonicalCandidateProcessing(inst.db, candidate.id, "2026-03-15T00:01:00.000Z");

    requeueCanonicalCandidateAfterTransientFailure(inst.db, {
      id: candidate.id,
      rationale: "Temporary Ollama connection failure",
    }, "2026-03-15T00:02:00.000Z");

    const row = inst.db.prepare(`
      SELECT status, candidate_kind, candidate_title, candidate_content, retry_count,
             rationale, last_judged_at, updated_at
      FROM canonical_candidates
      WHERE id = ?
    `).get(candidate.id) as {
      status: string;
      candidate_kind: string;
      candidate_title: string;
      candidate_content: string;
      retry_count: number;
      rationale: string;
      last_judged_at: string;
      updated_at: string;
    };

    expect(row).toMatchObject({
      status: "queued",
      candidate_kind: "decision",
      candidate_title: "JWT rollout decision",
      candidate_content: "The team decided to roll out JWT auth.",
      retry_count: 1,
      rationale: "Temporary Ollama connection failure",
      last_judged_at: "2026-03-15T00:02:00.000Z",
      updated_at: "2026-03-15T00:02:00.000Z",
    });
  });

  it("reclaims only stale processing rows using updated_at and the candidate lease", () => {
    const staleRawId = insertRawMemory(inst.db, { id: "stale-raw" });
    const freshRawId = insertRawMemory(inst.db, { id: "fresh-raw" });

    const stale = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: staleRawId,
      scope: "global",
      candidateKind: "fact",
      candidateTitle: "Stale candidate",
      candidateContent: "Stale candidate",
      priorityScore: 0.7,
      contentFingerprint: "fp-stale",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    const fresh = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: freshRawId,
      scope: "global",
      candidateKind: "fact",
      candidateTitle: "Fresh candidate",
      candidateContent: "Fresh candidate",
      priorityScore: 0.7,
      contentFingerprint: "fp-fresh",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    markCanonicalCandidateProcessing(inst.db, stale.id, "2026-03-15T00:00:00.000Z");
    markCanonicalCandidateProcessing(inst.db, fresh.id, "2026-03-15T00:00:20.000Z");

    const reclaimed = reclaimStaleProcessingCandidates(inst.db, { limit: 10 }, new Date(CANONICAL_CANDIDATE_LEASE_MS + Date.parse("2026-03-15T00:00:00.000Z") + 1).toISOString());

    const rows = inst.db.prepare(`
      SELECT id, status
      FROM canonical_candidates
      WHERE id IN (?, ?)
      ORDER BY id ASC
    `).all(fresh.id, stale.id) as Array<{ id: string; status: string }>;

    expect(reclaimed).toEqual([stale.id]);
    expect(new Map(rows.map((row) => [row.id, row.status]))).toEqual(new Map([
      [fresh.id, "processing"],
      [stale.id, "queued"],
    ]));
  });

  it("claims queued rows atomically for processing", () => {
    const rawMemoryId = insertRawMemory(inst.db);
    const candidate = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId,
      scope: "global",
      candidateKind: "fact",
      candidateTitle: "Claim me",
      candidateContent: "Claim me",
      priorityScore: 0.8,
      contentFingerprint: "fp-claim",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });

    expect(markCanonicalCandidateProcessing(inst.db, candidate.id, "2026-03-15T00:01:00.000Z")).toBe(true);
    expect(markCanonicalCandidateProcessing(inst.db, candidate.id, "2026-03-15T00:02:00.000Z")).toBe(false);

    const row = inst.db.prepare(`
      SELECT status, updated_at, created_at
      FROM canonical_candidates
      WHERE id = ?
    `).get(candidate.id) as { status: string; updated_at: string; created_at: string };

    expect(row).toMatchObject({
      status: "processing",
      updated_at: "2026-03-15T00:01:00.000Z",
      created_at: "2026-03-15T00:00:00.000Z",
    });
  });

  it("marks candidates rejected, approved, and merged without rewriting created_at", () => {
    const matchedCanonicalId = createCanonicalMemory(inst.db, {
      kind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      evidenceMemoryIds: [],
      createdAt: "2026-03-14T00:00:00.000Z",
      updatedAt: "2026-03-14T00:00:00.000Z",
    });

    const rejectedRawId = insertRawMemory(inst.db, { id: "rejected-raw" });
    const approvedRawId = insertRawMemory(inst.db, { id: "approved-raw" });
    const mergedRawId = insertRawMemory(inst.db, { id: "merged-raw" });

    const rejected = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: rejectedRawId,
      scope: "todait-backend",
      candidateKind: "unknown",
      candidateTitle: "Rejected",
      candidateContent: "Rejected",
      priorityScore: 0.1,
      contentFingerprint: "fp-rejected",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
    });
    const approved = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: approvedRawId,
      scope: "todait-backend",
      candidateKind: "unknown",
      candidateTitle: "Approved",
      candidateContent: "Approved",
      priorityScore: 0.5,
      contentFingerprint: "fp-approved",
      createdAt: "2026-03-15T00:10:00.000Z",
      updatedAt: "2026-03-15T00:10:00.000Z",
    });
    const merged = enqueueCanonicalCandidate(inst.db, {
      rawMemoryId: mergedRawId,
      scope: "todait-backend",
      candidateKind: "unknown",
      candidateTitle: "Merged",
      candidateContent: "Merged",
      priorityScore: 0.5,
      contentFingerprint: "fp-merged",
      createdAt: "2026-03-15T00:20:00.000Z",
      updatedAt: "2026-03-15T00:20:00.000Z",
    });

    markCanonicalCandidateRejected(inst.db, {
      id: rejected.id,
      confidence: 0.12,
      rationale: "Not enough evidence",
      matchedCanonicalId: null,
      now: "2026-03-15T01:00:00.000Z",
    });
    markCanonicalCandidateApproved(inst.db, {
      id: approved.id,
      candidateKind: "decision",
      candidateTitle: "JWT migration decision",
      candidateContent: "The team decided to migrate auth to JWT.",
      confidence: 0.86,
      rationale: "Clear decision phrasing",
      matchedCanonicalId: null,
      now: "2026-03-15T01:10:00.000Z",
    });
    markCanonicalCandidateMerged(inst.db, {
      id: merged.id,
      candidateKind: "fact",
      candidateTitle: "Auth uses JWT",
      candidateContent: "Authentication uses JWT access tokens.",
      confidence: 0.92,
      rationale: "Matches existing canonical fact",
      matchedCanonicalId,
      now: "2026-03-15T01:20:00.000Z",
    });

    const rows = inst.db.prepare(`
      SELECT id, status, candidate_kind, candidate_title, candidate_content, confidence,
             rationale, matched_canonical_id, retry_count, last_judged_at, created_at, updated_at
      FROM canonical_candidates
      WHERE id IN (?, ?, ?)
      ORDER BY created_at ASC
    `).all(rejected.id, approved.id, merged.id) as Array<{
      id: string;
      status: string;
      candidate_kind: string;
      candidate_title: string | null;
      candidate_content: string;
      confidence: number | null;
      rationale: string | null;
      matched_canonical_id: string | null;
      retry_count: number;
      last_judged_at: string | null;
      created_at: string;
      updated_at: string;
    }>;

    expect(rows).toEqual([
      expect.objectContaining({
        id: rejected.id,
        status: "rejected",
        confidence: 0.12,
        rationale: "Not enough evidence",
        matched_canonical_id: null,
        retry_count: 1,
        last_judged_at: "2026-03-15T01:00:00.000Z",
        created_at: "2026-03-15T00:00:00.000Z",
        updated_at: "2026-03-15T01:00:00.000Z",
      }),
      expect.objectContaining({
        id: approved.id,
        status: "approved",
        candidate_kind: "decision",
        candidate_title: "JWT migration decision",
        candidate_content: "The team decided to migrate auth to JWT.",
        confidence: 0.86,
        rationale: "Clear decision phrasing",
        matched_canonical_id: null,
        retry_count: 0,
        last_judged_at: "2026-03-15T01:10:00.000Z",
        created_at: "2026-03-15T00:10:00.000Z",
        updated_at: "2026-03-15T01:10:00.000Z",
      }),
      expect.objectContaining({
        id: merged.id,
        status: "merged",
        candidate_kind: "fact",
        candidate_title: "Auth uses JWT",
        candidate_content: "Authentication uses JWT access tokens.",
        confidence: 0.92,
        rationale: "Matches existing canonical fact",
        matched_canonical_id: matchedCanonicalId,
        retry_count: 0,
        last_judged_at: "2026-03-15T01:20:00.000Z",
        created_at: "2026-03-15T00:20:00.000Z",
        updated_at: "2026-03-15T01:20:00.000Z",
      }),
    ]);
  });
});
