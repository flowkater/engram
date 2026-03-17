# Auto Canonical Candidate Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `memory.add` aggressively create canonical candidates without slowing the request path, process those candidates asynchronously with local Ollama, and upgrade `search_graph` to return `confirmed` canonicals separately from lower-confidence `candidates`.

**Architecture:** `memory.add` remains the synchronous raw-memory ingestion path and always returns fast after embedding plus DB insert. A new candidate table stores aggressive canonical hypotheses, a background worker judges and merges them into canonical memories using Ollama-only logic, and `search_graph` reads both confirmed canonical truth and pending/recent candidate hypotheses as separate result sets.

**Tech Stack:** TypeScript, Node.js ESM, better-sqlite3, sqlite-vec, Vitest, local Ollama embeddings/judging, MCP stdio server.

---

Requirements source: conversational design agreed on 2026-03-15. There is no standalone spec file for this feature; use this plan header and task details as the authoritative scope.

## File Structure

- Modify: `src/core/database.ts`
  Add the `canonical_candidates` schema and indexes in the single migration point.
- Modify: `src/core/database.test.ts`
  Lock the new schema/index behavior with migration tests.
- Create: `src/core/canonical-candidates.ts`
  Own candidate creation, status transitions, retry gating, merge metadata, and queue selection helpers.
- Create: `src/core/canonical-candidates.test.ts`
  Unit coverage for candidate scoring, fingerprint change detection, retry eligibility, and merge/update persistence.
- Create: `src/core/canonical-judge.ts`
  Own the Ollama-only classification prompt/response layer for `fact | decision | reject` plus merge metadata.
- Create: `src/core/canonical-judge.test.ts`
  Unit coverage for parsing, fallback behavior, and strict local-only failures.
- Create: `src/core/ollama-client.ts`
  Centralize shared Ollama host/local-only transport policy used by both embedder and judge.
- Create: `src/core/ollama-client.test.ts`
  Lock shared Ollama env parsing and local-only policy behavior.
- Modify: `src/core/embedder.ts`
  Reuse the shared Ollama transport/config helper so embedding and judging stay aligned.
- Modify: `src/core/embedder.test.ts`
  Guard existing embedder behavior after centralizing the shared Ollama client.
- Modify: `src/tools/add.ts`
  Enqueue one aggressive candidate per raw memory inside the existing transaction without adding LLM latency.
- Create: `src/tools/add.test.ts`
  Cover candidate enqueue behavior and ensure `memory.add` never performs synchronous judging.
- Modify: `src/tools/add-search.test.ts`
  Protect existing add/search behavior while candidate enqueue is added to the hot path.
- Modify: `src/core/background-jobs.ts`
  Start the candidate judge loop as part of background jobs when enabled.
- Modify: `src/core/background-jobs.test.ts`
  Cover candidate worker start/skip/stop behavior under the background job harness.
- Create: `src/core/background-runtime.ts`
  Own the testable decision of when background jobs should start under server/runtime flags.
- Create: `src/core/background-runtime.test.ts`
  Cover candidate-worker enablement without relying on the side-effectful CLI entrypoint.
- Create: `src/core/server-app.ts`
  Own server construction and tool registration without startup side effects.
- Create: `src/core/server-app.test.ts`
  Verify server construction/tool registration separately from bootstrap orchestration.
- Create: `src/core/server-bootstrap.ts`
  Move `src/server.ts` top-level startup side effects behind a testable bootstrap seam.
- Create: `src/core/server-bootstrap.test.ts`
  Verify bootstrap orchestration without importing the CLI entrypoint for side effects.
- Create: `src/core/canonical-candidate-worker.ts`
  Own queue polling, Ollama judge invocation, merge/update/create decisions, and reject/update bookkeeping.
- Create: `src/core/canonical-candidate-worker.test.ts`
  Cover queue consumption, approve/merge/reject paths, and restart-safe processing.
- Modify: `src/core/background-worker.ts`
  Only if needed to support candidate worker lifecycle hooks cleanly; avoid unrelated refactors.
- Modify: `src/core/background-worker.test.ts`
  Guard optional lifecycle glue changes in the existing background worker harness.
- Modify: `src/core/canonical-memory.ts`
  Add helpers to update existing canonical rows, append evidence, and record merge metadata without duplicating write logic.
- Modify: `src/core/canonical-memory.test.ts`
  Cover canonical helper updates, artifact replacement, and transactional rollback behavior.
- Modify: `src/core/search-graph.ts`
  Return `confirmed` and `candidates` separately, rank confirmed first, and expose candidate status/confidence/matched canonical metadata.
- Modify: `src/core/search-graph.test.ts`
  Cover mixed confirmed/candidate graph output and ranking semantics.
- Modify: `src/tools/search-graph.ts`
  Thin wrapper stays thin, but response typing must match the new core shape.
- Modify: `src/tools/search-graph.test.ts`
  Tool-level regression for separated result sections.
- Modify: `src/server.ts`
  Update tool descriptions if needed and wire any new background-job flags only if required by the implementation.
