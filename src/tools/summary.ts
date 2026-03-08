/**
 * memory.summary — Save a session summary to the memory store.
 */
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { embed, type EmbedderOptions } from "../core/embedder.js";

export interface SummaryParams {
  summary: string;
  sessionId?: string;
  scope?: string;
  tags?: string[];
  agent?: string;
}

export interface SummaryResult {
  memoryId: string;
  sessionId: string;
  scope: string;
  created_at: string;
}

/**
 * Save a session summary as a memory entry.
 */
export async function memorySummary(
  db: Database.Database,
  params: SummaryParams,
  embedOpts?: EmbedderOptions
): Promise<SummaryResult> {
  const memoryId = uuidv7();
  const sessionId = params.sessionId || uuidv7();
  const scope = params.scope || "global";
  const now = new Date().toISOString();
  const tags = JSON.stringify(params.tags || ["session-summary"]);

  // Generate embedding for the summary
  const embedding = await embed(params.summary, embedOpts);

  // Insert memory
  db.prepare(`
    INSERT INTO memories (id, content, summary, source, scope, agent, tags, importance, created_at, updated_at)
    VALUES (?, ?, ?, 'session', ?, ?, ?, 0.7, ?, ?)
  `).run(memoryId, params.summary, params.summary, scope, params.agent || null, tags, now, now);

  // Insert vector
  db.prepare("INSERT INTO memory_vec (id, embedding) VALUES (?, ?)").run(
    memoryId,
    Buffer.from(embedding.buffer)
  );

  // Insert FTS
  db.prepare("INSERT INTO memory_fts (id, content, summary, tags, scope) VALUES (?, ?, ?, ?, ?)").run(
    memoryId, params.summary, params.summary, tags, scope
  );

  // Upsert session record
  const existingSession = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
  if (existingSession) {
    db.prepare(`
      UPDATE sessions SET ended_at = ?, summary = ?,
        memory_ids = json_insert(memory_ids, '$[#]', ?)
      WHERE id = ?
    `).run(now, params.summary, memoryId, sessionId);
  } else {
    db.prepare(`
      INSERT INTO sessions (id, agent, scope, started_at, ended_at, summary, memory_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, params.agent || "unknown", scope, now, now, params.summary, JSON.stringify([memoryId]));
  }

  return {
    memoryId,
    sessionId,
    scope,
    created_at: now,
  };
}
