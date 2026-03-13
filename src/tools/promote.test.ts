import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryAdd } from "./add.js";
import { memoryPromote } from "./promote.js";
import { memorySearch } from "./search.js";
import path from "node:path";
import os from "node:os";

vi.mock("../core/embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-promote-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("memory.promote", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("promotes raw memories into a canonical fact", async () => {
    const raw1 = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });
    const raw2 = await memoryAdd(inst.db, {
      content: "JWT is now the standard auth path.",
      scope: "todait-backend",
    });

    const result = await memoryPromote(inst.db, {
      memoryIds: [raw1.id, raw2.id],
      kind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    expect(result.canonicalId).toBeTruthy();
    expect(result.kind).toBe("fact");
    expect(result.evidenceCount).toBe(2);
  });

  it("promotes a canonical decision with decidedAt metadata", async () => {
    const raw = await memoryAdd(inst.db, {
      content: "We decided to keep SQLite as the local store.",
      scope: "engram",
    });

    const result = await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "decision",
      title: "Keep SQLite",
      content: "SQLite remains the primary local store.",
      scope: "engram",
      decidedAt: "2026-03-12T00:00:00.000Z",
    });

    expect(result.kind).toBe("decision");
    expect(result.decidedAt).toBe("2026-03-12T00:00:00.000Z");
  });

  it("canonical memories are searchable after promotion", async () => {
    const raw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const results = await memorySearch(inst.db, {
      query: "JWT auth",
      scope: "todait-backend",
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("JWT");
  });
});
