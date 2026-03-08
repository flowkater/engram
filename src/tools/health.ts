/**
 * memory.health — Diagnose database integrity issues.
 * Reports orphaned records, model mismatches, and link integrity.
 */
import type Database from "better-sqlite3";

export interface HealthResult {
  orphanedMemories: number;
  orphanedVectors: number;
  orphanedFts: number;
  orphanedTags: number;
  modelMismatch: Record<string, number>;
  brokenLinks: number;
  totalMemories: number;
  totalVectors: number;
  healthy: boolean;
}

/**
 * Run health diagnostics on the unified memory database.
 */
export function memoryHealth(db: Database.Database): HealthResult {
  // Total active memories
  const { total: totalMemories } = db.prepare(
    "SELECT COUNT(*) as total FROM memories WHERE deleted = 0"
  ).get() as { total: number };

  // Total vectors
  const { total: totalVectors } = db.prepare(
    "SELECT COUNT(*) as total FROM memory_vec"
  ).get() as { total: number };

  // Orphaned memories: in memories(deleted=0) but not in memory_vec
  const { c: orphanedMemories } = db.prepare(
    `SELECT COUNT(*) as c FROM memories m
     WHERE m.deleted = 0 AND NOT EXISTS (SELECT 1 FROM memory_vec v WHERE v.id = m.id)`
  ).get() as { c: number };

  // Orphaned vectors: in memory_vec but not in memories(deleted=0)
  const { c: orphanedVectors } = db.prepare(
    `SELECT COUNT(*) as c FROM memory_vec v
     WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = v.id AND m.deleted = 0)`
  ).get() as { c: number };

  // Orphaned FTS: in memory_fts but not in memories(deleted=0)
  const { c: orphanedFts } = db.prepare(
    `SELECT COUNT(*) as c FROM memory_fts f
     WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = f.id AND m.deleted = 0)`
  ).get() as { c: number };

  // Orphaned tags: in memory_tags but not in memories(deleted=0)
  const { c: orphanedTags } = db.prepare(
    `SELECT COUNT(*) as c FROM memory_tags t
     WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = t.memory_id AND m.deleted = 0)`
  ).get() as { c: number };

  // Model mismatch: count by embed_model
  const modelRows = db.prepare(
    "SELECT COALESCE(embed_model, 'unknown') as model, COUNT(*) as c FROM memories WHERE deleted = 0 GROUP BY embed_model"
  ).all() as Array<{ model: string; c: number }>;
  const modelMismatch: Record<string, number> = {};
  for (const row of modelRows) {
    modelMismatch[row.model] = row.c;
  }

  // Broken links: from_id or to_id references non-existent active memory
  const { c: brokenLinks } = db.prepare(
    `SELECT COUNT(*) as c FROM memory_links l
     WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = l.from_id AND m.deleted = 0)
        OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = l.to_id AND m.deleted = 0)`
  ).get() as { c: number };

  const healthy = orphanedMemories === 0 && orphanedVectors === 0 &&
    orphanedFts === 0 && orphanedTags === 0 && brokenLinks === 0;

  return {
    orphanedMemories,
    orphanedVectors,
    orphanedFts,
    orphanedTags,
    modelMismatch,
    brokenLinks,
    totalMemories,
    totalVectors,
    healthy,
  };
}
