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
  orphanedCanonicalEvidence: number;
  brokenCanonicalEdges: number;
  modelMismatch: Record<string, number>;
  brokenLinks: number;
  totalMemories: number;
  totalVectors: number;
  totalCanonical: number;
  healthy: boolean;
}

/**
 * Run health diagnostics on the unified memory database.
 *
 * Internally consolidates multiple orphan checks into a small number of
 * LEFT JOIN + CASE queries (was 9 NOT EXISTS full-scan subqueries).
 * Keeps the returned HealthResult shape identical to before.
 */
export function memoryHealth(db: Database.Database): HealthResult {
  // 1) Memories-side scan: total active + memories missing their vec sidecar.
  //    One table scan on memories with a LEFT JOIN to memory_vec.
  const memoriesRow = db.prepare(
    `SELECT
       COUNT(*) AS total_memories,
       SUM(CASE WHEN v.id IS NULL THEN 1 ELSE 0 END) AS orphaned_memories
     FROM memories m
     LEFT JOIN memory_vec v ON v.id = m.id
     WHERE m.deleted = 0`
  ).get() as { total_memories: number; orphaned_memories: number | null };

  const totalMemories = memoriesRow.total_memories ?? 0;
  const orphanedMemories = memoriesRow.orphaned_memories ?? 0;

  // 2) Sidecar-orphan scan: one query counts vec/fts/tags sidecar rows whose
  //    parent memory is missing or deleted. UNION ALL lets SQLite run three
  //    LEFT JOIN scans as one prepared statement, and we also collect
  //    totalVectors via the same pass.
  const sidecarRows = db.prepare(
    `SELECT kind, total, orphans FROM (
       SELECT 'vec' AS kind,
              COUNT(*) AS total,
              SUM(CASE WHEN m.id IS NULL THEN 1 ELSE 0 END) AS orphans
         FROM memory_vec v
         LEFT JOIN memories m ON m.id = v.id AND m.deleted = 0
       UNION ALL
       SELECT 'fts' AS kind,
              COUNT(*) AS total,
              SUM(CASE WHEN m.id IS NULL THEN 1 ELSE 0 END) AS orphans
         FROM memory_fts f
         LEFT JOIN memories m ON m.id = f.id AND m.deleted = 0
       UNION ALL
       SELECT 'tags' AS kind,
              COUNT(*) AS total,
              SUM(CASE WHEN m.id IS NULL THEN 1 ELSE 0 END) AS orphans
         FROM memory_tags t
         LEFT JOIN memories m ON m.id = t.memory_id AND m.deleted = 0
     )`
  ).all() as Array<{ kind: string; total: number; orphans: number | null }>;

  let totalVectors = 0;
  let orphanedVectors = 0;
  let orphanedFts = 0;
  let orphanedTags = 0;
  for (const row of sidecarRows) {
    const orphans = row.orphans ?? 0;
    if (row.kind === "vec") {
      totalVectors = row.total ?? 0;
      orphanedVectors = orphans;
    } else if (row.kind === "fts") {
      orphanedFts = orphans;
    } else if (row.kind === "tags") {
      orphanedTags = orphans;
    }
  }

  // 3) Canonical-side scan: total canonical memories + orphan evidence
  //    (evidence with missing canonical parent OR missing/deleted memory) +
  //    broken canonical edges (either endpoint missing). UNION ALL over three
  //    sub-scans, returning a single result row per category.
  const canonicalRows = db.prepare(
    `SELECT kind, c FROM (
       SELECT 'canonical_total' AS kind, COUNT(*) AS c FROM canonical_memories
       UNION ALL
       SELECT 'canonical_evidence_orphans' AS kind, COUNT(*) AS c
         FROM canonical_evidence ce
         LEFT JOIN canonical_memories cm ON cm.id = ce.canonical_id
         LEFT JOIN memories m ON m.id = ce.memory_id AND m.deleted = 0
         WHERE cm.id IS NULL OR m.id IS NULL
       UNION ALL
       SELECT 'canonical_edges_broken' AS kind, COUNT(*) AS c
         FROM canonical_edges e
         LEFT JOIN canonical_memories cf ON cf.id = e.from_canonical_id
         LEFT JOIN canonical_memories ct ON ct.id = e.to_canonical_id
         WHERE cf.id IS NULL OR ct.id IS NULL
     )`
  ).all() as Array<{ kind: string; c: number }>;

  let totalCanonical = 0;
  let orphanedCanonicalEvidence = 0;
  let brokenCanonicalEdges = 0;
  for (const row of canonicalRows) {
    if (row.kind === "canonical_total") totalCanonical = row.c;
    else if (row.kind === "canonical_evidence_orphans") orphanedCanonicalEvidence = row.c;
    else if (row.kind === "canonical_edges_broken") brokenCanonicalEdges = row.c;
  }

  // 4) Broken links: memory_links rows whose from_id or to_id points at a
  //    missing or deleted memory. Single LEFT JOIN pass.
  const linksRow = db.prepare(
    `SELECT COUNT(*) AS c
       FROM memory_links l
       LEFT JOIN memories mf ON mf.id = l.from_id AND mf.deleted = 0
       LEFT JOIN memories mt ON mt.id = l.to_id AND mt.deleted = 0
      WHERE mf.id IS NULL OR mt.id IS NULL`
  ).get() as { c: number };
  const brokenLinks = linksRow.c;

  // 5) Model mismatch: GROUP BY embed_model (kept as a separate query since
  //    it returns N rows rather than a scalar).
  const modelRows = db.prepare(
    "SELECT COALESCE(embed_model, 'unknown') as model, COUNT(*) as c FROM memories WHERE deleted = 0 GROUP BY embed_model"
  ).all() as Array<{ model: string; c: number }>;
  const modelMismatch: Record<string, number> = {};
  for (const row of modelRows) {
    modelMismatch[row.model] = row.c;
  }

  const healthy = orphanedMemories === 0 && orphanedVectors === 0 &&
    orphanedFts === 0 && orphanedTags === 0 && orphanedCanonicalEvidence === 0 &&
    brokenLinks === 0 && brokenCanonicalEdges === 0;

  return {
    orphanedMemories,
    orphanedVectors,
    orphanedFts,
    orphanedTags,
    orphanedCanonicalEvidence,
    brokenCanonicalEdges,
    modelMismatch,
    brokenLinks,
    totalMemories,
    totalVectors,
    totalCanonical,
    healthy,
  };
}
