/**
 * Tests for cron scheduler.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { startScheduler } from "./scheduler.js";
import path from "node:path";
import os from "node:os";

vi.mock("./embedder.js", () => {
  function fakeEmbed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(768);
    for (let i = 0; i < Math.min(text.length, 768); i++) vec[i] = text.charCodeAt(i) / 256;
    let norm = 0;
    for (let i = 0; i < 768; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < 768; i++) vec[i] /= norm;
    return Promise.resolve(vec);
  }
  return { embed: fakeEmbed, EMBEDDING_DIM: 768 };
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

    expect(scheduler.tasks).toHaveLength(2);
    expect(logs.some((l) => l.includes("Scheduler started"))).toBe(true);

    scheduler.stop();
    expect(logs.some((l) => l.includes("Scheduler stopped"))).toBe(true);
  });

  it("creates two scheduled tasks", () => {
    const scheduler = startScheduler(inst.db, {
      onLog: () => {},
    });

    expect(scheduler.tasks).toHaveLength(2);

    scheduler.stop();
  });
});
