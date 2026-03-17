import { describe, expect, it, vi } from "vitest";
import { startServerBootstrap } from "./server-bootstrap.js";

function createFakeDb() {
  return {
    prepare: () => ({
      all: () => [],
    }),
  } as never;
}

describe("server bootstrap", () => {
  it("does not start the background worker when background jobs are disabled", async () => {
    const startBackgroundWorker = vi.fn();

    const bootstrap = await startServerBootstrap(
      {
        env: {
          HOME: "/tmp/home",
          ENGRAM_ENABLE_BACKGROUND_JOBS: "false",
        },
        log: () => {},
        registerProcessHandlers: false,
      },
      {
        ensureDir: () => {},
        openDatabase: () => ({
          db: createFakeDb(),
          close: () => {},
        }),
        createSessionTracker: () => ({
          recordActivity: () => {},
          start: () => {},
          flush: async () => {},
        }),
        createServerApp: () => ({
          connect: async () => {},
          close: async () => {},
        }),
        createTransport: () => ({}) as never,
        startBackgroundWorker,
      }
    );

    expect(startBackgroundWorker).not.toHaveBeenCalled();
    await bootstrap.shutdown("TEST");
  });

  it("starts the lease-based background worker in candidate-only mode", async () => {
    const startBackgroundWorker = vi.fn().mockReturnValue({
      stop: async () => {},
      getState: () => ({ ownsLease: true, runningJobs: true }),
    });

    const bootstrap = await startServerBootstrap(
      {
        env: {
          HOME: "/tmp/home",
          ENGRAM_ENABLE_BACKGROUND_JOBS: "true",
          ENGRAM_ENABLE_DIFF_SCAN: "false",
          ENGRAM_ENABLE_WATCHER: "false",
          ENGRAM_ENABLE_SCHEDULER: "false",
        },
        log: () => {},
        registerProcessHandlers: false,
      },
      {
        ensureDir: () => {},
        openDatabase: () => ({
          db: createFakeDb(),
          close: () => {},
        }),
        createSessionTracker: () => ({
          recordActivity: () => {},
          start: () => {},
          flush: async () => {},
        }),
        createServerApp: () => ({
          connect: async () => {},
          close: async () => {},
        }),
        createTransport: () => ({}) as never,
        startBackgroundWorker,
      }
    );

    expect(startBackgroundWorker).toHaveBeenCalledTimes(1);
    await bootstrap.shutdown("TEST");
  });

  it("runs database maintenance before background jobs inside the bootstrap startJobs seam", async () => {
    const events: string[] = [];
    const runDatabaseMaintenance = vi.fn(() => {
      events.push("maintenance");
    });
    const startBackgroundJobs = vi.fn(async () => {
      events.push("background-jobs");
      return async () => {};
    });
    const startBackgroundWorker = vi.fn().mockImplementation(async (_db, options) => {
      await options.startJobs();
      return {
        stop: async () => {},
        getState: () => ({ ownsLease: true, runningJobs: true }),
      };
    });

    const bootstrap = await startServerBootstrap(
      {
        env: {
          HOME: "/tmp/home",
          ENGRAM_ENABLE_BACKGROUND_JOBS: "true",
        },
        log: () => {},
        registerProcessHandlers: false,
      },
      {
        ensureDir: () => {},
        openDatabase: () => ({
          db: createFakeDb(),
          close: () => {},
        }),
        createSessionTracker: () => ({
          recordActivity: () => {},
          start: () => {},
          flush: async () => {},
        }),
        createServerApp: () => ({
          connect: async () => {},
          close: async () => {},
        }),
        createTransport: () => ({}) as never,
        runDatabaseMaintenance,
        startBackgroundJobs,
        startBackgroundWorker,
      }
    );

    expect(events).toEqual(["maintenance", "background-jobs"]);
    await bootstrap.shutdown("TEST");
  });
});
