/**
 * memory.stats — Memory store statistics.
 */
import type Database from "better-sqlite3";
import fs from "node:fs";

export interface StatsResult {
  total: number;
  deleted: number;
  totalCanonical: number;
  canonicalEvidenceLinks: number;
  byScope: Record<string, number>;
  bySource: Record<string, number>;
  byCanonicalKind: Record<string, number>;
  dbSizeBytes: number;
  lastIndexed: string | null;
  oldestMemory: string | null;
  newestMemory: string | null;
  totalSessions: number;
}

/**
 * Gather statistics about the memory store.
 */
export function memoryStats(db: Database.Database, dbPath?: string): StatsResult {
  const total = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE deleted = 0").get() as { c: number }).c;
  const deleted = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE deleted = 1").get() as { c: number }).c;
  const totalCanonical = (db.prepare("SELECT COUNT(*) as c FROM canonical_memories").get() as { c: number }).c;
  const canonicalEvidenceLinks = (db.prepare("SELECT COUNT(*) as c FROM canonical_evidence").get() as { c: number }).c;

  // By scope
  const scopeRows = db.prepare(
    "SELECT scope, COUNT(*) as c FROM memories WHERE deleted = 0 GROUP BY scope ORDER BY c DESC"
  ).all() as Array<{ scope: string; c: number }>;
  const byScope: Record<string, number> = {};
  for (const row of scopeRows) byScope[row.scope] = row.c;

  // By source
  const sourceRows = db.prepare(
    "SELECT source, COUNT(*) as c FROM memories WHERE deleted = 0 GROUP BY source ORDER BY c DESC"
  ).all() as Array<{ source: string; c: number }>;
  const bySource: Record<string, number> = {};
  for (const row of sourceRows) bySource[row.source] = row.c;

  const canonicalKindRows = db.prepare(
    "SELECT kind, COUNT(*) as c FROM canonical_memories GROUP BY kind ORDER BY c DESC"
  ).all() as Array<{ kind: string; c: number }>;
  const byCanonicalKind: Record<string, number> = {};
  for (const row of canonicalKindRows) byCanonicalKind[row.kind] = row.c;

  // Timestamps
  const lastIndexed = (db.prepare(
    "SELECT MAX(created_at) as t FROM memories WHERE deleted = 0"
  ).get() as { t: string | null }).t;

  const oldestMemory = (db.prepare(
    "SELECT MIN(created_at) as t FROM memories WHERE deleted = 0"
  ).get() as { t: string | null }).t;

  const newestMemory = lastIndexed;

  // DB size
  let dbSizeBytes = 0;
  if (dbPath) {
    try {
      dbSizeBytes = fs.statSync(dbPath).size;
    } catch {}
  }

  // Sessions
  const totalSessions = (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;

  return {
    total,
    deleted,
    totalCanonical,
    canonicalEvidenceLinks,
    byScope,
    bySource,
    byCanonicalKind,
    dbSizeBytes,
    lastIndexed,
    oldestMemory,
    newestMemory,
    totalSessions,
  };
}
