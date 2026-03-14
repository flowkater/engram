import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { startBackgroundWorker } from "./background-worker.js";
import { DEFAULT_BACKGROUND_WORKER_LEASE_KEY } from "./runtime-leases.js";
import path from "node:path";
import os from "node:os";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-bg-worker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function waitFor(predicate: () => boolean, timeoutMs = 1000, intervalMs = 10): Promise<void> {
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

const timings = { retryMs: 25, renewMs: 25, leaseTtlMs: 80 };

describe("background worker", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("starts jobs immediately when lease is acquired", async () => {
    const events: string[] = [];
    const worker = startBackgroundWorker(inst.db, {
      ownerId: "owner-a",
      ...timings,
      startJobs: async () => {
        events.push("start");
        return () => events.push("stop");
      },
      onLog: (msg) => events.push(msg),
    });

    await waitFor(() => events.includes("start"));
    await worker.stop();
    expect(events).toContain("Background worker lease acquired");
    expect(events).toContain("stop");
  });

  it("retries and takes over after the leader releases the lease", async () => {
    const events: string[] = [];
    const leader = startBackgroundWorker(inst.db, {
      ...timings,
      ownerId: "leader",
      startJobs: async () => () => {},
    });
    const follower = startBackgroundWorker(inst.db, {
      ...timings,
      ownerId: "follower",
      startJobs: async () => {
        events.push("follower-start");
        return () => events.push("follower-stop");
      },
    });

    await waitFor(() => leader.getState().ownsLease === true);
    await leader.stop();
    await waitFor(() => events.includes("follower-start"));
    await follower.stop();
  });

  it("stops jobs and re-enters retry mode when lease renew fails", async () => {
    const events: string[] = [];
    const worker = startBackgroundWorker(inst.db, {
      ownerId: "owner-a",
      ...timings,
      startJobs: async () => {
        events.push("start");
        return () => events.push("stop");
      },
      onLog: (msg) => events.push(msg),
    });

    await waitFor(() => worker.getState().ownsLease === true);
    inst.db.prepare("DELETE FROM runtime_leases WHERE lease_key = ?").run(DEFAULT_BACKGROUND_WORKER_LEASE_KEY);
    await waitFor(() => events.includes("stop"));
    await waitFor(() => events.filter((event) => event === "start").length >= 2);
    await waitFor(() => worker.getState().ownsLease === true);
    expect(events).toContain("Background worker lease lost; stopping jobs");
    await worker.stop();
  });

  it("stops jobs and retries when lease renew throws", async () => {
    const events: string[] = [];
    let renewCalls = 0;

    const worker = startBackgroundWorker(inst.db, {
      ownerId: "owner-a",
      ...timings,
      startJobs: async () => {
        events.push("start");
        return () => events.push("stop");
      },
      onLog: (msg) => events.push(msg),
      leaseOps: {
        acquire: () => ({
          acquired: true,
          leaseKey: DEFAULT_BACKGROUND_WORKER_LEASE_KEY,
          ownerId: "owner-a",
        }),
        renew: () => {
          renewCalls += 1;
          if (renewCalls === 1) {
            const error = new Error("database is locked");
            (error as Error & { code?: string }).code = "SQLITE_BUSY";
            throw error;
          }
          return true;
        },
        release: () => {},
      },
    });

    await waitFor(() => events.includes("start"));
    await waitFor(() => events.includes("Background worker lease renew failed: database is locked"));
    await waitFor(() => events.includes("Background worker lease lost; stopping jobs"));
    await waitFor(() => events.filter((event) => event === "start").length >= 2);

    expect(events.filter((event) => event === "stop").length).toBeGreaterThanOrEqual(1);
    await worker.stop();
  });

  it("does not start jobs after stop is requested during async startup", async () => {
    const events: string[] = [];
    let resolveStartup: ((cleanup: () => void) => void) | null = null;

    const worker = startBackgroundWorker(inst.db, {
      ownerId: "owner-a",
      ...timings,
      startJobs: () => new Promise((resolve) => {
        resolveStartup = resolve;
      }),
      onLog: (msg) => events.push(msg),
    });

    await waitFor(() => worker.getState().ownsLease === true);
    const stopPromise = worker.stop();
    resolveStartup?.(() => events.push("cleanup"));
    await stopPromise;

    expect(events).toContain("Background worker lease acquired");
    expect(events).toContain("cleanup");
    expect(worker.getState()).toEqual({ ownsLease: false, runningJobs: false });
  });
});
