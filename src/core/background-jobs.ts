import type Database from "better-sqlite3";
import fs from "node:fs";
import { diffScan, startWatcher, type WatcherInstance } from "./watcher.js";
import { startScheduler, type SchedulerInstance } from "./scheduler.js";
import {
  startCanonicalCandidateWorker,
  type CanonicalCandidateWorkerInstance,
} from "./canonical-candidate-worker.js";
import type { BackgroundJobConfig } from "./runtime-leases.js";

type ClosableWatcher = Pick<WatcherInstance, "close">;
type StoppableScheduler = Pick<SchedulerInstance, "stop">;
type StoppableCandidateWorker = Pick<CanonicalCandidateWorkerInstance, "stop">;

export interface BackgroundJobsArgs {
  db: Database.Database;
  vaultPath: string;
  backgroundConfig: BackgroundJobConfig;
  log: (message: string) => void;
  runDiffScan?: () => Promise<void>;
  createWatcher?: () => Promise<ClosableWatcher>;
  createScheduler?: () => StoppableScheduler;
  createCandidateWorker?: () => StoppableCandidateWorker;
}

export async function startBackgroundJobs(args: BackgroundJobsArgs): Promise<() => Promise<void>> {
  let watcher: ClosableWatcher | null = null;
  let scheduler: StoppableScheduler | null = null;
  let candidateWorker: StoppableCandidateWorker | null = null;

  const needsVaultForRealWork =
    (args.backgroundConfig.diffScanEnabled && !args.runDiffScan) ||
    (args.backgroundConfig.watcherEnabled && !args.createWatcher);

  if (needsVaultForRealWork && !fs.existsSync(args.vaultPath)) {
    args.log(`Vault not found at ${args.vaultPath}, skipping watcher`);
  } else {
    if (args.backgroundConfig.diffScanEnabled) {
      if (args.runDiffScan) {
        await args.runDiffScan();
      } else {
        const diffResult = await diffScan(args.db, args.vaultPath, {
          onIndexed: (file, chunks) => args.log(`[diffScan] Indexed ${file} (${chunks} chunks)`),
          onError: (err) => args.log(`[diffScan] Error: ${err.message}`),
        });
        args.log(`Diff scan complete: ${diffResult.scanned} scanned, ${diffResult.indexed} indexed`);
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
      args.log(`Watching vault: ${args.vaultPath}`);
    }
  }

  if (args.backgroundConfig.schedulerEnabled) {
    scheduler = args.createScheduler
      ? args.createScheduler()
      : startScheduler(args.db, {
          onLog: args.log,
        });
  }

  if (args.backgroundConfig.backgroundEnabled) {
    candidateWorker = args.createCandidateWorker
      ? args.createCandidateWorker()
      : startCanonicalCandidateWorker(args.db, {
          onLog: args.log,
        });
  }

  return async () => {
    if (watcher) await watcher.close();
    if (scheduler) scheduler.stop();
    if (candidateWorker) await candidateWorker.stop();
  };
}
