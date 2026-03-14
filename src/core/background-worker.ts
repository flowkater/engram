import type Database from "better-sqlite3";
import {
  acquireRuntimeLease,
  DEFAULT_BACKGROUND_WORKER_LEASE_KEY,
  releaseRuntimeLease,
  type RuntimeLeaseResult,
  renewRuntimeLease,
} from "./runtime-leases.js";

export interface BackgroundWorkerOptions {
  ownerId: string;
  leaseKey?: string;
  retryMs: number;
  renewMs: number;
  leaseTtlMs: number;
  startJobs: () => Promise<(() => Promise<void> | void) | void>;
  onLog?: (message: string) => void;
  leaseOps?: BackgroundWorkerLeaseOps;
}

export interface BackgroundWorkerInstance {
  stop(): Promise<void>;
  getState(): { ownsLease: boolean; runningJobs: boolean };
}

export interface BackgroundTiming {
  leaseTtlMs: number;
  renewMs: number;
  retryMs: number;
}

export interface BackgroundWorkerLeaseOps {
  acquire: (
    db: Database.Database,
    leaseKey: string,
    ownerId: string,
    ttlMs: number
  ) => RuntimeLeaseResult;
  renew: (
    db: Database.Database,
    leaseKey: string,
    ownerId: string,
    ttlMs: number
  ) => boolean;
  release: (
    db: Database.Database,
    leaseKey: string,
    ownerId: string
  ) => void;
}

export function resolveBackgroundTiming(env: NodeJS.ProcessEnv = process.env): BackgroundTiming {
  return {
    leaseTtlMs: parseInt(env.ENGRAM_BACKGROUND_LEASE_TTL_MS || "60000", 10),
    renewMs: parseInt(env.ENGRAM_BACKGROUND_RENEW_MS || "20000", 10),
    retryMs: parseInt(env.ENGRAM_BACKGROUND_RETRY_MS || "5000", 10),
  };
}

export function startBackgroundWorker(
  db: Database.Database,
  opts: BackgroundWorkerOptions
): BackgroundWorkerInstance {
  const leaseKey = opts.leaseKey ?? DEFAULT_BACKGROUND_WORKER_LEASE_KEY;
  const onLog = opts.onLog ?? (() => {});
  const leaseOps = opts.leaseOps ?? {
    acquire: acquireRuntimeLease,
    renew: renewRuntimeLease,
    release: releaseRuntimeLease,
  };
  let ownsLease = false;
  let runningJobs = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let stopJobs: (() => Promise<void> | void) | null = null;
  let mode: "idle" | "waiting" | "leader" | "stopped" = "idle";

  function clearRetryTimer(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function clearRenewTimer(): void {
    if (renewTimer) clearInterval(renewTimer);
    renewTimer = null;
  }

  async function stopRunningJobs(): Promise<void> {
    if (!runningJobs) return;
    runningJobs = false;
    const cleanup = stopJobs;
    stopJobs = null;
    if (cleanup) {
      await cleanup();
    }
  }

  function scheduleRetry(): void {
    if (stopped || retryTimer) return;
    if (mode !== "waiting") {
      onLog("Background worker lease busy; retrying");
      mode = "waiting";
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void attemptAcquire();
    }, opts.retryMs);
  }

  function startRenewLoop(): void {
    clearRenewTimer();
    renewTimer = setInterval(() => {
      let renewed = false;
      try {
        renewed = leaseOps.renew(db, leaseKey, opts.ownerId, opts.leaseTtlMs);
      } catch (err) {
        onLog(`Background worker lease renew failed: ${(err as Error).message}`);
        void handleLostLease();
        return;
      }
      if (!renewed) {
        void handleLostLease();
      }
    }, opts.renewMs);
  }

  async function handleLostLease(): Promise<void> {
    if (stopped || !ownsLease) return;
    ownsLease = false;
    clearRenewTimer();
    onLog("Background worker lease lost; stopping jobs");
    await stopRunningJobs();
    scheduleRetry();
  }

  async function attemptAcquire(): Promise<void> {
    if (stopped) return;
    let lease;
    try {
      lease = leaseOps.acquire(db, leaseKey, opts.ownerId, opts.leaseTtlMs);
    } catch (err) {
      onLog(`Background worker lease check failed: ${(err as Error).message}`);
      scheduleRetry();
      return;
    }
    if (!lease.acquired) {
      scheduleRetry();
      return;
    }

    clearRetryTimer();
    ownsLease = true;
    mode = "leader";
    onLog("Background worker lease acquired");

    try {
      if (!runningJobs) {
        const cleanup = await opts.startJobs();
        if (stopped || !ownsLease) {
          if (cleanup) {
            await cleanup();
          }
          return;
        }
        stopJobs = cleanup ?? null;
        runningJobs = true;
      }
      startRenewLoop();
    } catch (err) {
      onLog(`Background worker failed to start jobs: ${(err as Error).message}`);
      ownsLease = false;
      leaseOps.release(db, leaseKey, opts.ownerId);
      await stopRunningJobs();
      scheduleRetry();
    }
  }

  void attemptAcquire();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      mode = "stopped";
      clearRetryTimer();
      clearRenewTimer();
      if (ownsLease) {
        leaseOps.release(db, leaseKey, opts.ownerId);
      }
      ownsLease = false;
      await stopRunningJobs();
    },
    getState() {
      return { ownsLease, runningJobs };
    },
  };
}
