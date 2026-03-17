import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryAdd } from "./add.js";
import { memoryPromote } from "./promote.js";
import { memorySearchGraph } from "./search-graph.js";
import { startCanonicalCandidateWorker } from "../core/canonical-candidate-worker.js";
import path from "node:path";
import os from "node:os";

vi.mock("../core/embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-search-graph-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 1500, intervalMs = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = async () => {
      if (await predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(() => {
        void check();
      }, intervalMs);
    };
    void check();
  });
}

describe("memory.search_graph", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("returns confirmed and candidate sections plus graph payload", async () => {
    const raw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      source: "manual",
    });
    await memoryAdd(inst.db, {
      content: "JWT rollout note pending review.",
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

    expect(result.confirmed.length).toBeGreaterThan(0);
    expect(result.confirmed.every((item) => item.isCanonical === true)).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(0);
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

  it("shows candidate-only state before approval and confirmed output after worker approval", async () => {
    const raw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens and rotates them daily.",
      summary: "Auth uses rotating JWT",
      scope: "todait-backend",
    });

    const before = await memorySearchGraph(inst.db, {
      query: "rotating jwt",
      scope: "todait-backend",
      limit: 5,
      hopDepth: 1,
    });

    expect(before.confirmed).toHaveLength(0);
    expect(before.candidates.some((row) => row.rawMemoryId === raw.id)).toBe(true);

    const worker = startCanonicalCandidateWorker(inst.db, {
      pollMs: 10,
      judgeCandidate: async () => ({
        action: "approve",
        canonicalKind: "fact",
        title: "Auth uses rotating JWT",
        content: "Authentication uses JWT access tokens and rotates them daily.",
        confidence: 0.93,
        rationale: "Clear factual update",
      }),
      embedCanonical: async () => new Float32Array(768).fill(0.2),
    });

    await waitForAsync(async () => {
      const current = await memorySearchGraph(inst.db, {
        query: "rotating jwt",
        scope: "todait-backend",
        limit: 5,
        hopDepth: 1,
      });
      return current.confirmed.some((row) => row.content.includes("rotates them daily"));
    });

    const after = await memorySearchGraph(inst.db, {
      query: "rotating jwt",
      scope: "todait-backend",
      limit: 5,
      hopDepth: 1,
    });

    expect(after.confirmed.some((row) => row.content.includes("rotates them daily"))).toBe(true);
    await worker.stop();
  });
});
