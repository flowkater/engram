/**
 * Tests for cron scheduler.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { startScheduler } from "./scheduler.js";
import path from "node:path";
import os from "node:os";

vi.mock("./embedder.js", async () => {
  const { createMockEmbedder } = await import("../__test__/mock-embedder.js");
  return createMockEmbedder();
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-sched-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("scheduler", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });
  afterEach(() => {
    inst.close();
  });

  it("starts and stops without error", () => {
    const logs: string[] = [];
    const scheduler = startScheduler(inst.db, {
      onLog: (msg) => logs.push(msg),
    });

    expect(scheduler.tasks).toHaveLength(4);
    expect(logs.some((l) => l.includes("Scheduler started"))).toBe(true);

    scheduler.stop();
    expect(logs.some((l) => l.includes("Scheduler stopped"))).toBe(true);
  });

  it("creates four scheduled tasks (reindex, prune, log-rotate, backup)", () => {
    const scheduler = startScheduler(inst.db, {
      onLog: () => {},
    });

    expect(scheduler.tasks).toHaveLength(4);

    scheduler.stop();
  });
});
