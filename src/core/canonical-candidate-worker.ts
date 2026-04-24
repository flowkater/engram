import type Database from "better-sqlite3";
import { embed } from "./embedder.js";
import { judgeCanonicalCandidate, type JudgeCandidateInput, type JudgeResult } from "./canonical-judge.js";
import {
  listQueuedCanonicalCandidates,
  markCanonicalCandidateApproved,
  markCanonicalCandidateMerged,
  markCanonicalCandidateProcessing,
  markCanonicalCandidateRejected,
  reclaimStaleProcessingCandidates,
  requeueCanonicalCandidateAfterTransientFailure,
  type CanonicalCandidateRow,
} from "./canonical-candidates.js";
import {
  createCanonicalMemory,
  insertCanonicalSearchArtifacts,
  listNearbyCanonicalMemories,
  mergeCandidateIntoCanonical,
} from "./canonical-memory.js";

export interface CanonicalCandidateWorkerOptions {
  pollMs?: number;
  idleMs?: number;
  nearbyLimit?: number;
  judgeCandidate?: (
    candidate: JudgeCandidateInput,
    nearbyCanonicals: Array<{
      id: string;
      kind: "fact" | "decision";
      title: string;
      content: string;
      scope: string;
      confidence: number;
      updatedAt: string;
      createdAt: string;
    }>
  ) => Promise<JudgeResult>;
  embedCanonical?: (text: string) => Promise<Float32Array>;
  onLog?: (message: string) => void;
  now?: () => string;
}

export interface CanonicalCandidateWorkerInstance {
  stop(): Promise<void>;
}

export const DEFAULT_CANDIDATE_WORKER_POLL_MS = 2000;
export const DEFAULT_CANDIDATE_WORKER_IDLE_MS = 10_000;
const DEFAULT_NEARBY_LIMIT = 10;

function touchProcessingLease(db: Database.Database, candidateId: string, now: string): void {
  db.prepare(`
    UPDATE canonical_candidates
    SET updated_at = ?
    WHERE id = ? AND status = 'processing'
  `).run(now, candidateId);
}

function toJudgeCandidateInput(candidate: CanonicalCandidateRow): JudgeCandidateInput {
  return {
    id: candidate.id,
    scope: candidate.scope,
    candidateKind: candidate.candidate_kind,
    candidateTitle: candidate.candidate_title,
    candidateContent: candidate.candidate_content,
  };
}

function toNearbyJudgeContext(
  rows: ReturnType<typeof listNearbyCanonicalMemories>,
  scope: string
): Array<{
  id: string;
  kind: "fact" | "decision";
  title: string;
  content: string;
  scope: string;
  confidence: number;
  updatedAt: string;
  createdAt: string;
}> {
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    scope,
    confidence: row.confidence,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  }));
}

export function startCanonicalCandidateWorker(
  db: Database.Database,
  opts?: CanonicalCandidateWorkerOptions
): CanonicalCandidateWorkerInstance {
  const pollMs = opts?.pollMs ?? DEFAULT_CANDIDATE_WORKER_POLL_MS;
  const idleMs = opts?.idleMs ?? DEFAULT_CANDIDATE_WORKER_IDLE_MS;
  const nearbyLimit = opts?.nearbyLimit ?? DEFAULT_NEARBY_LIMIT;
  const judgeCandidate = opts?.judgeCandidate ?? judgeCanonicalCandidate;
  const embedCanonical = opts?.embedCanonical ?? ((text: string) => embed(text));
  const onLog = opts?.onLog ?? (() => {});
  const now = opts?.now ?? (() => new Date().toISOString());

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeRun: Promise<void> | null = null;

  function scheduleNext(delayMs = pollMs): void {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void runOnce();
    }, delayMs);
  }

  async function processCandidate(candidate: CanonicalCandidateRow): Promise<void> {
    const startedAt = now();
    const claimed = markCanonicalCandidateProcessing(db, candidate.id, startedAt);
    if (!claimed) return;

    try {
      const nearby = toNearbyJudgeContext(
        listNearbyCanonicalMemories(db, candidate.scope, nearbyLimit, startedAt),
        candidate.scope
      );
      const judged = await judgeCandidate(toJudgeCandidateInput(candidate), nearby);
      touchProcessingLease(db, candidate.id, now());

      if (judged.action === "retry") {
        requeueCanonicalCandidateAfterTransientFailure(db, {
          id: candidate.id,
          rationale: judged.rationale,
        }, now());
        return;
      }

      if (judged.action === "reject") {
        markCanonicalCandidateRejected(db, {
          id: candidate.id,
          confidence: judged.confidence,
          rationale: judged.rationale,
          matchedCanonicalId: judged.matchedCanonicalId ?? null,
          now: now(),
        });
        return;
      }

      let embedding: Float32Array;
      try {
        embedding = await embedCanonical(judged.content);
      } catch (error) {
        requeueCanonicalCandidateAfterTransientFailure(db, {
          id: candidate.id,
          rationale: `Embedding failed: ${(error as Error).message}`,
        }, now());
        return;
      }

      const updatedAt = now();
      if (judged.matchedCanonicalId) {
        db.transaction(() => {
          mergeCandidateIntoCanonical(db, {
            canonicalId: judged.matchedCanonicalId!,
            title: judged.title,
            content: judged.content,
            confidence: judged.confidence,
            evidenceMemoryIds: [candidate.raw_memory_id],
            embedding,
            updatedAt,
          });
          markCanonicalCandidateMerged(db, {
            id: candidate.id,
            candidateKind: judged.canonicalKind,
            candidateTitle: judged.title,
            candidateContent: judged.content,
            confidence: judged.confidence,
            rationale: judged.rationale,
            matchedCanonicalId: judged.matchedCanonicalId!,
            now: updatedAt,
          });
        })();
        return;
      }

      db.transaction(() => {
        const canonicalId = createCanonicalMemory(db, {
          kind: judged.canonicalKind,
          title: judged.title,
          content: judged.content,
          scope: candidate.scope,
          confidence: judged.confidence,
          evidenceMemoryIds: [candidate.raw_memory_id],
          updatedAt,
          createdAt: updatedAt,
        });
        insertCanonicalSearchArtifacts(db, {
          id: canonicalId,
          title: judged.title,
          content: judged.content,
          scope: candidate.scope,
          embedding,
        });
        markCanonicalCandidateApproved(db, {
          id: candidate.id,
          candidateKind: judged.canonicalKind,
          candidateTitle: judged.title,
          candidateContent: judged.content,
          confidence: judged.confidence,
          rationale: judged.rationale,
          matchedCanonicalId: null,
          now: updatedAt,
        });
      })();
    } catch (error) {
      onLog(`Candidate worker failed to process ${candidate.id}: ${(error as Error).message}`);
      requeueCanonicalCandidateAfterTransientFailure(db, {
        id: candidate.id,
        rationale: `Worker failed: ${(error as Error).message}`,
      }, now());
    }
  }

  async function runOnce(): Promise<void> {
    if (stopped || activeRun) return;

    let foundCandidate = false;
    activeRun = (async () => {
      const currentNow = now();
      reclaimStaleProcessingCandidates(db, { limit: 10 }, currentNow);
      const candidate = listQueuedCanonicalCandidates(db, 1, currentNow)[0];
      if (candidate) {
        foundCandidate = true;
        await processCandidate(candidate);
      }
    })();

    try {
      await activeRun;
    } finally {
      activeRun = null;
      scheduleNext(foundCandidate ? pollMs : idleMs);
    }
  }

  void runOnce();

  return {
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (activeRun) {
        await activeRun;
      }
    },
  };
}
