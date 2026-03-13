import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase } from "./database.js";
import { memoryAdd } from "../tools/add.js";
import {
  addCanonicalEdge,
  createCanonicalMemory,
  getCanonicalMemory,
  listCanonicalEvidence,
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
});
