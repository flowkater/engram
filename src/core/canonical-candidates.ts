import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";

export type CanonicalCandidateStatus = "queued" | "processing" | "approved" | "merged" | "rejected";
export type CanonicalCandidateKind = "fact" | "decision" | "unknown";
export const CANONICAL_CANDIDATE_LEASE_MS = 30_000;

export const MAX_CANONICAL_CANDIDATE_RETRIES = 5;
const CANONICAL_CANDIDATE_BASE_BACKOFF_MS = 30_000;    // 30s
const CANONICAL_CANDIDATE_MAX_BACKOFF_MS = 60 * 60_000; // 1h

export function computeCanonicalCandidateBackoffMs(retryCount: number): number {
  // Exponential: 30s * 2^(retry-1), capped at 1h. retry=1 → 30s, retry=2 → 60s, retry=5 → 8m, retry=10 → 1h.
  const exp = CANONICAL_CANDIDATE_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, retryCount - 1));
  return Math.min(exp, CANONICAL_CANDIDATE_MAX_BACKOFF_MS);
}

export interface CanonicalCandidateRow {
  id: string;
  raw_memory_id: string;
  scope: string;
  status: CanonicalCandidateStatus;
  candidate_kind: CanonicalCandidateKind;
  candidate_title: string | null;
  candidate_content: string;
  priority_score: number;
  confidence: number | null;
  rationale: string | null;
  matched_canonical_id: string | null;
  content_fingerprint: string;
  retry_count: number;
  last_judged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CandidateFingerprintInput {
  content: string;
  summary?: string | null;
  scope?: string;
  tags?: string[];
  importance?: number;
}

export interface CandidatePriorityInput {
  content: string;
  summary?: string | null;
  tags?: string[];
  importance?: number;
}

export interface CandidateKindInput {
  content: string;
  summary?: string | null;
  tags?: string[];
}

export interface CandidateTitleInput {
  content: string;
  summary?: string | null;
}

export interface CandidateContentInput {
  content: string;
  summary?: string | null;
}

export interface EnqueueCanonicalCandidateInput {
  id?: string;
  rawMemoryId: string;
  scope?: string;
  candidateKind: CanonicalCandidateKind;
  candidateTitle?: string | null;
  candidateContent: string;
  priorityScore?: number;
  contentFingerprint: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RejectedCandidateSnapshot {
  status: CanonicalCandidateStatus;
  contentFingerprint: string;
}

export interface MarkCanonicalCandidateRejectedInput {
  id: string;
  confidence: number;
  rationale: string;
  matchedCanonicalId?: string | null;
  now: string;
}

export interface MarkCanonicalCandidateApprovedInput {
  id: string;
  candidateKind: CanonicalCandidateKind;
  candidateTitle: string;
  candidateContent: string;
  confidence: number;
  rationale: string;
  matchedCanonicalId?: string | null;
  now: string;
}

export interface MarkCanonicalCandidateMergedInput extends MarkCanonicalCandidateApprovedInput {
  matchedCanonicalId: string;
}

export interface RequeueCanonicalCandidateAfterTransientFailureInput {
  id: string;
  rationale: string;
}

export interface ReclaimStaleProcessingCandidatesInput {
  limit: number;
}

const IN_PROGRESS_CANDIDATE_STATUSES: CanonicalCandidateStatus[] = [
  "queued",
  "processing",
];
const HISTORICAL_MATCH_STATUSES: CanonicalCandidateStatus[] = [
  "approved",
  "merged",
];

function normalizeWhitespace(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeTags(tags: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (tags ?? [])
        .map((tag) => normalizeWhitespace(tag).toLowerCase())
        .filter(Boolean)
    )
  ).sort();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getCanonicalCandidateById(
  db: Database.Database,
  id: string
): CanonicalCandidateRow {
  return db.prepare(`
    SELECT id, raw_memory_id, scope, status, candidate_kind, candidate_title, candidate_content,
           priority_score, confidence, rationale, matched_canonical_id, content_fingerprint,
           retry_count, last_judged_at, created_at, updated_at
    FROM canonical_candidates
    WHERE id = ?
  `).get(id) as CanonicalCandidateRow;
}

export function buildCandidateFingerprint(input: CandidateFingerprintInput): string {
  const payload = JSON.stringify({
    content: normalizeWhitespace(input.content),
    summary: normalizeWhitespace(input.summary),
    scope: normalizeWhitespace(input.scope) || "global",
    tags: normalizeTags(input.tags),
    importance: input.importance ?? 0.5,
  });

  return createHash("sha256").update(payload).digest("hex");
}

export function scoreCandidatePriority(input: CandidatePriorityInput): number {
  const content = normalizeWhitespace(input.content).toLowerCase();
  const summary = normalizeWhitespace(input.summary).toLowerCase();
  const tags = normalizeTags(input.tags);
  const importance = input.importance ?? 0.5;

  let score = clamp(importance, 0, 1);
  if (summary) score += 0.1;
  if (tags.length > 0) score += Math.min(tags.length * 0.05, 0.15);
  if (tags.includes("decision") || /(?:\bwe decided\b|\bdecided to\b|\bagreed\b|\bpolicy\b|\brule\b)/.test(content)) {
    score += 0.2;
  }
  if (/(?:\buses\b|\bis\b|\bare\b|\bhas\b|\brequires\b|\bsupports\b|\bmust\b)/.test(content)) {
    score += 0.1;
  }

  return Number(clamp(score, 0, 2).toFixed(3));
}

export function inferCandidateKind(input: CandidateKindInput): CanonicalCandidateKind {
  const haystack = `${normalizeWhitespace(input.summary)} ${normalizeWhitespace(input.content)}`.toLowerCase();
  const tags = normalizeTags(input.tags);

  if (
    tags.includes("decision") ||
    tags.includes("rule") ||
    tags.includes("policy") ||
    /(?:\bwe decided\b|\bdecided to\b|\bagreed\b|\bpolicy\b|\brule\b)/.test(haystack)
  ) {
    return "decision";
  }

  if (/(?:\buses\b|\bis\b|\bare\b|\bhas\b|\brequires\b|\bsupports\b|\bmust\b)/.test(haystack)) {
    return "fact";
  }

  return "unknown";
}

export function deriveCandidateTitle(input: CandidateTitleInput): string {
  const summary = normalizeWhitespace(input.summary);
  if (summary) return summary.slice(0, 120);

  const content = normalizeWhitespace(input.content);
  const sentence = content.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? content;
  return sentence.slice(0, 120);
}

export function deriveCandidateContent(input: CandidateContentInput): string {
  return normalizeWhitespace(input.content) || normalizeWhitespace(input.summary);
}

export function shouldRequeueRejectedCandidate(
  existing: RejectedCandidateSnapshot,
  fingerprint: string
): boolean {
  return existing.status === "rejected" && existing.contentFingerprint !== fingerprint;
}

export function enqueueCanonicalCandidate(
  db: Database.Database,
  input: EnqueueCanonicalCandidateInput
): CanonicalCandidateRow {
  const scope = input.scope ?? "global";

  const inProgress = db.prepare(`
    SELECT id, raw_memory_id, scope, status, candidate_kind, candidate_title, candidate_content,
           priority_score, confidence, rationale, matched_canonical_id, content_fingerprint,
           retry_count, last_judged_at, created_at, updated_at
    FROM canonical_candidates
    WHERE raw_memory_id = ?
      AND scope = ?
      AND status IN (?, ?)
    ORDER BY created_at DESC
    LIMIT 1
  `).get(
    input.rawMemoryId,
    scope,
    ...IN_PROGRESS_CANDIDATE_STATUSES
  ) as CanonicalCandidateRow | undefined;

  if (inProgress) return inProgress;

  const historicalMatch = db.prepare(`
    SELECT id, raw_memory_id, scope, status, candidate_kind, candidate_title, candidate_content,
           priority_score, confidence, rationale, matched_canonical_id, content_fingerprint,
           retry_count, last_judged_at, created_at, updated_at
    FROM canonical_candidates
    WHERE raw_memory_id = ?
      AND scope = ?
      AND content_fingerprint = ?
      AND status IN (?, ?)
    ORDER BY created_at DESC
    LIMIT 1
  `).get(
    input.rawMemoryId,
    scope,
    input.contentFingerprint,
    ...HISTORICAL_MATCH_STATUSES
  ) as CanonicalCandidateRow | undefined;

  if (historicalMatch) return historicalMatch;

  const latestRejected = db.prepare(`
    SELECT id, raw_memory_id, scope, status, candidate_kind, candidate_title, candidate_content,
           priority_score, confidence, rationale, matched_canonical_id, content_fingerprint,
           retry_count, last_judged_at, created_at, updated_at
    FROM canonical_candidates
    WHERE raw_memory_id = ?
      AND scope = ?
      AND status = 'rejected'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(input.rawMemoryId, scope) as CanonicalCandidateRow | undefined;

  if (
    latestRejected &&
    !shouldRequeueRejectedCandidate(
      {
        status: latestRejected.status,
        contentFingerprint: latestRejected.content_fingerprint,
      },
      input.contentFingerprint
    )
  ) {
    return latestRejected;
  }

  const id = input.id ?? uuidv7();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const updatedAt = input.updatedAt ?? createdAt;

  db.prepare(`
    INSERT INTO canonical_candidates (
      id, raw_memory_id, scope, status, candidate_kind, candidate_title, candidate_content,
      priority_score, confidence, rationale, matched_canonical_id, content_fingerprint,
      retry_count, last_judged_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, NULL, NULL, NULL, ?, 0, NULL, ?, ?)
  `).run(
    id,
    input.rawMemoryId,
    scope,
    input.candidateKind,
    input.candidateTitle ?? null,
    input.candidateContent,
    input.priorityScore ?? 0,
    input.contentFingerprint,
    createdAt,
    updatedAt
  );

  return getCanonicalCandidateById(db, id);
}

export function listQueuedCanonicalCandidates(
  db: Database.Database,
  limit: number
): CanonicalCandidateRow[] {
  return db.prepare(`
    SELECT canonical_candidates.id, canonical_candidates.raw_memory_id, canonical_candidates.scope,
           canonical_candidates.status, canonical_candidates.candidate_kind,
           canonical_candidates.candidate_title, canonical_candidates.candidate_content,
           canonical_candidates.priority_score, canonical_candidates.confidence,
           canonical_candidates.rationale, canonical_candidates.matched_canonical_id,
           canonical_candidates.content_fingerprint, canonical_candidates.retry_count,
           canonical_candidates.last_judged_at, canonical_candidates.created_at,
           canonical_candidates.updated_at
    FROM canonical_candidates
    JOIN memories ON memories.id = canonical_candidates.raw_memory_id
    WHERE canonical_candidates.status = 'queued'
      AND memories.deleted = 0
    ORDER BY canonical_candidates.priority_score DESC, canonical_candidates.created_at DESC
    LIMIT ?
  `).all(limit) as CanonicalCandidateRow[];
}

export function markCanonicalCandidateProcessing(
  db: Database.Database,
  id: string,
  now: string
): boolean {
  const result = db.prepare(`
    UPDATE canonical_candidates
    SET status = 'processing', updated_at = ?
    WHERE id = ? AND status = 'queued'
  `).run(now, id);

  return result.changes > 0;
}

export function markCanonicalCandidateRejected(
  db: Database.Database,
  input: MarkCanonicalCandidateRejectedInput
): void {
  db.prepare(`
    UPDATE canonical_candidates
    SET status = 'rejected',
        confidence = ?,
        rationale = ?,
        matched_canonical_id = ?,
        retry_count = retry_count + 1,
        last_judged_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    input.confidence,
    input.rationale,
    input.matchedCanonicalId ?? null,
    input.now,
    input.now,
    input.id
  );
}

export function markCanonicalCandidateApproved(
  db: Database.Database,
  input: MarkCanonicalCandidateApprovedInput
): void {
  db.prepare(`
    UPDATE canonical_candidates
    SET status = 'approved',
        candidate_kind = ?,
        candidate_title = ?,
        candidate_content = ?,
        confidence = ?,
        rationale = ?,
        matched_canonical_id = ?,
        last_judged_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    input.candidateKind,
    input.candidateTitle,
    input.candidateContent,
    input.confidence,
    input.rationale,
    input.matchedCanonicalId ?? null,
    input.now,
    input.now,
    input.id
  );
}

export function markCanonicalCandidateMerged(
  db: Database.Database,
  input: MarkCanonicalCandidateMergedInput
): void {
  db.prepare(`
    UPDATE canonical_candidates
    SET status = 'merged',
        candidate_kind = ?,
        candidate_title = ?,
        candidate_content = ?,
        confidence = ?,
        rationale = ?,
        matched_canonical_id = ?,
        last_judged_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    input.candidateKind,
    input.candidateTitle,
    input.candidateContent,
    input.confidence,
    input.rationale,
    input.matchedCanonicalId,
    input.now,
    input.now,
    input.id
  );
}

export function requeueCanonicalCandidateAfterTransientFailure(
  db: Database.Database,
  input: RequeueCanonicalCandidateAfterTransientFailureInput,
  now: string
): void {
  const row = db.prepare(
    "SELECT retry_count FROM canonical_candidates WHERE id = ?"
  ).get(input.id) as { retry_count: number } | undefined;

  const currentRetries = row?.retry_count ?? 0;
  const nextRetries = currentRetries + 1;

  if (nextRetries > MAX_CANONICAL_CANDIDATE_RETRIES) {
    db.prepare(`
      UPDATE canonical_candidates
      SET status = 'rejected',
          retry_count = ?,
          rationale = ?,
          last_judged_at = ?,
          updated_at = ?,
          next_retry_at = NULL
      WHERE id = ?
    `).run(
      nextRetries,
      `Max retries exceeded (${MAX_CANONICAL_CANDIDATE_RETRIES}): ${input.rationale}`,
      now,
      now,
      input.id
    );
    return;
  }

  const backoffMs = computeCanonicalCandidateBackoffMs(nextRetries);
  const nextRetryAt = new Date(Date.parse(now) + backoffMs).toISOString();

  db.prepare(`
    UPDATE canonical_candidates
    SET status = 'queued',
        retry_count = ?,
        rationale = ?,
        last_judged_at = ?,
        updated_at = ?,
        next_retry_at = ?
    WHERE id = ?
  `).run(
    nextRetries,
    input.rationale,
    now,
    now,
    nextRetryAt,
    input.id
  );
}

export function reclaimStaleProcessingCandidates(
  db: Database.Database,
  input: ReclaimStaleProcessingCandidatesInput,
  now: string
): string[] {
  const threshold = new Date(Date.parse(now) - CANONICAL_CANDIDATE_LEASE_MS).toISOString();
  const staleRows = db.prepare(`
    SELECT id
    FROM canonical_candidates
    WHERE status = 'processing'
      AND updated_at < ?
    ORDER BY updated_at ASC
    LIMIT ?
  `).all(threshold, input.limit) as Array<{ id: string }>;

  if (staleRows.length === 0) return [];

  const ids = staleRows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`
    UPDATE canonical_candidates
    SET status = 'queued',
        updated_at = ?
    WHERE id IN (${placeholders})
  `).run(now, ...ids);

  return ids;
}
