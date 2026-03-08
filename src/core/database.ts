/**
 * Database layer — SQLite + WAL mode + FTS5 + sqlite-vec initialization.
 * Provides the core storage for unified memory.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_DB_PATH = path.join(
  process.env.MEMORY_DB || path.join(process.env.HOME || "~", ".unified-memory", "memory.db")
);

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
  deleted INTEGER DEFAULT 0
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

  const db = new Database(dbPath);

  // WAL mode for concurrent reads
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Create schema
  db.exec(SCHEMA_SQL);
  initVec(db);
  initFts(db);

  // Add embed_model column if not present (migration)
  const cols = db.pragma("table_info(memories)") as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "embed_model")) {
    db.exec("ALTER TABLE memories ADD COLUMN embed_model TEXT");
  }

  return {
    db,
    close() {
      db.close();
    },
  };
}