- Modify: `src/server.test.ts`
  Keep the CLI wrapper thin and verify delegation to runtime bootstrap helpers.
- Modify: `README.md`
  Document the new async canonical candidate pipeline and any new env flags.

## Chunk 1: Candidate Storage and Fast `memory.add`

### Task 1: Add canonical candidate schema and helper boundaries

**Files:**
- Modify: `src/core/database.ts`
- Modify: `src/core/database.test.ts`
- Create: `src/core/canonical-candidates.ts`
- Create: `src/core/canonical-candidates.test.ts`

- [ ] **Step 1: Write the failing schema tests**

Add tests that expect:
- `canonical_candidates` table to exist after `openDatabase()`
- exact indexes:
  - `idx_canonical_candidates_queue` on `(status, priority_score DESC, created_at DESC)`
  - `idx_canonical_candidates_raw_scope_status` on `(raw_memory_id, scope, status)`
  - `idx_canonical_candidates_raw_scope_fingerprint` on `(raw_memory_id, scope, content_fingerprint)`
- deleting a referenced canonical memory sets `matched_canonical_id` back to `NULL`

- [ ] **Step 2: Write the failing candidate helper tests**

In `src/core/canonical-candidates.test.ts`, add tests that expect:
- retry gating semantics for:
  - same `raw_memory_id` + `scope` + same fingerprint over existing `rejected` candidate => no requeue
  - same `raw_memory_id` + `scope` + changed fingerprint over existing `rejected` candidate => new queued candidate allowed
  - existing `queued` or `processing` candidate for the same `raw_memory_id` and `scope` => do not duplicate active work
  - existing `approved` or `merged` candidate for the same `raw_memory_id`, `scope`, and fingerprint => do not insert a duplicate historical row
  - different `raw_memory_id` values remain independent even if `scope` and fingerprint match, so new evidence can still be queued
- queue selection semantics:
  - `listQueuedCanonicalCandidates(db, limit)` returns only `queued` rows
  - rows are ordered by `priority_score DESC, created_at DESC`
  - `limit` is enforced exactly
- state-transition semantics for `processing`, `rejected`, `approved`, and `merged`

- [ ] **Step 3: Run the schema/helper tests to verify they fail**

Run: `npm test -- src/core/database.test.ts src/core/canonical-candidates.test.ts`
Expected: FAIL because the new table/helpers do not exist yet.

- [ ] **Step 4: Add the minimal schema in the migration point**

Implement in `src/core/database.ts` only:

