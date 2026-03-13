import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import {
  acquireRuntimeLease,
  buildIndexLeaseKey,
  releaseRuntimeLease,
  renewRuntimeLease,
  resolveBackgroundJobConfig,
} from "./runtime-leases.js";
import path from "node:path";
import os from "node:os";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-lease-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("runtime leases", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("allows only one owner per active lease", () => {
    const first = acquireRuntimeLease(inst.db, "engram:background-worker", "owner-a");
    const second = acquireRuntimeLease(inst.db, "engram:background-worker", "owner-b");

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
  });

  it("allows reacquire after release", () => {
    acquireRuntimeLease(inst.db, "engram:background-worker", "owner-a");
    releaseRuntimeLease(inst.db, "engram:background-worker", "owner-a");

    const second = acquireRuntimeLease(inst.db, "engram:background-worker", "owner-b");
    expect(second.acquired).toBe(true);
  });

  it("can renew an owned lease", () => {
    acquireRuntimeLease(inst.db, "engram:background-worker", "owner-a", 1000);
    expect(renewRuntimeLease(inst.db, "engram:background-worker", "owner-a", 2000)).toBe(true);
  });

  it("builds stable file index lease keys", () => {
    expect(buildIndexLeaseKey("/tmp/a.md")).toBe("index:/tmp/a.md");
  });

  it("resolves background job config with per-job overrides", () => {
    const config = resolveBackgroundJobConfig({
      ENGRAM_ENABLE_BACKGROUND_JOBS: "true",
      ENGRAM_ENABLE_DIFF_SCAN: "false",
      ENGRAM_ENABLE_WATCHER: "true",
      ENGRAM_ENABLE_SCHEDULER: "false",
    });

    expect(config.backgroundEnabled).toBe(true);
    expect(config.diffScanEnabled).toBe(false);
    expect(config.watcherEnabled).toBe(true);
    expect(config.schedulerEnabled).toBe(false);
  });
});
