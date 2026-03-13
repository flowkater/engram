# Background Worker Failover Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic background-worker re-election and direct two-process startup integration coverage so duplicate prevention remains active even when the current leader exits.

**Architecture:** Extract server startup lease orchestration into a small background-worker coordinator that owns lease acquisition, renewal, retry, and teardown. Keep file-level indexing leases as-is, but make the server continuously retry background ownership with short, testable timers and explicit logs so a spawned second process can prove takeover behavior in Vitest.

**Tech Stack:** TypeScript, Node.js 22, Vitest, child_process, better-sqlite3, tsx, MCP stdio server

---

## Scope

This plan covers only the two residual risks from the duplicate-index prevention slice:

- leader exit should trigger follower takeover without manual restart
- startup wiring should be verified with two real server processes

This plan does **not** change:

- canonical memory behavior
- `memory.promote` / Phase 2 search semantics
- file-level duplicate prevention design
- CLI behavior

## File Structure

### New Files

- Create: `src/core/background-worker.ts`
  Responsibility: background lease coordination, retry loop, timer parsing, and controlled start/stop of background jobs.
- Create: `src/core/background-jobs.ts`
  Responsibility: server-facing composition layer that runs `diffScan`, watcher, and scheduler and returns a single async teardown.
- Create: `src/core/background-worker.test.ts`
  Responsibility: leader acquisition, follower retry, takeover after release/expiry, and teardown coverage.
- Create: `src/core/background-jobs.test.ts`
  Responsibility: composition coverage for enabled diffScan/watcher/scheduler and unified teardown.
- Create: `test/e2e/background-worker-failover.test.ts`
  Responsibility: two spawned `tsx src/server.ts` processes sharing one DB, proving single-owner startup and follower takeover.

### Existing Files To Modify

- Modify: `src/server.ts`
  Responsibility: replace inline background-lease logic with coordinator wiring and stable log messages for integration tests.
- Modify: `src/core/runtime-leases.ts`
  Responsibility: expose any tiny helper needed by the coordinator while keeping lease semantics small and testable.
- Modify: `README.md`
  Responsibility: document automatic failover and test-only timing env vars.

---

## Chunk 1: Automatic Failover Coordinator

### Task 1: Lock Coordinator Contract

**Files:**
- Create: `src/core/background-worker.ts`
- Create: `src/core/background-worker.test.ts`
- Reference: `src/server.ts`
- Reference: `src/core/runtime-leases.ts`

- [ ] **Step 1: Write the failing unit tests for takeover semantics**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { startBackgroundWorker } from "./background-worker.js";
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
  expect(events).toContain("stop");
});

it("retries and takes over after the leader releases the lease", async () => {
  const events: string[] = [];
  const leader = startBackgroundWorker(inst.db, { ...timings, ownerId: "leader", startJobs: async () => () => {} });
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
  inst.db.prepare("DELETE FROM runtime_leases WHERE lease_key = ?").run("engram:background-worker");
  await waitFor(() => events.includes("stop"));
  await waitFor(() => worker.getState().ownsLease === true);
  await worker.stop();
});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/core/background-worker.test.ts`
Expected: FAIL because the coordinator module does not exist yet

- [ ] **Step 3: Implement the smallest coordinator**

```ts
export interface BackgroundWorkerOptions {
  ownerId: string;
  leaseKey?: string;
  retryMs: number;
  renewMs: number;
  leaseTtlMs: number;
  startJobs: () => Promise<() => Promise<void> | void>;
  onLog?: (message: string) => void;
}

