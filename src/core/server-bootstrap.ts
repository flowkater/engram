import path from "node:path";
import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase, runDatabaseMaintenance, type DatabaseInstance } from "./database.js";
import { SessionTracker } from "./session-tracker.js";
import { getCurrentModelName } from "./embedder.js";
import { resolveBackgroundTiming, startBackgroundWorker, type BackgroundWorkerInstance } from "./background-worker.js";
import { startBackgroundJobs } from "./background-jobs.js";
import { resolveBackgroundRuntime } from "./background-runtime.js";
import { createEngramServer, type SessionTrackerLike } from "./server-app.js";

export interface ServerLike {
  connect(transport: unknown): Promise<void>;
  close?(): Promise<void> | void;
}

export interface SessionTrackerController extends SessionTrackerLike {
  start(): void;
  flush(): Promise<void>;
}

export interface ServerBootstrapDeps {
  openDatabase?: typeof openDatabase;
  runDatabaseMaintenance?: typeof runDatabaseMaintenance;
  createSessionTracker?: (db: DatabaseInstance["db"], log: (message: string) => void) => SessionTrackerController;
  createServerApp?: (args: {
    db: DatabaseInstance["db"];
    dbPath: string;
    log: (message: string) => void;
    sessionTracker: SessionTrackerLike;
  }) => ServerLike;
  resolveBackgroundRuntime?: typeof resolveBackgroundRuntime;
  resolveBackgroundTiming?: typeof resolveBackgroundTiming;
  startBackgroundWorker?: typeof startBackgroundWorker;
  startBackgroundJobs?: typeof startBackgroundJobs;
  getCurrentModelName?: typeof getCurrentModelName;
  ensureDir?: (dir: string) => void;
  createTransport?: () => StdioServerTransport;
  exit?: (code: number) => void;
}

export interface ServerBootstrapOptions {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  registerProcessHandlers?: boolean;
}

export interface ServerBootstrapInstance {
  shutdown(signal: string): Promise<void>;
  backgroundWorker: BackgroundWorkerInstance | null;
  dbInstance: DatabaseInstance;
  server: ServerLike;
}

function defaultLogFactory(logDir: string): (message: string) => void {
  return (message: string) => {
    const line = `[engram] ${message}`;
    console.error(line);
    try {
      const logFile = path.join(logDir, `server-${new Date().toISOString().slice(0, 10)}.log`);
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
    } catch {}
  };
}

function logModelMismatch(
  db: DatabaseInstance["db"],
  log: (message: string) => void,
  currentModelName: string
): void {
  const existing = db.prepare(
    "SELECT DISTINCT embed_model FROM memories WHERE embed_model IS NOT NULL AND deleted = 0 LIMIT 10"
  ).all() as Array<{ embed_model: string }>;

  if (existing.length > 1) {
    const models = existing.map((row) => row.embed_model).join(", ");
    log(`⚠️  Multiple embedding models detected in DB: ${models}. Consider re-indexing for consistent similarity search.`);
  }

  if (existing.length > 0) {
    const dbModels = existing.map((row) => row.embed_model);
    if (!dbModels.includes(currentModelName)) {
      log(`⚠️  Model mismatch: current model is "${currentModelName}" but DB contains records from [${dbModels.join(", ")}]. Consider re-indexing.`);
    }
  }
}

export async function startServerBootstrap(
  opts?: ServerBootstrapOptions,
  deps?: ServerBootstrapDeps
): Promise<ServerBootstrapInstance> {
  const env = opts?.env ?? process.env;
  const dbPath = env.MEMORY_DB || path.join(env.HOME || "~", ".engram", "memory.db");
  const vaultPath = env.VAULT_PATH || path.join(env.HOME || "~", "Obsidian", "flowkater", "flowkater");
  const logDir = path.join(env.HOME || "~", ".engram", "logs");

  (deps?.ensureDir ?? ((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }))(logDir);

  const log = opts?.log ?? defaultLogFactory(logDir);
  const openDb = deps?.openDatabase ?? openDatabase;
  let dbInstance: DatabaseInstance;
  try {
    dbInstance = openDb(dbPath, { runMaintenance: false });
  } catch (err) {
    log(`Fatal: Failed to open database at ${dbPath}: ${(err as Error).message}`);
    (deps?.exit ?? process.exit)(1);
    throw err;
  }

  const sessionTracker = deps?.createSessionTracker
    ? deps.createSessionTracker(dbInstance.db, log)
    : new SessionTracker(dbInstance.db, { log });
  const server = (deps?.createServerApp ?? createEngramServer)({
    db: dbInstance.db,
    dbPath,
    log,
    sessionTracker,
  });

  logModelMismatch(
    dbInstance.db,
    log,
    (deps?.getCurrentModelName ?? getCurrentModelName)()
  );

  const transport = (deps?.createTransport ?? (() => new StdioServerTransport()))();
  await server.connect(transport);
  log("MCP server started (stdio)");
  sessionTracker.start();

  let backgroundWorker: BackgroundWorkerInstance | null = null;
  const backgroundRuntime = (deps?.resolveBackgroundRuntime ?? resolveBackgroundRuntime)(env);
  if (backgroundRuntime.enabled) {
    backgroundWorker = (deps?.startBackgroundWorker ?? startBackgroundWorker)(dbInstance.db, {
      ownerId: `server:${process.pid}:${Date.now()}`,
      ...(deps?.resolveBackgroundTiming ?? resolveBackgroundTiming)(env),
      onLog: log,
      startJobs: async () => {
        (deps?.runDatabaseMaintenance ?? runDatabaseMaintenance)(dbInstance.db, { log });
        return (deps?.startBackgroundJobs ?? startBackgroundJobs)({
          db: dbInstance.db,
          vaultPath,
          backgroundConfig: backgroundRuntime.backgroundConfig,
          log,
        });
      },
    });
  } else {
    log("Background jobs disabled by environment");
  }

  let shutdownOnce = false;
  async function shutdown(signal: string): Promise<void> {
    if (shutdownOnce) return;
    shutdownOnce = true;
    log(`Received ${signal}, shutting down...`);
    try {
      await sessionTracker.flush();
    } catch (err) {
      log(`sessionTracker.flush error: ${(err as Error).message}`);
    }
    try {
      if (backgroundWorker) await backgroundWorker.stop();
    } catch (err) {
      log(`backgroundWorker.stop error: ${(err as Error).message}`);
    }
    try {
      await server.close?.();
    } catch (err) {
      log(`server.close error: ${(err as Error).message}`);
    }
    try {
      dbInstance.close();
    } catch (err) {
      log(`db.close error: ${(err as Error).message}`);
    }
  }

  if (opts?.registerProcessHandlers !== false) {
    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }

  return {
    shutdown,
    backgroundWorker,
    dbInstance,
    server,
  };
}

export async function startServerFromProcess(): Promise<void> {
  try {
    await startServerBootstrap();
  } catch (err) {
    console.error(`[engram] Fatal error: ${(err as Error).message}`);
    process.exit(1);
  }
}
