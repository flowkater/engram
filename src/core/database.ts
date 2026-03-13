/**
 * Database layer — SQLite + WAL mode + FTS5 + sqlite-vec initialization.
 * Provides the core storage for unified memory.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_DB_PATH = path.join(
  process.env.MEMORY_DB || path.join(process.env.HOME || "~", ".engram", "memory.db")
);
const DB_OPEN_RETRY_MS = 100;
const DB_OPEN_RETRY_ATTEMPTS = 10;

const SCHEMA_SQL = `
-- Main memories table
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  summary TEXT,
  source TEXT NOT NULL,
  source_path TEXT,
  source_hash TEXT,
  chunk_index INTEGER DEFAULT 0,
  scope TEXT DEFAULT 'global',
  agent TEXT,
  tags TEXT DEFAULT '[]',
  importance REAL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accessed_at TEXT,
  access_count INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  embed_model TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);

-- Links table
CREATE TABLE IF NOT EXISTS memory_links (
  from_id TEXT NOT NULL REFERENCES memories(id),
  to_id TEXT NOT NULL REFERENCES memories(id),
  link_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_links_from ON memory_links(from_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON memory_links(to_id);
CREATE INDEX IF NOT EXISTS idx_links_type ON memory_links(link_type);

-- Tag normalization table
CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON memory_tags(tag);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  scope TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  memory_ids TEXT DEFAULT '[]'
);

-- File-level checkpoints for diffScan
CREATE TABLE IF NOT EXISTS file_checkpoints (
  source_path TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  file_mtime_ms INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_source ON file_checkpoints(source);

-- Runtime leases for cross-process coordination
CREATE TABLE IF NOT EXISTS runtime_leases (
  lease_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runtime_leases_expires_at ON runtime_leases(expires_at);

-- Canonical memory layer (Phase 2)
CREATE TABLE IF NOT EXISTS canonical_memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  valid_from TEXT,
  valid_to TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canonical_scope ON canonical_memories(scope);
CREATE INDEX IF NOT EXISTS idx_canonical_kind ON canonical_memories(kind);
CREATE INDEX IF NOT EXISTS idx_canonical_valid_from ON canonical_memories(valid_from);
CREATE INDEX IF NOT EXISTS idx_canonical_valid_to ON canonical_memories(valid_to);

CREATE TABLE IF NOT EXISTS canonical_evidence (
  canonical_id TEXT NOT NULL REFERENCES canonical_memories(id),
  memory_id TEXT NOT NULL REFERENCES memories(id),
  evidence_role TEXT NOT NULL CHECK (evidence_role IN ('source', 'decision-context')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (canonical_id, memory_id, evidence_role)
);
CREATE INDEX IF NOT EXISTS idx_canonical_evidence_canonical ON canonical_evidence(canonical_id);
CREATE INDEX IF NOT EXISTS idx_canonical_evidence_memory ON canonical_evidence(memory_id);

CREATE TABLE IF NOT EXISTS canonical_edges (
  from_canonical_id TEXT NOT NULL REFERENCES canonical_memories(id),
  to_canonical_id TEXT NOT NULL REFERENCES canonical_memories(id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('supersedes', 'contradicts')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_canonical_id, to_canonical_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_canonical_edges_from ON canonical_edges(from_canonical_id);
CREATE INDEX IF NOT EXISTS idx_canonical_edges_to ON canonical_edges(to_canonical_id);
`;

/** Initialize the vector virtual table (sqlite-vec). */
function initVec(db: Database.Database): void {
  // Check if vec table already exists
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vec'"
  ).get();
  if (!exists) {
    db.exec(`
      CREATE VIRTUAL TABLE memory_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[768]
      );
    `);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableDbOpenError(err: unknown): boolean {
  const message = (err as Error).message.toLowerCase();
  return message.includes("database is locked") || message.includes("sqlite_busy");
}

/** Initialize the FTS5 virtual table. */
function initFts(db: Database.Database): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'"
  ).get();
  if (!exists) {
    db.exec(`
      CREATE VIRTUAL TABLE memory_fts USING fts5(
        id,
        content,
        summary,
        tags,
        scope,
        tokenize = "unicode61"
      );
    `);
  }
}

/** Initialize the canonical vector virtual table. */
function initCanonicalVec(db: Database.Database): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_memory_vec'"
  ).get();
  if (!exists) {
    db.exec(`
      CREATE VIRTUAL TABLE canonical_memory_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[768]
      );
    `);
  }
}

/** Initialize the canonical FTS5 virtual table. */
function initCanonicalFts(db: Database.Database): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_memory_fts'"
  ).get();
  if (!exists) {
    db.exec(`
      CREATE VIRTUAL TABLE canonical_memory_fts USING fts5(
        id,
        title,
        content,
        scope,
        tokenize = "unicode61"
      );
    `);
  }
}

export interface DatabaseInstance {
  db: Database.Database;
  close(): void;
}

/**
 * Open (or create) the unified memory database.
 * Initializes WAL mode, sqlite-vec, FTS5, and all schema tables.
 */
export function openDatabase(dbPath: string = DEFAULT_DB_PATH): DatabaseInstance {
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  for (let attempt = 0; attempt < DB_OPEN_RETRY_ATTEMPTS; attempt += 1) {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath);

      // WAL mode for concurrent reads
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      db.pragma("foreign_keys = ON");

      // Load sqlite-vec extension
      sqliteVec.load(db);

      // Create schema
      db.exec(SCHEMA_SQL);
      initVec(db);
      initFts(db);
      initCanonicalVec(db);
      initCanonicalFts(db);

      // Add embed_model column if not present (migration)
      const cols = db.pragma("table_info(memories)") as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "embed_model")) {
        db.exec("ALTER TABLE memories ADD COLUMN embed_model TEXT");
      }

      // Migration: soft-delete records with relative source_path (Phase 0 → Phase 1)
      const relativePaths = db.prepare(
        "SELECT DISTINCT source_path FROM memories WHERE deleted = 0 AND source_path IS NOT NULL AND source_path != '' AND source_path NOT LIKE '/%'"
      ).all() as Array<{ source_path: string }>;

      if (relativePaths.length > 0) {
        console.warn(
          `[database] Found ${relativePaths.length} relative source_path(s) — soft-deleting legacy records`
        );
        const softDelete = db.prepare(
          "UPDATE memories SET deleted = 1 WHERE source_path = ? AND deleted = 0"
        );
        db.transaction(() => {
          for (const row of relativePaths) {
            softDelete.run(row.source_path);
          }
        })();
      }

      return {
        db,
        close() {
          db.close();
        },
      };
    } catch (err) {
      try {
        db?.close();
      } catch {}

      const isLastAttempt = attempt === DB_OPEN_RETRY_ATTEMPTS - 1;
      if (isLastAttempt || !isRetryableDbOpenError(err)) {
        throw err;
      }

      sleepSync(DB_OPEN_RETRY_MS);
    }
  }

  throw new Error(`Failed to open database at ${dbPath}`);
}
