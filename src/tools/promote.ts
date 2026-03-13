import type Database from "better-sqlite3";
import { embed, type EmbedderOptions } from "../core/embedder.js";
import {
  addCanonicalEdge,
  createCanonicalMemory,
  insertCanonicalSearchArtifacts,
  type CanonicalKind,
  type CanonicalRelationType,
} from "../core/canonical-memory.js";

export interface PromoteParams {
  memoryIds: string[];
  kind: CanonicalKind;
  title: string;
  content: string;
  scope?: string;
  confidence?: number;
  importance?: number;
  validFrom?: string;
  decidedAt?: string;
  supersedes?: string[];
  contradicts?: string[];
}

export interface PromoteResult {
  canonicalId: string;
  kind: CanonicalKind;
  evidenceCount: number;
  decidedAt: string | null;
}

export async function memoryPromote(
  db: Database.Database,
  params: PromoteParams,
  embedOpts?: EmbedderOptions
): Promise<PromoteResult> {
  if (params.memoryIds.length === 0) {
    throw new Error("memoryIds must not be empty");
  }

  const activeRows = db.prepare(
    `SELECT id FROM memories WHERE deleted = 0 AND id IN (${params.memoryIds.map(() => "?").join(",")})`
  ).all(...params.memoryIds) as Array<{ id: string }>;

  if (activeRows.length !== params.memoryIds.length) {
    throw new Error("All memoryIds must reference active raw memories");
  }

  const { embedding } = await embed(params.content, embedOpts, true);
  const now = new Date().toISOString();
  const scope = params.scope ?? "global";

  let canonicalId = "";
  db.transaction(() => {
    canonicalId = createCanonicalMemory(db, {
      kind: params.kind,
      title: params.title,
      content: params.content,
      scope,
      confidence: params.confidence,
      importance: params.importance,
      validFrom: params.validFrom,
      decidedAt: params.decidedAt,
      createdAt: now,
      updatedAt: now,
      evidenceMemoryIds: params.memoryIds,
    });

    insertCanonicalSearchArtifacts(db, {
      id: canonicalId,
      title: params.title,
      content: params.content,
      scope,
      embedding,
    });

    const linkTargets: Array<[CanonicalRelationType, string[] | undefined]> = [
      ["supersedes", params.supersedes],
      ["contradicts", params.contradicts],
    ];

    for (const [relationType, ids] of linkTargets) {
      for (const id of ids ?? []) {
        addCanonicalEdge(db, {
          fromId: canonicalId,
          toId: id,
          relationType,
          createdAt: now,
        });
      }
    }
  })();

  return {
    canonicalId,
    kind: params.kind,
    evidenceCount: params.memoryIds.length,
    decidedAt: params.decidedAt ?? null,
  };
}