export interface BackgroundWorkerInstance {
  stop(): Promise<void>;
  getState(): { ownsLease: boolean; runningJobs: boolean };
}
```

Implementation rules:

- if `leaseKey` is omitted, default to `"engram:background-worker"`
- attempt lease acquisition immediately
- if acquired, call `startJobs()` once and start renew timer
- if not acquired, do **not** call `startJobs()`; schedule retry timer
- if renew fails, stop jobs, clear timers, return to retry mode
- `stop()` must stop jobs, clear timers, and release the lease if owned

- [ ] **Step 4: Parse testable timing env vars in one exact file**

Add this helper to `src/core/background-worker.ts`:

```ts
export function resolveBackgroundTiming(env: NodeJS.ProcessEnv = process.env) {
  return {
    leaseTtlMs: parseInt(env.ENGRAM_BACKGROUND_LEASE_TTL_MS || "60000", 10),
    renewMs: parseInt(env.ENGRAM_BACKGROUND_RENEW_MS || "20000", 10),
    retryMs: parseInt(env.ENGRAM_BACKGROUND_RETRY_MS || "5000", 10),
  };
}
```

- [ ] **Step 5: Re-run unit tests**

Run: `npm test -- src/core/background-worker.test.ts src/core/runtime-leases.test.ts`
Expected: PASS, including default lease-key behavior and renew-failure reacquisition

- [ ] **Step 6: Commit**

```bash
git add src/core/background-worker.ts src/core/background-worker.test.ts
git commit -m "feat: add background worker failover coordinator"
```

### Task 2: Replace Inline Server Lease Logic

**Files:**
- Create: `src/core/background-jobs.ts`
- Create: `src/core/background-jobs.test.ts`
- Modify: `src/server.ts`
- Test: `src/core/background-jobs.test.ts`

- [ ] **Step 1: Write the failing background-jobs composition test**

Add a unit test in `src/core/background-jobs.test.ts`:

```ts
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

const config: BackgroundJobConfig = {
  backgroundEnabled: true,
  diffScanEnabled: true,
  watcherEnabled: true,
  schedulerEnabled: true,
};

