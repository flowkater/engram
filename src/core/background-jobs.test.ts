import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { type BackgroundJobConfig } from "./runtime-leases.js";
import { startBackgroundJobs } from "./background-jobs.js";
import path from "node:path";
import os from "node:os";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-bg-jobs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("background jobs", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("runs enabled diffScan, watcher, and scheduler and returns one teardown", async () => {
    const config: BackgroundJobConfig = {
      backgroundEnabled: true,
      diffScanEnabled: true,
      watcherEnabled: true,
      schedulerEnabled: true,
    };
    const starts: string[] = [];

    const stop = await startBackgroundJobs({
      db: inst.db,
      vaultPath: "/tmp/vault",
      backgroundConfig: config,
      log: () => {},
      runDiffScan: async () => {
        starts.push("diff");
      },
      createWatcher: async () => {
        starts.push("watcher");
        return { close: async () => starts.push("watcher-stop") };
      },
      createScheduler: () => {
        starts.push("scheduler");
        return { stop: () => starts.push("scheduler-stop") };
      },
    });

    expect(starts).toEqual(["diff", "watcher", "scheduler"]);
    await stop();
    expect(starts).toContain("watcher-stop");
    expect(starts).toContain("scheduler-stop");
  });

  it("starts the candidate worker even when vault prerequisites are absent", async () => {
    const config: BackgroundJobConfig = {
      backgroundEnabled: true,
      diffScanEnabled: false,
      watcherEnabled: false,
      schedulerEnabled: false,
    };
    const starts: string[] = [];

    const stop = await startBackgroundJobs({
      db: inst.db,
      vaultPath: "/tmp/does-not-exist",
      backgroundConfig: config,
      log: () => {},
      createCandidateWorker: () => {
        starts.push("candidate-worker");
        return {
          stop: async () => {
            starts.push("candidate-worker-stop");
          },
        };
      },
    });

    expect(starts).toEqual(["candidate-worker"]);
    await stop();
    expect(starts).toContain("candidate-worker-stop");
  });
});
