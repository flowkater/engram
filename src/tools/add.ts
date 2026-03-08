/**
 * memory.add — Save a new memory with embedding to the database.
 */
import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";
import { embed, getCurrentModelName, type EmbedderOptions } from "../core/embedder.js";
import { parseTags, insertTags } from "../utils/tags.js";

export interface AddParams {
  content: string;
  scope?: string;
  tags?: string[];
  importance?: number;
  summary?: string;
  source?: string;
  agent?: string;
}

export interface AddResult {
  id: string;
  scope: string;
  created_at: string;
}

/**
 * Add a memory: embed the content, store in memories table, vec index, and FTS index.
 */
export async function memoryAdd(
  db: Database.Database,
  params: AddParams,
  embedOpts?: EmbedderOptions
): Promise<AddResult> {
  const id = uuidv7();
  const now = new Date().toISOString();
  const scope = params.scope || "global";
  const tags = JSON.stringify(params.tags || []);
  const importance = params.importance ?? 0.5;
  const source = params.source || "manual";

  // Generate embedding (outside transaction — network I/O)
  const embedding = await embed(params.content, embedOpts);

  // Atomic insert: memories + vec + FTS
  db.transaction(() => {
    db.prepare(`
      INSERT INTO memories (id, content, summary, source, scope, agent, tags, importance, created_at, updated_at, embed_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, params.content, params.summary || null, source, scope, params.agent || null, tags, importance, now, now, getCurrentModelName(embedOpts));

    db.prepare(`
      INSERT INTO memory_vec (id, embedding)
      VALUES (?, ?)
    `).run(id, Buffer.from(embedding.buffer));

    db.prepare(`
      INSERT INTO memory_fts (id, content, summary, tags, scope)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, params.content, params.summary || "", tags, scope);

    // Insert normalized tags
    insertTags(db, id, parseTags(params.tags));
  })();

  return { id, scope, created_at: now };
}
