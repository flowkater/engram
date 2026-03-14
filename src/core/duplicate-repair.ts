import type Database from "better-sqlite3";
import fs from "node:fs";
import { deleteRelatedRecords } from "../utils/delete-related.js";

const SQLITE_UPDATE_BATCH_SIZE = 400;

interface ActiveMemoryRow {
  id: string;
  source: string;
  source_path: string;
  source_hash: string | null;
  chunk_index: number;
  updated_at: string;
}

interface NullSourceSessionRow {
  id: string;
  scope: string;
  agent: string | null;
  content: string;
  summary: string | null;
  chunk_index: number;
  embed_model: string | null;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
  access_count: number;
}

interface HashGroupSummary {
  hashKey: string;
  rows: ActiveMemoryRow[];
  distinctChunkCount: number;
  latestUpdatedAt: string;
  newestId: string;
}

interface CheckpointPlan {
  action: "upsert" | "delete";
  source: string;
  fileMtimeMs?: number;
}

export interface DuplicateRepairItem {
  sourcePath: string;
  keepHash: string | null;
  keepIds: string[];
  deleteIds: string[];
  activeRows: number;
  distinctChunkCount: number;
  distinctHashCount: number;
  checkpoint: CheckpointPlan;
}

export interface DuplicateRepairPlan {
  candidates: number;
  duplicateRows: number;
  keptRows: number;
  items: DuplicateRepairItem[];
}

export interface DuplicateRepairResult extends DuplicateRepairPlan {
  dryRun: boolean;
  repairedFiles: number;
  repairedRows: number;
}

