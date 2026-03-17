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

export interface UpdateCanonicalMemoryInput {
  id: string;
  title: string;
  content: string;
  confidence: number;
  updatedAt?: string;
}

export interface MergeCandidateIntoCanonicalInput {
  canonicalId: string;
  title: string;
  content: string;
  confidence: number;
  evidenceMemoryIds: string[];
  embedding: Float32Array;
  updatedAt?: string;
}

export interface MergeCanonicalMemoriesInput {
  sourceCanonicalId: string;
  targetCanonicalId: string;
  updatedAt?: string;
}

export interface NearbyCanonicalMemoryRow {
  id: string;
  kind: CanonicalKind;
  title: string;
  content: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  valid_from: string | null;
  valid_to: string | null;
  decided_at: string | null;
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

export function updateCanonicalMemory(
  db: Database.Database,
  input: UpdateCanonicalMemoryInput
): void {
  const now = input.updatedAt ?? new Date().toISOString();

  db.prepare(`
    UPDATE canonical_memories
    SET title = ?, content = ?, confidence = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.title,
    input.content,
    input.confidence,
    now,
    input.id
  );
}

export function appendCanonicalEvidence(
  db: Database.Database,
  canonicalId: string,
  canonicalKind: CanonicalKind,
  memoryIds: string[],
  createdAt?: string
): void {
  const now = createdAt ?? new Date().toISOString();
  const evidenceRole = canonicalKind === "decision" ? "decision-context" : "source";
  const insertEvidence = db.prepare(`
    INSERT OR IGNORE INTO canonical_evidence (canonical_id, memory_id, evidence_role, created_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const memoryId of memoryIds) {
    insertEvidence.run(canonicalId, memoryId, evidenceRole, now);
  }
}

export function replaceCanonicalSearchArtifacts(
  db: Database.Database,
  input: CanonicalSearchArtifactsInput
): void {
  db.prepare("DELETE FROM canonical_memory_vec WHERE id = ?").run(input.id);
  db.prepare("DELETE FROM canonical_memory_fts WHERE id = ?").run(input.id);
  insertCanonicalSearchArtifacts(db, input);
}

export function removeCanonicalSearchArtifacts(
  db: Database.Database,
  canonicalId: string
): void {
  db.prepare("DELETE FROM canonical_memory_vec WHERE id = ?").run(canonicalId);
  db.prepare("DELETE FROM canonical_memory_fts WHERE id = ?").run(canonicalId);
}

export function mergeCandidateIntoCanonical(
  db: Database.Database,
  input: MergeCandidateIntoCanonicalInput
): void {
  const canonical = getCanonicalMemory(db, input.canonicalId);
  if (!canonical) {
    throw new Error(`Canonical memory not found: ${input.canonicalId}`);
  }

  const updatedAt = input.updatedAt ?? new Date().toISOString();
  updateCanonicalMemory(db, {
    id: input.canonicalId,
    title: input.title,
    content: input.content,
    confidence: input.confidence,
    updatedAt,
  });
  appendCanonicalEvidence(
    db,
    input.canonicalId,
    canonical.kind,
    input.evidenceMemoryIds,
    updatedAt
  );
  replaceCanonicalSearchArtifacts(db, {
    id: input.canonicalId,
    title: input.title,
    content: input.content,
    scope: canonical.scope,
    embedding: input.embedding,
  });
}

export function mergeCanonicalMemories(
  db: Database.Database,
  input: MergeCanonicalMemoriesInput
): void {
  if (input.sourceCanonicalId === input.targetCanonicalId) {
    throw new Error("sourceCanonicalId and targetCanonicalId must differ");
  }

  const source = getCanonicalMemory(db, input.sourceCanonicalId);
  const target = getCanonicalMemory(db, input.targetCanonicalId);
  if (!source || !target) {
    throw new Error("Both source and target canonical memories must exist");
  }

  const now = input.updatedAt ?? new Date().toISOString();
  const evidenceRows = listCanonicalEvidence(db, input.sourceCanonicalId);
  appendCanonicalEvidence(
    db,
    input.targetCanonicalId,
    target.kind,
    evidenceRows.map((row) => row.memory_id),
    now
  );

  if (source.confidence > target.confidence) {
    updateCanonicalMemory(db, {
      id: target.id,
      title: target.title,
      content: target.content,
      confidence: source.confidence,
      updatedAt: now,
    });
  }

  const outgoingEdges = db.prepare(`
    SELECT to_canonical_id, relation_type
    FROM canonical_edges
    WHERE from_canonical_id = ?
  `).all(input.sourceCanonicalId) as Array<{
    to_canonical_id: string;
    relation_type: CanonicalRelationType;
  }>;

  for (const edge of outgoingEdges) {
    if (edge.to_canonical_id === input.targetCanonicalId) continue;
    addCanonicalEdge(db, {
      fromId: input.targetCanonicalId,
      toId: edge.to_canonical_id,
      relationType: edge.relation_type,
      createdAt: now,
    });
  }

  const incomingEdges = db.prepare(`
    SELECT from_canonical_id, relation_type
    FROM canonical_edges
    WHERE to_canonical_id = ?
  `).all(input.sourceCanonicalId) as Array<{
    from_canonical_id: string;
    relation_type: CanonicalRelationType;
  }>;

  for (const edge of incomingEdges) {
    if (edge.from_canonical_id === input.targetCanonicalId) continue;
    if (edge.relation_type === "supersedes") continue;
    addCanonicalEdge(db, {
      fromId: edge.from_canonical_id,
      toId: input.targetCanonicalId,
      relationType: edge.relation_type,
      createdAt: now,
    });
  }

  addCanonicalEdge(db, {
    fromId: input.targetCanonicalId,
    toId: input.sourceCanonicalId,
    relationType: "supersedes",
    createdAt: now,
  });
  removeCanonicalSearchArtifacts(db, input.sourceCanonicalId);
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

export function listNearbyCanonicalMemories(
  db: Database.Database,
  scope: string,
  limit: number,
  now: string
): NearbyCanonicalMemoryRow[] {
  return db.prepare(`
    SELECT id, kind, title, content, confidence, created_at, updated_at, valid_from, valid_to, decided_at
    FROM canonical_memories
    WHERE scope = ?
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_to IS NULL OR valid_to >= ?)
    ORDER BY confidence DESC, updated_at DESC, created_at DESC
    LIMIT ?
  `).all(scope, now, now, limit) as NearbyCanonicalMemoryRow[];
}
