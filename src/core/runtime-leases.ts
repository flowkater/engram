import type Database from "better-sqlite3";

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const INDEX_LEASE_PREFIX = "index:";
export const DEFAULT_BACKGROUND_WORKER_LEASE_KEY = "engram:background-worker";

export interface RuntimeLeaseResult {
  acquired: boolean;
  leaseKey: string;
  ownerId: string;
}

export interface BackgroundJobConfig {
  backgroundEnabled: boolean;
  diffScanEnabled: boolean;
  watcherEnabled: boolean;
  schedulerEnabled: boolean;
}

export function resolveBackgroundJobConfig(
  env: NodeJS.ProcessEnv = process.env
): BackgroundJobConfig {
  const backgroundEnabled = parseBooleanEnv(env.ENGRAM_ENABLE_BACKGROUND_JOBS, true);

  return {
    backgroundEnabled,
    diffScanEnabled: backgroundEnabled && parseBooleanEnv(env.ENGRAM_ENABLE_DIFF_SCAN, true),
    watcherEnabled: backgroundEnabled && parseBooleanEnv(env.ENGRAM_ENABLE_WATCHER, true),
    schedulerEnabled: backgroundEnabled && parseBooleanEnv(env.ENGRAM_ENABLE_SCHEDULER, true),
  };
}

export function buildIndexLeaseKey(sourcePath: string): string {
  return `${INDEX_LEASE_PREFIX}${sourcePath}`;
}

export function acquireRuntimeLease(
  db: Database.Database,
  leaseKey: string,
  ownerId: string,
  ttlMs: number = DEFAULT_LEASE_MS
): RuntimeLeaseResult {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  return db.transaction(() => {
    db.prepare(
      "DELETE FROM runtime_leases WHERE lease_key = ? AND expires_at <= ?"
    ).run(leaseKey, nowIso);

    const existing = db.prepare(
      "SELECT owner_id FROM runtime_leases WHERE lease_key = ?"
    ).get(leaseKey) as { owner_id: string } | undefined;

    if (existing && existing.owner_id !== ownerId) {
      return { acquired: false, leaseKey, ownerId };
    }

    if (existing && existing.owner_id === ownerId) {
      db.prepare(
        "UPDATE runtime_leases SET expires_at = ?, updated_at = ? WHERE lease_key = ? AND owner_id = ?"
      ).run(expiresAt, nowIso, leaseKey, ownerId);
      return { acquired: true, leaseKey, ownerId };
    }

    const result = db.prepare(
      "INSERT INTO runtime_leases (lease_key, owner_id, expires_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(leaseKey, ownerId, expiresAt, nowIso);

    return { acquired: result.changes === 1, leaseKey, ownerId };
  }).immediate();
}

export function renewRuntimeLease(
  db: Database.Database,
  leaseKey: string,
  ownerId: string,
  ttlMs: number = DEFAULT_LEASE_MS
): boolean {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const result = db.prepare(
    "UPDATE runtime_leases SET expires_at = ?, updated_at = ? WHERE lease_key = ? AND owner_id = ?"
  ).run(expiresAt, now.toISOString(), leaseKey, ownerId);
  return result.changes === 1;
}

export function releaseRuntimeLease(
  db: Database.Database,
  leaseKey: string,
  ownerId: string
): void {
  db.prepare(
    "DELETE FROM runtime_leases WHERE lease_key = ? AND owner_id = ?"
  ).run(leaseKey, ownerId);
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}
