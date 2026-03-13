import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../src/core/database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIST_SERVER = path.resolve(REPO_ROOT, "dist", "server.js");
const LEASE_TTL_MS = 500;
const RETRY_MS = 100;
const RENEW_MS = 100;
const START_TIMEOUT_MS = 8000;
const TAKEOVER_TIMEOUT_MS = 12000;
let built = false;

interface ServerHandle {
  child: ChildProcess;
  lines: string[];
}

const serverHandles: ServerHandle[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function spawnServer(env: NodeJS.ProcessEnv): ServerHandle {
  if (!built) {
    execFileSync("npm", ["run", "build"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    built = true;
  }

  const child = spawn(process.execPath, [DIST_SERVER], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines: string[] = [];
  child.stdout?.on("data", (data) => {
    lines.push(String(data));
  });
  child.stderr?.on("data", (data) => {
    lines.push(String(data));
  });

  const handle = { child, lines };
  serverHandles.push(handle);
  return handle;
}

function waitForOutput(handle: ServerHandle, pattern: string, timeoutMs = 5000, intervalMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (handle.lines.some((line) => line.includes(pattern))) return resolve();
      if (hasExited(handle)) {
        return reject(new Error(`Process exited before pattern "${pattern}" appeared.\n${handle.lines.join("")}`));
      }
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out waiting for "${pattern}".\n${handle.lines.join("")}`));
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function waitFor<T>(
  read: () => T | null | undefined,
  timeoutMs = 5000,
  intervalMs = 20
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const value = read();
      if (value !== null && value !== undefined) return resolve(value);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out waiting for condition after ${timeoutMs}ms`));
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function hasExited(handle: ServerHandle): boolean {
  return handle.child.exitCode !== null || handle.child.signalCode !== null;
}

async function stopChild(handle: ServerHandle | undefined, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!handle) return;
  if (hasExited(handle)) return;

  handle.child.kill(signal);
  const started = Date.now();
  while (!hasExited(handle) && Date.now() - started < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  if (!hasExited(handle)) {
    handle.child.kill("SIGKILL");
  }
}

async function waitForExit(handle: ServerHandle, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!hasExited(handle) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  if (!hasExited(handle)) {
    throw new Error(`Process did not exit within ${timeoutMs}ms.\n${handle.lines.join("")}`);
  }
}

describe("background worker failover", () => {
  afterEach(async () => {
    while (serverHandles.length > 0) {
      await stopChild(serverHandles.pop(), "SIGTERM");
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("elects one leader and promotes the follower after leader exit", async () => {
    const homeDir = makeTempDir("um-bg-home-");
    const dbPath = path.join(homeDir, ".engram", "memory.db");
    const emptyVault = makeTempDir("um-bg-vault-");
    const initialDb = openDatabase(dbPath);
    initialDb.close();
    const inspectDb = openDatabase(dbPath);
    try {
      const env = {
        ...process.env,
        HOME: homeDir,
        MEMORY_DB: dbPath,
        VAULT_PATH: emptyVault,
        ENGRAM_ENABLE_BACKGROUND_JOBS: "true",
        ENGRAM_ENABLE_DIFF_SCAN: "false",
        ENGRAM_ENABLE_WATCHER: "false",
        ENGRAM_ENABLE_SCHEDULER: "true",
        ENGRAM_BACKGROUND_LEASE_TTL_MS: String(LEASE_TTL_MS),
        ENGRAM_BACKGROUND_RETRY_MS: String(RETRY_MS),
        ENGRAM_BACKGROUND_RENEW_MS: String(RENEW_MS),
      };

      const leader = spawnServer(env);

      const initialLeaseOwner = await waitFor(() => {
        const row = inspectDb.db.prepare(
          "SELECT owner_id FROM runtime_leases WHERE lease_key = ?"
        ).get("engram:background-worker") as { owner_id: string } | undefined;
        if (!row) return null;
        return row.owner_id.includes(String(leader.child.pid)) ? row.owner_id : null;
      }, START_TIMEOUT_MS);

      expect(initialLeaseOwner).toContain(String(leader.child.pid));

      const follower = spawnServer(env);
      await waitForOutput(follower, "Background worker lease busy; retrying", START_TIMEOUT_MS);

      await stopChild(leader, "SIGKILL");
      await waitForExit(leader);

      const takeoverOwner = await waitFor(() => {
        const row = inspectDb.db.prepare(
          "SELECT owner_id FROM runtime_leases WHERE lease_key = ?"
        ).get("engram:background-worker") as { owner_id: string } | undefined;
        if (!row) return null;
        return row.owner_id.includes(String(follower.child.pid)) ? row.owner_id : null;
      }, TAKEOVER_TIMEOUT_MS);

      expect(takeoverOwner).toContain(String(follower.child.pid));
      await waitForOutput(follower, "Scheduler started", TAKEOVER_TIMEOUT_MS);
    } finally {
      inspectDb.close();
    }
  }, 20000);
});
