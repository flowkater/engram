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
import type Database from "better-sqlite3";

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

describe("runGraphSearch — batched frontier queries", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("batches per-hop edge + node fetches (no N+1 per frontier node)", async () => {
    // Seed a star graph: node-0 is center, linked via `supersedes` to node-1..node-9.
    // Raw + canonical via memoryAdd/memoryPromote so FTS/vec artifacts are populated.
    const center = await memoryAdd(inst.db, {
      content: "Star center keyword anchor note.",
      scope: "batch-test",
    });
    const centerCanon = await memoryPromote(inst.db, {
      memoryIds: [center.id],
      kind: "fact",
      title: "Star center",
      content: "Star center keyword anchor note.",
      scope: "batch-test",
    });

    const neighborCanonIds: string[] = [];
    for (let i = 1; i < 10; i++) {
      const raw = await memoryAdd(inst.db, {
        content: `Neighbor node ${i} keyword content.`,
        scope: "batch-test",
      });
      const canon = await memoryPromote(inst.db, {
        memoryIds: [raw.id],
        kind: "fact",
        title: `Neighbor ${i}`,
        content: `Neighbor node ${i} keyword content.`,
        scope: "batch-test",
        supersedes: [centerCanon.canonicalId],
      });
      neighborCanonIds.push(canon.canonicalId);
    }

    // Intercept db.prepare to count edge / per-id canonical_memories queries.
    const origPrepare = (inst.db as Database.Database).prepare.bind(inst.db);
    let edgeQueryCount = 0;
    let perIdNodeQueryCount = 0;
    (inst.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (/\bcanonical_edges\b/i.test(sql)) edgeQueryCount++;
      if (/FROM\s+canonical_memories[\s\S]*WHERE[\s\S]*\bid\s*=\s*\?/i.test(sql)) {
        perIdNodeQueryCount++;
      }
      return origPrepare(sql);
    };

    try {
      await runGraphSearch(inst.db, {
        query: "keyword",
        scope: "batch-test",
        hopDepth: 1,
        limit: 5,
      });
    } finally {
      (inst.db as unknown as { prepare: (sql: string) => unknown }).prepare = origPrepare;
    }

    // After refactor: 1 batched edge fetch per hop + 1 batched supersede-check
    // at the end. Allow a small constant ceiling (not proportional to neighbor count).
    expect(edgeQueryCount).toBeLessThanOrEqual(4);
    // Canonical node materialization is now batched via IN(...) — no per-id
    // equality fetches should happen inside runGraphSearch's BFS loop.
    expect(perIdNodeQueryCount).toBe(0);
  });

  it("batches edge queries across multi-hop expansion (hopDepth=2)", async () => {
    // 3-layer graph:
    //   center ── supersedes ── first-ring-1, first-ring-2, first-ring-3
    //   each first-ring ── supersedes ── 2 second-ring neighbors (unique)
    const center = await memoryAdd(inst.db, {
      content: "Layer graph center keyword anchor.",
      scope: "multi-hop",
    });
    const centerCanon = await memoryPromote(inst.db, {
      memoryIds: [center.id],
      kind: "fact",
      title: "Layer center",
      content: "Layer graph center keyword anchor.",
      scope: "multi-hop",
    });

    const firstRing: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const raw = await memoryAdd(inst.db, {
        content: `First ring node ${i} keyword content.`,
        scope: "multi-hop",
      });
      const canon = await memoryPromote(inst.db, {
        memoryIds: [raw.id],
        kind: "fact",
        title: `First ring ${i}`,
        content: `First ring node ${i} keyword content.`,
        scope: "multi-hop",
        supersedes: [centerCanon.canonicalId],
      });
      firstRing.push(canon.canonicalId);
    }

    for (let i = 0; i < firstRing.length; i++) {
      for (let j = 1; j <= 2; j++) {
        const raw = await memoryAdd(inst.db, {
          content: `Second ring ${i}-${j} keyword content.`,
          scope: "multi-hop",
        });
        await memoryPromote(inst.db, {
          memoryIds: [raw.id],
          kind: "fact",
          title: `Second ring ${i}-${j}`,
          content: `Second ring ${i}-${j} keyword content.`,
          scope: "multi-hop",
          supersedes: [firstRing[i]],
        });
      }
    }

    const origPrepare = (inst.db as Database.Database).prepare.bind(inst.db);
    let edgeQueryCount = 0;
    let perIdNodeQueryCount = 0;
    (inst.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (/\bcanonical_edges\b/i.test(sql)) edgeQueryCount++;
      if (/FROM\s+canonical_memories[\s\S]*WHERE[\s\S]*\bid\s*=\s*\?/i.test(sql)) {
        perIdNodeQueryCount++;
      }
      return origPrepare(sql);
    };

    try {
      await runGraphSearch(inst.db, {
        query: "keyword",
        scope: "multi-hop",
        hopDepth: 2,
        limit: 5,
      });
    } finally {
      (inst.db as unknown as { prepare: (sql: string) => unknown }).prepare = origPrepare;
    }

    // hopDepth=2: expect 1 batched edge fetch per hop (2) + 1 batched
    // supersede-check at the end = 3. Allow up to 3 (not proportional to node count).
    expect(edgeQueryCount).toBeLessThanOrEqual(3);
    expect(perIdNodeQueryCount).toBe(0);
  });
});

