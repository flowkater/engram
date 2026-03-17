import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryAdd } from "./add.js";
import * as canonicalCandidates from "../core/canonical-candidates.js";
import {
  buildCandidateFingerprint,
  deriveCandidateContent,
  deriveCandidateTitle,
  inferCandidateKind,
  scoreCandidatePriority,
} from "../core/canonical-candidates.js";

const { embedMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
}));

vi.mock("../core/embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  const mock = createMockEmbedder();
  embedMock.mockImplementation(mock.embed);
  return {
    ...mock,
    embed: embedMock,
  };
});

function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `engram-add-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

describe("memory.add candidate enqueue", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
    embedMock.mockReset();
    embedMock.mockImplementation(async (text: string, _opts?: unknown, withModel?: boolean) => {
      const { fakeEmbed } = await import("../__test__/mock-embedder.js");
      const embedding = await fakeEmbed(text);
      if (withModel) {
        return { embedding, model: "test-model" };
      }
      return embedding;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    inst.close();
  });

  it("creates exactly one queued candidate tied to the new raw memory", async () => {
    const params = {
      content: "Authentication uses JWT access tokens.",
      summary: "JWT auth uses access tokens",
      scope: "todait-backend",
      tags: ["auth", "jwt"],
      importance: 0.85,
    };

    const added = await memoryAdd(inst.db, params);

    const rows = inst.db.prepare(`
      SELECT raw_memory_id, scope, status, candidate_kind, candidate_title, candidate_content,
             priority_score, confidence, rationale, matched_canonical_id, content_fingerprint,
             retry_count, last_judged_at
      FROM canonical_candidates
      WHERE raw_memory_id = ?
    `).all(added.id) as Array<{
      raw_memory_id: string;
      scope: string;
      status: string;
      candidate_kind: string;
      candidate_title: string | null;
      candidate_content: string;
      priority_score: number;
      confidence: number | null;
      rationale: string | null;
      matched_canonical_id: string | null;
      content_fingerprint: string;
      retry_count: number;
      last_judged_at: string | null;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      raw_memory_id: added.id,
      scope: "todait-backend",
      status: "queued",
      candidate_kind: inferCandidateKind(params),
      candidate_title: deriveCandidateTitle(params),
      candidate_content: deriveCandidateContent(params),
      priority_score: scoreCandidatePriority(params),
      confidence: null,
      rationale: null,
      matched_canonical_id: null,
      content_fingerprint: buildCandidateFingerprint(params),
      retry_count: 0,
      last_judged_at: null,
    });
  });

  it("creates distinct candidate fingerprints when repeated adds change the content", async () => {
    await memoryAdd(inst.db, {
      content: "Authentication uses cookie sessions.",
      summary: "Cookie auth",
      scope: "todait-backend",
      tags: ["auth"],
    });
    await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      summary: "JWT auth",
      scope: "todait-backend",
      tags: ["auth"],
    });

    const rows = inst.db.prepare(`
      SELECT raw_memory_id, content_fingerprint
      FROM canonical_candidates
      ORDER BY created_at ASC
    `).all() as Array<{ raw_memory_id: string; content_fingerprint: string }>;

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.content_fingerprint)).size).toBe(2);
  });

  it("performs exactly one embedding/model call for raw memory storage", async () => {
    await memoryAdd(inst.db, {
      content: "Only one embed call should happen.",
      scope: "todait-backend",
      tags: ["perf"],
    });

    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalledWith(
      "Only one embed call should happen.",
      undefined,
      true
    );
  });

  it("rolls back raw memory, vec, fts, and tags if candidate enqueue fails", async () => {
    vi.spyOn(canonicalCandidates, "enqueueCanonicalCandidate").mockImplementation(() => {
      throw new Error("candidate enqueue failed");
    });

    await expect(memoryAdd(inst.db, {
      content: "This write should roll back.",
      scope: "todait-backend",
      tags: ["rollback", "candidate"],
    })).rejects.toThrow("candidate enqueue failed");

    const memoryRows = inst.db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number };
    const vecRows = inst.db.prepare("SELECT COUNT(*) as count FROM memory_vec").get() as { count: number };
    const ftsRows = inst.db.prepare("SELECT COUNT(*) as count FROM memory_fts").get() as { count: number };
    const tagRows = inst.db.prepare("SELECT COUNT(*) as count FROM memory_tags").get() as { count: number };
    const candidateRows = inst.db.prepare("SELECT COUNT(*) as count FROM canonical_candidates").get() as { count: number };

    expect(memoryRows.count).toBe(0);
    expect(vecRows.count).toBe(0);
    expect(ftsRows.count).toBe(0);
    expect(tagRows.count).toBe(0);
    expect(candidateRows.count).toBe(0);
  });
});