export interface NullSourceSessionDuplicateItem {
  keepId: string;
  deleteIds: string[];
  scope: string;
  agent: string | null;
  chunkIndex: number;
  accessCount: number;
  accessedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface NullSourceSessionDuplicatePlan {
  candidates: number;
  duplicateRows: number;
  keptRows: number;
  items: NullSourceSessionDuplicateItem[];
}

export interface NullSourceSessionDuplicateResult extends NullSourceSessionDuplicatePlan {
  dryRun: boolean;
  repairedGroups: number;
  repairedRows: number;
}

export interface DuplicateRepairOptions {
  dryRun?: boolean;
  targetPaths?: string[];
}

export function planFileBackedDuplicateRepair(
  db: Database.Database,
  opts: Pick<DuplicateRepairOptions, "targetPaths"> = {}
): DuplicateRepairPlan {
  const candidatePaths = opts.targetPaths && opts.targetPaths.length > 0
    ? [...new Set(opts.targetPaths)]
    : (db.prepare(`
        SELECT source_path
        FROM memories
        WHERE deleted = 0
          AND source_path IS NOT NULL
          AND source_path != ''
        GROUP BY source_path
        HAVING count(*) > count(DISTINCT chunk_index)
            OR count(DISTINCT COALESCE(source_hash, '__null__')) > 1
        ORDER BY source_path
      `).all() as Array<{ source_path: string }>).map((row) => row.source_path);

  const items = candidatePaths
    .map((sourcePath) => buildRepairItem(db, sourcePath))
    .filter((item): item is DuplicateRepairItem => item !== null);

  return {
    candidates: items.length,
    duplicateRows: items.reduce((sum, item) => sum + item.deleteIds.length, 0),
    keptRows: items.reduce((sum, item) => sum + item.keepIds.length, 0),
    items,
  };
}

export function repairFileBackedDuplicates(
  db: Database.Database,
  opts: DuplicateRepairOptions = {}
): DuplicateRepairResult {
  const dryRun = opts.dryRun ?? true;
  const plan = planFileBackedDuplicateRepair(db, { targetPaths: opts.targetPaths });

  if (!dryRun) {
    for (const item of plan.items) {
      applyRepairItem(db, item);
    }
  }

  return {
    ...plan,
    dryRun,
    repairedFiles: dryRun ? 0 : plan.items.length,
    repairedRows: dryRun ? 0 : plan.duplicateRows,
  };
}

export function planNullSourceSessionDuplicates(
  db: Database.Database
): NullSourceSessionDuplicatePlan {
  const rows = db.prepare(`
    SELECT
      id,
      scope,
      agent,
      content,
      summary,
      chunk_index,
      embed_model,
      created_at,
      updated_at,
      accessed_at,
      access_count
    FROM memories
    WHERE deleted = 0
      AND source = 'session'
      AND (source_path IS NULL OR source_path = '')
    ORDER BY updated_at DESC, id DESC
  `).all() as NullSourceSessionRow[];

  const groups = new Map<string, NullSourceSessionRow[]>();
  for (const row of rows) {
    const key = [
      row.scope,
      row.agent ?? "",
      row.chunk_index,
      row.embed_model ?? "",
      row.content,
      row.summary ?? "",
    ].join("\u001f");
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const items = Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((group): NullSourceSessionDuplicateItem => {
      const sorted = [...group].sort((a, b) => {
        if (a.updated_at !== b.updated_at) {
          return b.updated_at.localeCompare(a.updated_at);
        }
        return b.id.localeCompare(a.id);
      });
      const keep = sorted[0];
      const deleteIds = sorted.slice(1).map((row) => row.id);
      const accessedAt = group
        .map((row) => row.accessed_at)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
      const createdAt = [...group]
        .map((row) => row.created_at)
        .sort()[0];
      const updatedAt = [...group]
        .map((row) => row.updated_at)
        .sort()
        .at(-1) ?? keep.updated_at;

      return {
        keepId: keep.id,
        deleteIds,
        scope: keep.scope,
        agent: keep.agent,
        chunkIndex: keep.chunk_index,
        accessCount: group.reduce((sum, row) => sum + row.access_count, 0),
        accessedAt,
        updatedAt,
        createdAt,
      };
    })
    .sort((a, b) => b.deleteIds.length - a.deleteIds.length || a.keepId.localeCompare(b.keepId));

  return {
    candidates: items.length,
    duplicateRows: items.reduce((sum, item) => sum + item.deleteIds.length, 0),
    keptRows: items.length,
    items,
  };
}

export function repairNullSourceSessionDuplicates(
  db: Database.Database,
  dryRun = true
): NullSourceSessionDuplicateResult {
  const plan = planNullSourceSessionDuplicates(db);

  if (!dryRun) {
    for (const item of plan.items) {
      applyNullSourceSessionRepairItem(db, item);
    }
  }

  return {
    ...plan,
    dryRun,
    repairedGroups: dryRun ? 0 : plan.items.length,
    repairedRows: dryRun ? 0 : plan.duplicateRows,
  };
}

function buildRepairItem(
  db: Database.Database,
  sourcePath: string
): DuplicateRepairItem | null {
  const rows = db.prepare(`
    SELECT id, source, source_path, source_hash, chunk_index, updated_at
    FROM memories
    WHERE deleted = 0
      AND source_path = ?
    ORDER BY updated_at DESC, id DESC
  `).all(sourcePath) as ActiveMemoryRow[];

  if (rows.length === 0) return null;

  const byHash = new Map<string, ActiveMemoryRow[]>();
  for (const row of rows) {
    const hashKey = row.source_hash ?? "__null__";
    const group = byHash.get(hashKey) ?? [];
    group.push(row);
    byHash.set(hashKey, group);
  }

  const groups = Array.from(byHash.entries())
    .map(([hashKey, group]): HashGroupSummary => ({
      hashKey,
      rows: group,
      distinctChunkCount: new Set(group.map((row) => row.chunk_index)).size,
      latestUpdatedAt: group[0]?.updated_at ?? "",
      newestId: group[0]?.id ?? "",
    }))
    .sort((a, b) => {
      if (a.distinctChunkCount !== b.distinctChunkCount) {
        return b.distinctChunkCount - a.distinctChunkCount;
      }
      if (a.latestUpdatedAt !== b.latestUpdatedAt) {
        return b.latestUpdatedAt.localeCompare(a.latestUpdatedAt);
      }
      return b.newestId.localeCompare(a.newestId);
    });

  const keepHashKey = groups[0]?.hashKey;

  if (!keepHashKey) return null;

  const keepHashRows = byHash.get(keepHashKey) ?? [];
  const keepIds = new Set<string>();
  const chunkRows = new Map<number, ActiveMemoryRow[]>();

  for (const row of keepHashRows) {
    const group = chunkRows.get(row.chunk_index) ?? [];
    group.push(row);
    chunkRows.set(row.chunk_index, group);
  }

  for (const group of chunkRows.values()) {
    group.sort((a, b) => {
      if (a.updated_at !== b.updated_at) {
        return b.updated_at.localeCompare(a.updated_at);
      }
      return b.id.localeCompare(a.id);
    });
    keepIds.add(group[0].id);
  }

  const deleteIds = rows
    .filter((row) => !keepIds.has(row.id))
    .map((row) => row.id);

  if (deleteIds.length === 0) return null;

  const checkpoint = buildCheckpointPlan(sourcePath, keepHashRows[0]?.source ?? "obsidian");

  return {
    sourcePath,
    keepHash: keepHashKey === "__null__" ? null : keepHashKey,
    keepIds: Array.from(keepIds).sort(),
    deleteIds,
    activeRows: rows.length,
    distinctChunkCount: new Set(rows.map((row) => row.chunk_index)).size,
    distinctHashCount: new Set(rows.map((row) => row.source_hash ?? "__null__")).size,
    checkpoint,
  };
}

function buildCheckpointPlan(sourcePath: string, source: string): CheckpointPlan {
  if (!fs.existsSync(sourcePath)) {
    return { action: "delete", source };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return { action: "delete", source };
  }

  return {
    action: "upsert",
    source,
    fileMtimeMs: stat.mtimeMs,
  };
}

function applyRepairItem(db: Database.Database, item: DuplicateRepairItem): void {
  if (item.deleteIds.length === 0) return;

  const now = new Date().toISOString();
  const upsertCheckpoint = db.prepare(`
    INSERT OR REPLACE INTO file_checkpoints (source_path, source, file_mtime_ms, indexed_at)
    VALUES (?, ?, ?, ?)
  `);
  const deleteCheckpoint = db.prepare(
    "DELETE FROM file_checkpoints WHERE source_path = ?"
  );

  db.transaction(() => {
    softDeleteIds(db, item.deleteIds, now);
    deleteRelatedRecords(db, item.deleteIds);

    if (item.checkpoint.action === "upsert" && item.checkpoint.fileMtimeMs !== undefined) {
      upsertCheckpoint.run(
        item.sourcePath,
        item.checkpoint.source,
        item.checkpoint.fileMtimeMs,
        now
      );
    } else {
      deleteCheckpoint.run(item.sourcePath);
    }
  })();
}

function softDeleteIds(db: Database.Database, ids: string[], now: string): void {
  for (let i = 0; i < ids.length; i += SQLITE_UPDATE_BATCH_SIZE) {
    const batch = ids.slice(i, i + SQLITE_UPDATE_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");
    db.prepare(`
      UPDATE memories
      SET deleted = 1, updated_at = ?
      WHERE deleted = 0
        AND id IN (${placeholders})
    `).run(now, ...batch);
  }
}

function safeParseMemoryIds(memoryIds: string): string[] {
  try {
    const parsed = JSON.parse(memoryIds);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function applyNullSourceSessionRepairItem(
  db: Database.Database,
  item: NullSourceSessionDuplicateItem
): void {
  if (item.deleteIds.length === 0) return;

  const sessions = db.prepare(
    "SELECT id, memory_ids FROM sessions WHERE memory_ids IS NOT NULL AND memory_ids != '[]'"
  ).all() as Array<{ id: string; memory_ids: string }>;
  const updateSessionMemoryIds = db.prepare("UPDATE sessions SET memory_ids = ? WHERE id = ?");

  db.transaction(() => {
    db.prepare(`
      UPDATE memories
      SET access_count = ?,
          accessed_at = ?,
          updated_at = ?,
          created_at = ?
      WHERE id = ?
    `).run(
      item.accessCount,
      item.accessedAt,
      item.updatedAt,
      item.createdAt,
      item.keepId
    );

    for (let i = 0; i < item.deleteIds.length; i += SQLITE_UPDATE_BATCH_SIZE) {
      const batch = item.deleteIds.slice(i, i + SQLITE_UPDATE_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      db.prepare(`
        UPDATE memories
        SET deleted = 1, updated_at = ?
        WHERE deleted = 0
          AND id IN (${placeholders})
      `).run(item.updatedAt, ...batch);
    }

    deleteRelatedRecords(db, item.deleteIds);

    const deleteSet = new Set(item.deleteIds);
    for (const session of sessions) {
      const memoryIds = safeParseMemoryIds(session.memory_ids);
      const filtered = memoryIds.filter((id) => !deleteSet.has(id));
      if (filtered.length !== memoryIds.length) {
        updateSessionMemoryIds.run(JSON.stringify(filtered), session.id);
      }
    }
  })();
}