describe("runGraphSearch — bidirectional edge propagation", () => {
  it("boosts the low-relevance seed's score when both seeds share an edge (regression for b1ce93e)", async () => {
    // Regression for the BFS fix: when two seeds share an edge and BOTH are
    // in the initial frontier, the pre-fix "pick otherId only" loop added
    // only one endpoint to nodeCache. The endpoint loop's second iteration
    // then looked up the other endpoint and got undefined — silently skipping
    // one direction of score propagation.
    //
    // Setup mirrors the reviewer's scenario: `weak` is promoted with
    // contradicts:[strong], so the DB edge is (from=weak, to=strong). With
    // the pre-fix loop: frontier.has(from=weak) is true → otherId=strong →
    // only strong lands in nodeCache. In the endpoint loop, the second pass
    // (canonicalId=strong, otherId=weak) calls nodeCache.get(weak) which is
    // undefined and hits `continue`, skipping the strong→weak propagation.
    //
    // We prove the regression with a twin-DB comparison: identical rows
    // with and without the edge. Pre-fix, weak's final score is identical
    // in both DBs (propagation silently dropped). Post-fix, the with-edge
    // weak score is strictly higher because it now picks up
    // strong.seedScore * EDGE_PROPAGATION_DECAY via the now-working second
    // endpoint iteration.

    const withEdgeInst = openDatabase(tmpDbPath());
    const noEdgeInst = openDatabase(tmpDbPath());

    try {
      const query = "authentication rotation policy keyword";
      const scope = "bidir-prop";

      const strongContent = "Authentication rotation policy keyword: JWT access tokens.";
      const weakContent = "Cookie sessions note keyword legacy.";
      const strongTitle = "Authentication rotation policy keyword";
      const weakTitle = "Cookie sessions keyword";

      // With-edge DB.
      const wStrongRaw = await memoryAdd(withEdgeInst.db, { content: strongContent, scope });
      const wWeakRaw = await memoryAdd(withEdgeInst.db, { content: weakContent, scope });
      const wStrong = await memoryPromote(withEdgeInst.db, {
        memoryIds: [wStrongRaw.id],
        kind: "fact",
        title: strongTitle,
        content: strongContent,
        scope,
      });
      const wWeak = await memoryPromote(withEdgeInst.db, {
        memoryIds: [wWeakRaw.id],
        kind: "fact",
        title: weakTitle,
        content: weakContent,
        scope,
        contradicts: [wStrong.canonicalId], // edge stored as (from=wWeak, to=wStrong)
      });

      // No-edge DB — identical content, no contradicts link.
      const nStrongRaw = await memoryAdd(noEdgeInst.db, { content: strongContent, scope });
      const nWeakRaw = await memoryAdd(noEdgeInst.db, { content: weakContent, scope });
      await memoryPromote(noEdgeInst.db, {
        memoryIds: [nStrongRaw.id],
        kind: "fact",
        title: strongTitle,
        content: strongContent,
        scope,
      });
      const nWeak = await memoryPromote(noEdgeInst.db, {
        memoryIds: [nWeakRaw.id],
        kind: "fact",
        title: weakTitle,
        content: weakContent,
        scope,
      });

      const withEdgeResult = await runGraphSearch(withEdgeInst.db, {
        query,
        scope,
        limit: 5,
        hopDepth: 1,
      });
      const noEdgeResult = await runGraphSearch(noEdgeInst.db, {
        query,
        scope,
        limit: 5,
        hopDepth: 1,
      });

      const wWeakRow = withEdgeResult.confirmed.find((row) => row.id === wWeak.canonicalId);
      const nWeakRow = noEdgeResult.confirmed.find((row) => row.id === nWeak.canonicalId);
      expect(wWeakRow).toBeDefined();
      expect(nWeakRow).toBeDefined();

      // Core regression assertion: the edge must BOOST weak's final score.
      // Pre-fix: the strong→weak propagation is silently skipped so weak's
      // score is unchanged by the edge's presence. Post-fix: weak picks up
      // strong.seedScore * 0.85 via propagation → a measurable uplift.
      expect(wWeakRow!.score).toBeGreaterThan(nWeakRow!.score);

      // Sanity: the contradicts edge is emitted at least once.
      expect(
        withEdgeResult.graph.edges.some(
          (edge) =>
            edge.type === "contradicts" &&
            ((edge.source === wStrong.canonicalId && edge.target === wWeak.canonicalId) ||
              (edge.source === wWeak.canonicalId && edge.target === wStrong.canonicalId)),
        ),
      ).toBe(true);
    } finally {
      withEdgeInst.close();
      noEdgeInst.close();
    }
  });
});