```sql
CREATE TABLE IF NOT EXISTS canonical_candidates (
  id TEXT PRIMARY KEY,
  raw_memory_id TEXT NOT NULL REFERENCES memories(id),
  scope TEXT NOT NULL DEFAULT 'global',
  status TEXT NOT NULL CHECK (status IN ('queued','processing','approved','merged','rejected')),
  candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('fact','decision','unknown')),
  candidate_title TEXT,
  candidate_content TEXT NOT NULL,
  priority_score REAL NOT NULL DEFAULT 0,
  confidence REAL,
  rationale TEXT,
  matched_canonical_id TEXT REFERENCES canonical_memories(id) ON DELETE SET NULL,
  content_fingerprint TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_judged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Add these exact `CREATE INDEX IF NOT EXISTS` statements in `src/core/database.ts`:
- `idx_canonical_candidates_queue` on `(status, priority_score DESC, created_at DESC)`
- `idx_canonical_candidates_raw_scope_status` on `(raw_memory_id, scope, status)`
- `idx_canonical_candidates_raw_scope_fingerprint` on `(raw_memory_id, scope, content_fingerprint)`

Keep `src/core/database.ts` limited to schema/index migration work only. Implement transactional existence queries for dedupe/retry in `src/core/canonical-candidates.ts`, using these indexes for lookups. Do not rely on partial unique indexes in v1.
Treat `matched_canonical_id` as a nullable foreign key to `canonical_memories(id)` with `ON DELETE SET NULL`, so candidate history survives canonical cleanup without dangling references.

- [ ] **Step 5: Implement derivation and enqueue/dedupe helpers**

In `src/core/canonical-candidates.ts`, add small helpers such as:
- `buildCandidateFingerprint(input)`
- `scoreCandidatePriority(input)`
- `inferCandidateKind(input)`
- `deriveCandidateTitle(input)`
- `deriveCandidateContent(input)`
- `enqueueCanonicalCandidate(db, input)`
- `shouldRequeueRejectedCandidate(existing, fingerprint)`

Do not add Ollama calls here. Keep this file purely about storage/state transitions.

- [ ] **Step 6: Implement queue listing helpers**

In `src/core/canonical-candidates.ts`, add:
- `listQueuedCanonicalCandidates(db, limit)`

Queue-selection contract for tests and implementation:
- `listQueuedCanonicalCandidates(db, limit)` filters strictly to `status='queued'`
- it orders by `priority_score DESC, created_at DESC`
- it returns at most `limit` rows

Do not add Ollama calls here. Keep this file purely about storage/state transitions.

- [ ] **Step 7: Implement state-transition helpers**

In `src/core/canonical-candidates.ts`, add:
- `markCanonicalCandidateProcessing(db, id, now)`
- `markCanonicalCandidateRejected(db, input)`
- `markCanonicalCandidateApproved(db, input)`
- `markCanonicalCandidateMerged(db, input)`

Do not add Ollama calls here. Keep this file purely about storage/state transitions.
State-transition contract for tests and implementation:
- `markCanonicalCandidateProcessing` is an atomic claim helper: it updates only rows currently in `status='queued'`, sets `status='processing'`, updates only `updated_at`, and returns whether the claim succeeded
- `markCanonicalCandidateRejected` sets `status='rejected'`, writes `confidence`, `rationale`, nullable `matched_canonical_id`, increments `retry_count`, and sets both `last_judged_at` and `updated_at`
- `markCanonicalCandidateApproved` sets `status='approved'`, writes judged `candidate_kind`, `candidate_title`, `candidate_content`, `confidence`, `rationale`, nullable `matched_canonical_id`, and sets both `last_judged_at` and `updated_at`
- `markCanonicalCandidateMerged` sets `status='merged'`, writes judged `candidate_kind`, `candidate_title`, `candidate_content`, `confidence`, `rationale`, required `matched_canonical_id`, and sets both `last_judged_at` and `updated_at`
- none of the transition helpers rewrite `created_at`; only explicit requeue insertion creates a new row
- new ESM imports introduced in this file and its tests must use `.js` extensions
Test split:
- `src/core/database.test.ts` owns schema/index/FK assertions
- `src/core/canonical-candidates.test.ts` owns retry, queue selection, and state-transition helper behavior

- [ ] **Step 8: Run the schema/helper tests to verify they pass**

Run: `npm test -- src/core/database.test.ts src/core/canonical-candidates.test.ts`
Expected: PASS

- [ ] **Step 9: Run the full test suite before commit**

Run: `npm test`
Expected: PASS across the full suite, satisfying the repo commit gate for `src/**` and `test/**` changes.

- [ ] **Step 10: Commit**

```bash
git add src/core/database.ts src/core/database.test.ts src/core/canonical-candidates.ts src/core/canonical-candidates.test.ts
git commit -m "feat: add canonical candidate storage"
```

### Task 2: Make `memory.add` enqueue one aggressive candidate without synchronous judging

**Files:**
- Modify: `src/tools/add.ts`
- Create: `src/tools/add.test.ts`
- Modify: `src/tools/add-search.test.ts`
- Modify: `src/core/canonical-candidates.ts`
- Modify: `src/core/canonical-candidates.test.ts`
- Test: `src/core/canonical-candidates.test.ts`

- [ ] **Step 1: Write the failing `memory.add` candidate enqueue tests**

Add tests that expect:
- `memory.add` creates exactly one candidate row tied to the new raw memory
- candidate fields derive from `content`, `summary`, `scope`, `tags`, and `importance` through helper functions in `src/core/canonical-candidates.ts`
- repeated `memory.add` calls with changed content create distinct candidate fingerprints
- `memory.add` performs exactly one embedding/model call for the raw memory and does not perform a second model/network round-trip for candidate classification
- the inserted candidate remains in `queued` status with `confidence`, `rationale`, `matched_canonical_id`, and `last_judged_at` still unset after `memory.add`
- if candidate enqueue fails inside the transaction, the raw memory, vec row, FTS row, and normalized tags all roll back together
- `src/tools/add-search.test.ts` still proves the new raw memory is searchable immediately after candidate enqueue succeeds

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npm test -- src/tools/add.test.ts src/tools/add-search.test.ts src/core/canonical-candidates.test.ts`
Expected: FAIL because `memory.add` does not yet enqueue candidates.

- [ ] **Step 3: Extend `memory.add` with transactional candidate enqueue**

Inside the existing transaction in `src/tools/add.ts`:
- keep embed outside the transaction exactly as today
- keep raw-memory writes unchanged
- compute an aggressive candidate draft synchronously
- reuse `inferCandidateKind`, `deriveCandidateTitle`, `deriveCandidateContent`, `scoreCandidatePriority`, and `buildCandidateFingerprint` from `src/core/canonical-candidates.ts`
- call `enqueueCanonicalCandidate(...)` before the transaction closes

Use a deterministic draft shape similar to:

```ts
const candidate = {
  rawMemoryId: id,
  scope,
  candidateKind: inferCandidateKind({ content: params.content, summary: params.summary, tags: params.tags }),
  candidateTitle: deriveCandidateTitle(...),
  candidateContent: deriveCandidateContent(...),
  priorityScore: scoreCandidatePriority(...),
  contentFingerprint: buildCandidateFingerprint(...),
};
```

Do not call Ollama classification here.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npm test -- src/tools/add.test.ts src/tools/add-search.test.ts src/core/canonical-candidates.test.ts`
Expected: PASS

- [ ] **Step 5: Run adjacent promotion/search tests for regression safety**

Run: `npm test -- src/tools/promote.test.ts src/core/canonical-memory.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full test suite before commit**

Run: `npm test`
Expected: PASS across the full suite, satisfying the repo commit gate for `src/**` and `test/**` changes.

- [ ] **Step 7: Commit**

```bash
git add src/tools/add.ts src/tools/add.test.ts src/tools/add-search.test.ts src/core/canonical-candidates.ts src/core/canonical-candidates.test.ts
git commit -m "feat: enqueue canonical candidates from memory add"
```

## Chunk 2: Async Ollama Judge and Canonical Merge Pipeline

### Task 3: Add the Ollama-only candidate judge

**Files:**
- Create: `src/core/canonical-judge.ts`
- Create: `src/core/canonical-judge.test.ts`
- Create: `src/core/ollama-client.ts`
- Create: `src/core/ollama-client.test.ts`
- Modify: `src/core/embedder.ts`
- Modify: `src/core/embedder.test.ts`

- [ ] **Step 1: Write the failing judge tests**

Cover:
- valid parsed output for `approved fact`
- valid parsed output for `approved decision`
- valid parsed output for `rejected`
- malformed LLM output maps deterministically:
  - invalid JSON / schema mismatch / truncated output => `retry` with `reason='invalid_response'`
  - parseable but low-evidence or explicit refusal output => `reject`
- schema-valid but unusable `approve` payloads such as blank `title`/`content` or invalid `confidence` also become `retry` with `reason='invalid_response'`
- remote-model fallback is not allowed
- dedicated judge-model config such as `ENGRAM_CANONICAL_JUDGE_MODEL` is honored when set
- local Ollama timeout/connection failures become explicit `retry` results
- unknown `matchedCanonicalId` values that are not present in the supplied nearby canonical context are downgraded to `approve` without a match
- known `matchedCanonicalId` values whose existing canonical `kind` conflicts with the proposed `canonicalKind` are downgraded to `approve` without a match

- [ ] **Step 2: Run the judge tests to verify they fail**

Run: `npm test -- src/core/canonical-judge.test.ts src/core/ollama-client.test.ts src/core/embedder.test.ts`
Expected: FAIL because the judge module does not exist.

- [ ] **Step 3: Implement the minimal Ollama judge contract**

Implement a small module that:
- accepts one candidate plus nearby canonical context
- calls local Ollama only
- accepts an injected request/client seam for tests so timeout, connection failure, invalid response, and local-only behavior are unit-testable without live network calls
- returns structured output:

```ts
type JudgeResult =
  | { action: "approve"; canonicalKind: "fact" | "decision"; title: string; content: string; confidence: number; rationale: string; matchedCanonicalId?: string }
  | { action: "reject"; confidence: number; rationale: string; matchedCanonicalId?: string }
  | { action: "retry"; reason: "timeout" | "connection" | "invalid_response"; rationale: string };
```

Keep the prompt parser strict. If the model returns unusable text, convert it to a safe `retry` or `reject` result rather than guessing.
If the model returns a `matchedCanonicalId`, validate that it belongs to the supplied nearby canonical context. Unknown IDs must be downgraded to `approve` without `matchedCanonicalId`.
If the model proposes a `matchedCanonicalId` whose existing canonical `kind` disagrees with the proposed `canonicalKind`, downgrade it to `approve` without `matchedCanonicalId` rather than coercing kinds across an existing canonical.
For `approve`, `title`, `content`, and `confidence` must represent the full canonical artifact the caller should persist:
- without `matchedCanonicalId`: the full new canonical to create
- with `matchedCanonicalId`: the fully merged canonical payload to write back onto the matched canonical
Reuse the existing Ollama host/local-only policy (`OLLAMA_BASE_URL`) and keep the judge on the same local transport surface, but allow a dedicated judge-model setting in that same config surface such as `ENGRAM_CANONICAL_JUDGE_MODEL`.
Update `src/core/embedder.ts` to consume the same `src/core/ollama-client.ts` helper rather than keeping a second copy of host/local-only policy logic.
New ESM imports introduced in this file and its tests must use `.js` extensions.

- [ ] **Step 4: Run the judge tests to verify they pass**

Run: `npm test -- src/core/canonical-judge.test.ts src/core/ollama-client.test.ts src/core/embedder.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite before commit**

Run: `npm test`
Expected: PASS across the full suite, satisfying the repo commit gate for `src/**` and `test/**` changes.

- [ ] **Step 6: Commit**

```bash
git add src/core/canonical-judge.ts src/core/canonical-judge.test.ts src/core/ollama-client.ts src/core/ollama-client.test.ts src/core/embedder.ts src/core/embedder.test.ts
git commit -m "feat: add ollama canonical candidate judge"
```

### Task 4: Refactor canonical helpers for async candidate processing

**Files:**
- Modify: `src/core/canonical-candidates.ts`
- Modify: `src/core/canonical-candidates.test.ts`
- Modify: `src/core/canonical-memory.ts`
- Modify: `src/core/canonical-memory.test.ts`

- [ ] **Step 1: Write the failing helper/refactor tests**

Cover:
- transient retry bookkeeping returns the candidate to `queued`, increments `retry_count`, persists retry rationale, updates `last_judged_at` and `updated_at`, and preserves candidate title/content/kind
- stale reclaim uses `updated_at` plus `CANONICAL_CANDIDATE_LEASE_MS`
- nearby canonical context loading filters by `scope`, excludes future-dated canonicals where `valid_from > now`, excludes inactive/superseded canonicals where `valid_to < now`, orders by `confidence DESC, updated_at DESC, created_at DESC`, and respects `limit`
- `updateCanonicalMemory(...)` updates the matched canonical row deterministically while preserving `importance`, `valid_from`, `valid_to`, and `decided_at`
- `appendCanonicalEvidence(...)` is idempotent and does not duplicate existing evidence rows
- `mergeCandidateIntoCanonical(...)` applies the merged canonical update/evidence contract correctly
- canonical search artifact replacement replaces, rather than appends to, `canonical_memory_vec` and `canonical_memory_fts`
- failures during canonical artifact replacement roll back `canonical_memories`, `canonical_evidence`, `canonical_memory_vec`, and `canonical_memory_fts` together

- [ ] **Step 2: Run the helper/refactor tests to verify they fail**

Run: `npm test -- src/core/canonical-candidates.test.ts src/core/canonical-memory.test.ts`
Expected: FAIL because the helper layer does not exist yet.

- [ ] **Step 3: Add canonical update helper**

Extend `src/core/canonical-memory.ts` with:
- `updateCanonicalMemory(db, input)`

Contract:
- updates `title`, `content`, `confidence`, and `updated_at`, preserving `created_at`, `kind`, `scope`, `importance`, `valid_from`, `valid_to`, and `decided_at`

- [ ] **Step 4: Add canonical evidence helper**

Extend `src/core/canonical-memory.ts` with:
- `appendCanonicalEvidence(db, canonicalId, canonicalKind, memoryIds, createdAt)`

Contract:
- derives `evidence_role` from the canonical kind: `fact -> source`, `decision -> decision-context`
- uses idempotent insert semantics so the same `(canonical_id, memory_id, evidence_role)` is not duplicated

- [ ] **Step 5: Add canonical search-artifact replacement helper**

Extend `src/core/canonical-memory.ts` with:
- `replaceCanonicalSearchArtifacts(db, input)`

Contract:
- performs deterministic replacement of `canonical_memory_vec` and `canonical_memory_fts` for the canonical id
- uses atomic `DELETE + INSERT` semantics and assumes the caller already opened the surrounding transaction

- [ ] **Step 6: Add canonical merge helper**

Extend `src/core/canonical-memory.ts` with focused helpers such as:
- `mergeCandidateIntoCanonical(db, input)`

Do not duplicate raw SQL in multiple files. Helper contract:
- `mergeCandidateIntoCanonical(...)` composes canonical row update plus evidence append in one transaction-ready helper, preserving the matched canonical kind and therefore its derived evidence role
- `mergeCandidateIntoCanonical(...)` is transaction-ready and assumes the caller already opened the top-level `db.transaction(() => { ... })()` that also updates candidate status
- inside that caller-owned transaction it calls `updateCanonicalMemory(...)`, `appendCanonicalEvidence(...)`, and `replaceCanonicalSearchArtifacts(...)`

Shared create path:
- keep the existing `createCanonicalMemory(...)` + `insertCanonicalSearchArtifacts(...)` helpers as the sanctioned create abstraction for both manual promote and future worker approve-create flows

When canonical text changes, the caller computes embeddings outside the transaction and passes the precomputed vector into `mergeCandidateIntoCanonical(...)`, which runs inside that caller-owned transaction and delegates vec/FTS replacement to `replaceCanonicalSearchArtifacts(...)`.

- [ ] **Step 7: Add candidate retry and stale-reclaim helpers**

Extend `src/core/canonical-candidates.ts` with focused helpers such as:
- `requeueCanonicalCandidateAfterTransientFailure(db, input, now)`
- `reclaimStaleProcessingCandidates(db, input, now)`

Contract:
- set status back to `queued`
- increment `retry_count`
- write retry rationale
- set `last_judged_at` and `updated_at`
- preserve candidate title/content/kind unless a later successful judge updates them
- define a dedicated worker lease constant such as `CANONICAL_CANDIDATE_LEASE_MS = 30000`
- accept explicit `now` input (or equivalent injected clock value) so tests stay deterministic
- use `updated_at` as the lease source of truth for reclaim decisions
- reclaim only `processing` rows whose `updated_at` is older than `now - CANONICAL_CANDIDATE_LEASE_MS`, returning them to `queued` without duplicating fresh in-flight work

- [ ] **Step 8: Add nearby canonical context loading helpers**

Own “nearby canonical context” lookup in `src/core/canonical-memory.ts` via a focused helper such as `listNearbyCanonicalMemories(db, scope, limit, now)`. Keep query logic out of `src/core/canonical-candidate-worker.ts`.
Contract:
- filter to the same `scope`
- use `now` as the time basis and exclude canonicals that are not currently active:
  - exclude superseded/inactive canonicals where `valid_to IS NOT NULL` and `valid_to < now`
  - exclude future-dated canonicals where `valid_from IS NOT NULL` and `valid_from > now`
- order deterministically by `confidence DESC, updated_at DESC, created_at DESC`
- enforce `limit`
- return only the fields the judge/worker need: `id`, `kind`, `title`, `content`, `confidence`, `created_at`, `updated_at`, `valid_from`, `valid_to`, `decided_at`

- [ ] **Step 9: Run the helper/refactor tests to verify they pass**

Run: `npm test -- src/core/canonical-candidates.test.ts src/core/canonical-memory.test.ts`
Expected: PASS

- [ ] **Step 10: Run the full test suite before commit**

Run: `npm test`
Expected: PASS across the full suite, satisfying the repo commit gate for `src/**` and `test/**` changes.

- [ ] **Step 11: Commit**

```bash
git add src/core/canonical-candidates.ts src/core/canonical-candidates.test.ts src/core/canonical-memory.ts src/core/canonical-memory.test.ts
git commit -m "refactor: share canonical helper workflows"
```

## Chunk 3: Candidate Worker Runtime and Lifecycle

### Task 5: Build the async candidate worker core and lifecycle

**Files:**
- Create: `src/core/canonical-candidate-worker.ts`
- Create: `src/core/canonical-candidate-worker.test.ts`
- Modify: `src/core/background-jobs.ts`
- Modify: `src/core/background-jobs.test.ts`
- Modify only if minimal lifecycle glue is required: `src/core/background-worker.ts`
- Modify only if minimal lifecycle glue is required: `src/core/background-worker.test.ts`

- [ ] **Step 1: Write the failing worker/lifecycle tests**

Cover:
- queued candidate moves to `processing` then `approved` with a new canonical
- matched canonical path updates existing canonical content/title/confidence and adds new evidence
- reject path stores rationale/confidence and leaves canonical tables untouched
- transient Ollama failure returns the candidate to `queued`, increments retry bookkeeping, and does not create or mutate canonical rows
- embedding failure after judge approval also returns the candidate to `queued` via transient retry handling
- approved create/update paths refresh canonical search artifacts so later search sees the new truth
- approve-create path records the originating `raw_memory_id` in `canonical_evidence`
- stale `processing` rows older than `CANONICAL_CANDIDATE_LEASE_MS` according to `updated_at` are reclaimed on restart and processed exactly once
- fresh `processing` rows inside the lease are not stolen by a second worker
- candidate-worker startup is not blocked by missing vault-path/watcher prerequisites
- worker teardown cancels future poll/backoff timers and prevents any further claim attempts after shutdown
- partial canonical-write failures roll back candidate status plus `canonical_memories`, `canonical_evidence`, `canonical_memory_vec`, and `canonical_memory_fts` together

- [ ] **Step 2: Run the worker/lifecycle tests to verify they fail**

Run: `npm test -- src/core/canonical-candidate-worker.test.ts src/core/background-jobs.test.ts src/core/background-worker.test.ts`
Expected: FAIL because the worker and lifecycle wiring do not exist.

- [ ] **Step 3: Implement the worker poll/claim loop**

In `src/core/canonical-candidate-worker.ts`:
- reclaim stale `processing` rows before polling new `queued` work
- fetch queued items ordered by `priority_score DESC, created_at DESC`
- mark one row `processing`
- refresh the processing lease (`updated_at`) during long-running judge/embed work so active rows are not reclaimed prematurely
- gather nearby canonical context from the same scope
- if claim fails because another worker already moved the row, continue without error

Lifecycle contract:
- expose a start/stop boundary such as `startCanonicalCandidateWorker(...) => () => Promise<void> | void`
- inject judge, embedder, clock, and sleep/poll hooks for tests
- use a fixed poll interval/backoff owned by the worker module, not by `background-jobs.ts`
- teardown must cancel outstanding poll/backoff timers or sleeps and prevent any further claim attempts after shutdown
- add a helper such as `touchCanonicalCandidateProcessingLease(...)` or equivalent heartbeat behavior, and test long-running approve/retry paths against lease expiry

- [ ] **Step 4: Implement retry and reject branches**

In `src/core/canonical-candidate-worker.ts`:
- call `canonical-judge`
- if the judge returns an unknown `matchedCanonicalId`, downgrade it to `approve` without a match before branching
- on `retry`, call `requeueCanonicalCandidateAfterTransientFailure(...)`
- on `reject`, mark the candidate rejected with stored rationale/confidence and leave canonical tables untouched
- if later embedding work fails after approval, route that failure through `requeueCanonicalCandidateAfterTransientFailure(...)` as well

- [ ] **Step 5: Implement approve-create branch**

In `src/core/canonical-candidate-worker.ts`:
- on `approve` with no `matchedCanonicalId`, embed approved content outside the transaction
- create the canonical row via the existing `createCanonicalMemory(...)` helper inside the transaction
- insert canonical search artifacts via the shared create path inside the same transaction
- record the originating `raw_memory_id` in `canonical_evidence`
- mark the candidate `approved` via `markCanonicalCandidateApproved(...)`, persisting `candidate_kind`, `candidate_title`, `candidate_content`, `confidence`, `rationale`, and `matchedCanonicalId` set to the newly created canonical id

- [ ] **Step 6: Implement approve-merge branch**

In `src/core/canonical-candidate-worker.ts`:
- on `approve` with `matchedCanonicalId`, embed the updated canonical content outside the transaction
- update the canonical row, append evidence, replace canonical search artifacts, and mark the candidate `merged` inside one transaction
- persist the full judged payload on the candidate row via `markCanonicalCandidateMerged(...)`, including `candidate_kind`, `candidate_title`, `candidate_content`, `confidence`, `rationale`, and `matchedCanonicalId`

Status semantics:
- `approved` means the candidate created a brand-new canonical and remains queryable as a recently approved candidate linked to that new canonical id
- `merged` means the candidate was absorbed into an existing canonical

Keep all multi-table writes in a transaction, with Ollama and embedding calls outside the transaction.

- [ ] **Step 7: Wire the worker into background jobs**

In `src/core/background-jobs.ts`, compose and stop the candidate worker once background execution has already been enabled upstream.
Add an injectable candidate-worker factory/teardown boundary so `src/core/background-jobs.test.ts` can verify start and stop behavior without real polling or Ollama calls.
In v1, `startBackgroundJobs(...)` always starts the candidate worker when invoked; there is no candidate-specific skip branch inside this layer.
Touch `src/core/background-worker.ts` only if the existing lifecycle harness needs a minimal stop/teardown hook for the new worker; otherwise leave it unchanged.

- [ ] **Step 8: Run the worker/lifecycle tests to verify they pass**

Run: `npm test -- src/core/canonical-candidate-worker.test.ts src/core/background-jobs.test.ts src/core/background-worker.test.ts`
Expected: PASS

- [ ] **Step 9: Run the full test suite before commit**

Run: `npm test`
Expected: PASS across the full suite, satisfying the repo commit gate for `src/**` and `test/**` changes.

- [ ] **Step 10: Commit**

```bash
git add src/core/canonical-candidate-worker.ts src/core/canonical-candidate-worker.test.ts src/core/background-jobs.ts src/core/background-jobs.test.ts src/core/background-worker.ts src/core/background-worker.test.ts
git commit -m "feat: run canonical candidate worker core"
```

### Task 6: Refactor runtime/bootstrap for candidate-only background mode

**Files:**
- Create: `src/core/background-runtime.ts`
- Create: `src/core/background-runtime.test.ts`
- Create: `src/core/server-app.ts`
- Create: `src/core/server-app.test.ts`
- Create: `src/core/server-bootstrap.ts`
- Create: `src/core/server-bootstrap.test.ts`
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [ ] **Step 1: Write the failing runtime/bootstrap tests**

Cover:
- background jobs disabled means the worker does not start
- `ENGRAM_ENABLE_BACKGROUND_JOBS=true` starts the candidate worker even when diff scan, watcher, and scheduler are otherwise off
- candidate-only background mode still runs through the existing lease-based `startBackgroundWorker(...)` + `resolveBackgroundTiming(...)` single-leader path
- `background-runtime.ts` consumes existing background-job config parsing rather than duplicating env-flag logic
- `background-runtime.ts` decides only whether background work is enabled
- `server-bootstrap.ts` performs startup/shutdown orchestration and hands off to `startBackgroundWorker(...)`
- `server-app.ts` owns server construction and tool registration so `src/server.ts` can become a thin CLI wrapper
- `src/core/server-app.test.ts` asserts the extracted server builder still registers the real MCP tool surface expected by the current server contract
- `server-bootstrap.ts` owns startup/shutdown orchestration only and does not absorb tool registration
- the exported bootstrap seam is testable without importing the CLI entrypoint for side effects
- `src/server.ts` stays a thin CLI wrapper with minimal import-time side effects and delegates to the bootstrap seam

- [ ] **Step 2: Run the runtime/bootstrap tests to verify they fail**

Run: `npm test -- src/core/background-runtime.test.ts src/core/server-app.test.ts src/core/server-bootstrap.test.ts src/server.test.ts`
Expected: FAIL because the runtime/bootstrap seam does not exist yet.

- [ ] **Step 3: Add background runtime gating helper**

Create `src/core/background-runtime.ts` and `src/core/background-runtime.test.ts` to own only the decision of whether background work should run.
Govern the candidate worker with the existing `ENGRAM_ENABLE_BACKGROUND_JOBS` path in v1; do not add a new env flag.
Make `background-runtime.ts` consume existing background-job config parsing rather than duplicating env-flag logic already owned elsewhere.

- [ ] **Step 4: Add server bootstrap seam**

Create `src/core/server-bootstrap.ts` and `src/core/server-bootstrap.test.ts` to move the current `src/server.ts` top-level startup side effects behind a testable seam.
Keep `server-bootstrap.ts` limited to startup/shutdown orchestration; do not move tool registration into it.
Bootstrap ownership:
- `server-bootstrap.ts` owns env/path resolution, log directory setup, DB open/close, model-mismatch logging, startup `runDatabaseMaintenance(...)`, background worker startup, and `SessionTracker` lifecycle
- `server-app.ts` owns server construction and tool registration only
- `src/server.ts` becomes a thin CLI wrapper that calls the bootstrap seam only
Preserve the current startup contract: `runDatabaseMaintenance(...)` still executes before background jobs are started, matching the existing `src/server.ts` ordering/behavior.

- [ ] **Step 5: Extract server construction**

Create `src/core/server-app.ts` and `src/core/server-app.test.ts` to own server construction and tool registration without boot side effects.

- [ ] **Step 6: Thin the CLI entrypoint**

Update `src/server.ts` with a single call-site change that invokes the bootstrap seam, and expand `src/server.test.ts` to verify delegation and minimal import-time side effects.

- [ ] **Step 7: Run the runtime/bootstrap tests to verify they pass**

Run: `npm test -- src/core/background-runtime.test.ts src/core/server-app.test.ts src/core/server-bootstrap.test.ts src/server.test.ts`
Expected: PASS

- [ ] **Step 8: Run the full test suite before commit**

Run: `npm test`
Expected: PASS across the full suite, satisfying the repo commit gate for `src/**` and `test/**` changes.

- [ ] **Step 9: Commit**

```bash
git add src/core/background-runtime.ts src/core/background-runtime.test.ts src/core/server-app.ts src/core/server-app.test.ts src/core/server-bootstrap.ts src/core/server-bootstrap.test.ts src/server.ts src/server.test.ts
git commit -m "refactor: isolate server bootstrap runtime"
```

## Chunk 4: `search_graph` Confirmed/Candidate Split and User-Facing Shape

### Task 7: Split `search_graph` into confirmed and candidate result sections

**Files:**
- Modify: `src/core/search-graph.ts`
- Modify: `src/core/search-graph.test.ts`
- Modify: `src/tools/search-graph.ts`
- Modify: `src/tools/search-graph.test.ts`

- [ ] **Step 1: Write the failing graph tests**

Add tests that expect:
- `confirmed` only contains canonical facts/decisions
- `candidates` contains queued/processing/recently judged candidates with lower-confidence metadata
- confirmed ranking is unaffected by candidate presence
- matched canonical id and rationale are exposed for candidate rows
- graph payload still includes canonical/raw nodes without breaking existing edge semantics

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npm test -- src/core/search-graph.test.ts src/tools/search-graph.test.ts`
Expected: FAIL because the response shape is still `results`.

- [ ] **Step 3: Implement the minimal response reshape**

Refactor `SearchGraphResponse` to something like:

```ts
interface SearchGraphResponse {
  confirmed: SearchGraphResultItem[];
  candidates: CandidateGraphResultItem[];
  graph: { nodes: GraphNodePayload[]; edges: GraphEdgePayload[]; meta: ... };
}
```

Implementation notes:
- confirmed seeds still come from canonical search
- candidate rows come from `canonical_candidates` in the same scope
- candidates must never outrank confirmed rows
- do not collapse both lists back into one list with status flags

- [ ] **Step 4: Run the graph tests to verify they pass**

Run: `npm test -- src/core/search-graph.test.ts src/tools/search-graph.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite before commit**

Run: `npm test`
Expected: PASS across the full suite, satisfying the repo commit gate for `src/**` and `test/**` changes.

- [ ] **Step 6: Commit**

```bash
git add src/core/search-graph.ts src/core/search-graph.test.ts src/tools/search-graph.ts src/tools/search-graph.test.ts
git commit -m "feat: split search graph confirmed and candidate results"
```

### Task 8: Document and verify the end-to-end pipeline

**Files:**
- Modify: `README.md`
- Test: `src/tools/add.test.ts`
- Test: `src/core/canonical-candidate-worker.test.ts`
- Test: `src/tools/search-graph.test.ts`

- [ ] **Step 1: Write the failing end-to-end regression test**

Add one end-to-end test that proves:
- `memory.add` creates a candidate immediately
- worker approval later produces confirmed canonical search_graph output
- candidate-only state appears in `candidates` before approval

- [ ] **Step 2: Run the regression test to verify it fails**

Run: `npm test -- src/tools/add.test.ts src/core/canonical-candidate-worker.test.ts src/tools/search-graph.test.ts`
Expected: FAIL on the new end-to-end expectation.

- [ ] **Step 3: Add the final implementation/docs adjustments**

Update `README.md` with:
- raw memory vs canonical candidate vs confirmed canonical flow
- background-job dependency for async judging
- new `search_graph` response shape

Only document flags that genuinely ship.

- [ ] **Step 4: Run the focused end-to-end tests**

Run: `npm test -- src/tools/add.test.ts src/core/canonical-candidate-worker.test.ts src/tools/search-graph.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full project test suite before any final merge**

Run: `npm test`
Expected: PASS across the full suite.

- [ ] **Step 6: Commit**

```bash
git add README.md src/tools/add.test.ts src/core/canonical-candidate-worker.test.ts src/tools/search-graph.test.ts
git commit -m "docs: describe automatic canonical candidate pipeline"
```
