import type Database from "better-sqlite3";
import { v7 as uuidv7 } from "uuid";

export type CanonicalKind = "fact" | "decision";
export type CanonicalRelationType = "supersedes" | "contradicts";

export interface CreateCanonicalMemoryInput {
  id?: string;
  kind: CanonicalKind;
  title: string;
  content: string;
  scope?: string;
  importance?: number;
  confidence?: number;
  validFrom?: string;
  validTo?: string;
  decidedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  evidenceMemoryIds: string[];
}

export interface CanonicalMemoryRow {
  id: string;
  kind: CanonicalKind;
  title: string;
  content: string;
  scope: string;
  importance: number;
  confidence: number;
  valid_from: string | null;
  valid_to: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AddCanonicalEdgeInput {
  fromId: string;
  toId: string;
  relationType: CanonicalRelationType;
  createdAt?: string;
}

export interface CanonicalSearchArtifactsInput {
  id: string;
  title: string;
  content: string;
  scope: string;
  embedding: Float32Array;
}

export function createCanonicalMemory(
  db: Database.Database,
  input: CreateCanonicalMemoryInput
): string {
  const id = input.id ?? uuidv7();
  const now = input.createdAt ?? new Date().toISOString();
  const updatedAt = input.updatedAt ?? now;
  const scope = input.scope ?? "global";
  const importance = input.importance ?? 0.5;
  const confidence = input.confidence ?? 0.5;

  db.prepare(`
    INSERT INTO canonical_memories (
      id, kind, title, content, scope, importance, confidence,
      valid_from, valid_to, decided_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.kind,
    input.title,
    input.content,
    scope,
    importance,
    confidence,
    input.validFrom ?? null,
    input.validTo ?? null,
    input.decidedAt ?? null,
    now,
    updatedAt
  );

  const insertEvidence = db.prepare(`
    INSERT OR IGNORE INTO canonical_evidence (canonical_id, memory_id, evidence_role, created_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const memoryId of input.evidenceMemoryIds) {
    insertEvidence.run(id, memoryId, input.kind === "decision" ? "decision-context" : "source", now);
  }

  return id;
}

export function insertCanonicalSearchArtifacts(
  db: Database.Database,
  input: CanonicalSearchArtifactsInput
): void {
  db.prepare(
    "INSERT INTO canonical_memory_vec (id, embedding) VALUES (?, ?)"
  ).run(input.id, Buffer.from(input.embedding.buffer));

  db.prepare(
    "INSERT INTO canonical_memory_fts (id, title, content, scope) VALUES (?, ?, ?, ?)"
  ).run(input.id, input.title, input.content, input.scope);
}

export function addCanonicalEdge(
  db: Database.Database,
  input: AddCanonicalEdgeInput
): void {
  const now = input.createdAt ?? new Date().toISOString();

  db.prepare(`
    INSERT OR IGNORE INTO canonical_edges (from_canonical_id, to_canonical_id, relation_type, created_at)
    VALUES (?, ?, ?, ?)
  `).run(input.fromId, input.toId, input.relationType, now);

  if (input.relationType === "supersedes") {
    const source = getCanonicalMemory(db, input.fromId);
    const validTo = source?.valid_from ?? source?.decided_at ?? source?.created_at ?? now;
    db.prepare(
      "UPDATE canonical_memories SET valid_to = ?, updated_at = ? WHERE id = ?"
    ).run(validTo, now, input.toId);
  }
}

export function getCanonicalMemory(
  db: Database.Database,
  id: string
): CanonicalMemoryRow | undefined {
  return db.prepare(`
    SELECT id, kind, title, content, scope, importance, confidence,
           valid_from, valid_to, decided_at, created_at, updated_at
    FROM canonical_memories
    WHERE id = ?
  `).get(id) as CanonicalMemoryRow | undefined;
}

export function listCanonicalEvidence(
  db: Database.Database,
  canonicalId: string
): Array<{ canonical_id: string; memory_id: string; evidence_role: string; created_at: string }> {
  return db.prepare(`
    SELECT canonical_id, memory_id, evidence_role, created_at
    FROM canonical_evidence
    WHERE canonical_id = ?
    ORDER BY created_at ASC
  `).all(canonicalId) as Array<{ canonical_id: string; memory_id: string; evidence_role: string; created_at: string }>;
}