it("runs enabled diffScan, watcher, and scheduler and returns one teardown", async () => {
  const starts: string[] = [];
  const stop = await startBackgroundJobs({
    db: inst.db,
    vaultPath: "/tmp/vault",
    backgroundConfig: config,
    log: () => {},
    runDiffScan: async () => starts.push("diff"),
    createWatcher: async () => {
      starts.push("watcher");
      return { close: async () => starts.push("watcher-stop") };
    },
    createScheduler: async () => {
      starts.push("scheduler");
      return { stop: () => starts.push("scheduler-stop") };
    },
  });

  expect(starts).toEqual(["diff", "watcher", "scheduler"]);
  await stop();
  expect(starts).toContain("watcher-stop");
  expect(starts).toContain("scheduler-stop");
});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/core/background-jobs.test.ts`
Expected: FAIL because `src/core/background-jobs.ts` does not exist yet

- [ ] **Step 3: Implement `src/core/background-jobs.ts` and refactor `src/server.ts` to use it**

Target shape:

```ts
export async function startBackgroundJobs(args: {
  db: Database.Database;
  vaultPath: string;
  backgroundConfig: BackgroundJobConfig;
  log: (message: string) => void;
  runDiffScan?: () => Promise<void>;
  createWatcher?: () => Promise<WatcherInstance>;
  createScheduler?: () => SchedulerInstance;
}): Promise<() => Promise<void>> {
  let watcher: WatcherInstance | null = null;
  let scheduler: SchedulerInstance | null = null;

  if (args.backgroundConfig.diffScanEnabled) {
    if (args.runDiffScan) {
      await args.runDiffScan();
    } else {
      await diffScan(args.db, args.vaultPath, {
        onIndexed: (file, chunks) => args.log(`[diffScan] Indexed ${file} (${chunks} chunks)`),
        onError: (err) => args.log(`[diffScan] Error: ${err.message}`),
      });
    }
  }

  if (args.backgroundConfig.watcherEnabled) {
    watcher = args.createWatcher
      ? await args.createWatcher()
      : startWatcher(args.db, {
          vaultPath: args.vaultPath,
          onIndexed: (file, chunks) => args.log(`Indexed ${file} (${chunks} chunks)`),
          onDeleted: (file) => args.log(`Soft-deleted ${file}`),
          onError: (err) => args.log(`Watcher error: ${err.message}`),
        });
  }

  if (args.backgroundConfig.schedulerEnabled) {
    scheduler = args.createScheduler
      ? args.createScheduler()
      : startScheduler(args.db, { onLog: args.log });
  }

  return async () => {
    if (watcher) await watcher.close();
    if (scheduler) scheduler.stop();
  };
}
```

Refactor rules:

- no inline `setInterval` lease logic left in `server.ts`
- `src/server.ts` only assembles config + calls `startBackgroundWorker(...)`
- log explicit transitions from the coordinator:
  - `"Background worker lease acquired"`
  - `"Background worker lease busy; retrying"`
  - `"Background worker lease lost; stopping jobs"`
- when renew fails, jobs must stop and the worker must return to retry mode before reacquiring
- shutdown path calls `await backgroundWorker?.stop()`

- [ ] **Step 4: Re-run focused tests**

Run: `npm test -- src/core/background-worker.test.ts src/core/background-jobs.test.ts src/core/runtime-leases.test.ts`
Expected: PASS, including the new `startBackgroundJobs` composition test inside `src/core/background-jobs.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/core/background-worker.ts src/core/background-jobs.ts src/core/background-worker.test.ts src/core/background-jobs.test.ts
git commit -m "refactor: move server background coordination behind retryable worker"
```

---

## Chunk 2: Two-Process Startup Integration Coverage

### Task 3: Add Real Process Failover Test

**Files:**
- Create: `test/e2e/background-worker-failover.test.ts`
- Modify: `README.md`
- Reference: `package.json`

- [ ] **Step 1: Write the failing two-process integration test**

```ts
it("elects one leader and promotes the follower after leader exit", async () => {
  const env = {
    ...process.env,
    MEMORY_DB: dbPath,
    VAULT_PATH: emptyVaultPath,
    ENGRAM_ENABLE_DIFF_SCAN: "false",
    ENGRAM_ENABLE_WATCHER: "false",
    ENGRAM_ENABLE_SCHEDULER: "true",
    ENGRAM_BACKGROUND_LEASE_TTL_MS: "120",
    ENGRAM_BACKGROUND_RETRY_MS: "40",
    ENGRAM_BACKGROUND_RENEW_MS: "40",
  };

  const leader = spawn("npx", ["tsx", "src/server.ts"], { cwd: repoRoot, env });
  const follower = spawn("npx", ["tsx", "src/server.ts"], { cwd: repoRoot, env });

  await waitForOutput(leader, "Background worker lease acquired");
  await waitForOutput(follower, "Background worker lease busy; retrying");

  leader.kill("SIGTERM");

  await waitForOutput(follower, "Background worker lease acquired");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/e2e/background-worker-failover.test.ts`
Expected: FAIL because follower does not retry takeover yet or logs are missing

- [ ] **Step 3: Add tiny test harness utilities inside the test**

Keep helpers local to the test file:

- `spawnServer(env)`
- `collectOutput(child)`
- `waitForOutput(logs, pattern, timeoutMs)`
- `stopChild(child)`

Do **not** create a generic test framework for one file.

- [ ] **Step 4: Make the integration test deterministic**

Requirements:

- use an empty temp vault so no embeddings are required
- use scheduler-only mode to exercise real startup ownership without Ollama
- wait for process output instead of sleeping blindly
- always stop both children in `afterEach`

- [ ] **Step 5: Re-run the integration test**

Run: `npm test -- test/e2e/background-worker-failover.test.ts`
Expected: PASS

- [ ] **Step 6: Document the new behavior**

Update `README.md` with:

- automatic follower takeover after leader exit
- test-only timing env vars:
  - `ENGRAM_BACKGROUND_LEASE_TTL_MS`
  - `ENGRAM_BACKGROUND_RETRY_MS`
  - `ENGRAM_BACKGROUND_RENEW_MS`
- recommendation that only one long-lived process should normally own background jobs

- [ ] **Step 7: Run final verification**

Run: `npm test -- src/core/background-worker.test.ts src/core/runtime-leases.test.ts test/e2e/background-worker-failover.test.ts`
Expected: PASS

Run: `npm test`
Expected: PASS

Run: `npm run build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add test/e2e/background-worker-failover.test.ts README.md
git commit -m "test: cover background worker failover across two server processes"
```

---

## Risks And Guardrails

- Risk: follower keeps logging retry spam forever.
  Mitigation: log only on state transitions or on a throttled interval, not every timer tick.
- Risk: integration test flakes on slow CI.
  Mitigation: short-but-safe timing env vars, output-based waits, and explicit process teardown.
- Risk: shutdown leaks watcher or scheduler handles.
  Mitigation: one returned async teardown from `startJobs()` and one `backgroundWorker.stop()` path only.
- Risk: plan creeps into broader distributed coordination.
  Mitigation: keep one DB lease key for background jobs and one existing file-level lease mechanism only.

## Verification Checklist

- `src/server.ts` no longer owns raw retry/renew timers directly
- follower takes over after leader exit without manual restart
- process-level integration test spawns **two** real server processes
- `npm test` passes
- `npm run build` passes

Plan complete and saved to `docs/superpowers/plans/2026-03-13-background-worker-failover.md`. Ready to execute?
