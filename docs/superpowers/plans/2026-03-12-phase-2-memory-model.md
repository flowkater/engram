# Phase 2 Memory Model Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first canonical-memory layer to Engram so raw chunk memories can be manually promoted into durable facts and decisions with provenance, supersedes/contradicts edges, and time-aware search.

**Architecture:** Keep `memories` as raw evidence records with mutable lifecycle metadata (`access_count`, `deleted`, `updated_at`). Add a separate canonical layer on top of it with its own tables and search indexes so Engram can retrieve current truth without destroying the original evidence chain. Phase 2 v1 stays narrow on purpose: manual promotion only, canonical `fact`/`decision` only, `memory.search.asOf` only, and operational safety updates for prune/scheduler/health/stats.

**Tech Stack:** TypeScript, Node.js 22, better-sqlite3, sqlite-vec, FTS5, Vitest, MCP server (`@modelcontextprotocol/sdk`)

---

## Why Phase 2 Is The Correct Next Step

Phase 0 and Phase 1 acceptance criteria are already represented in the current codebase:

- Strict local mode and accurate embed provenance exist in `src/core/embedder.ts`.
- File-level checkpoints replaced the old source watermark in `src/core/database.ts` and `src/core/watcher.ts`.
- Scope mapping is externalized in `src/utils/scope.ts`.
- `minScore` is normalized in `src/tools/search.ts` and documented in `README.md`.
- The ingest surface is simplified in `src/tools/ingest.ts`.

What is still missing is exactly what `docs/roadmap/engram-feedback.md` calls out:

- raw chunk retrieval is good, but there is no canonical memory layer
- truth changes are not modeled
- decisions are not represented explicitly
- historical retrieval is not supported

That makes Phase 2 the correct next phase.

## Scope Boundaries

This plan covers only Phase 2 work from `docs/roadmap/engram-feedback-roadmap.md`:

- `2-1` manual memory promotion into canonical memories
- `2-2` supersedes / contradicts edges between canonical memories
- `2-3` explicit decision memories via `memory.promote`
- `2-4` `memory.search.asOf` for time-aware query

This plan explicitly does **not** include:

- auto-promotion based on `access_count`
- any change to `memory.add` semantics beyond raw evidence capture
- graph time-travel
- full typed-memory taxonomy
- Phase 3 connectors
- Phase 4 evaluation harness / inspector / feedback loop

## File Structure

### New Files

- Create: `src/core/canonical-memory.ts`
  Responsibility: canonical-memory CRUD, evidence links, edge writes, and time-filter helpers.
- Create: `src/core/canonical-memory.test.ts`
  Responsibility: canonical schema/helper coverage.
- Create: `src/tools/promote.ts`
  Responsibility: manual promotion MCP tool from raw memories to canonical memories.
- Create: `src/tools/promote.test.ts`
  Responsibility: promotion, decision memory, and canonical-edge tests.
- Create: `docs/roadmap/phase-2-memory-model-notes.md`
  Responsibility: schema contract, invariants, and migration notes.

### Existing Files To Modify

- Modify: `src/core/database.ts`
  Responsibility: add canonical tables and indexes only inside `openDatabase()`.
- Modify: `src/tools/search.ts`
  Responsibility: canonical-first search merge and optional `asOf` filtering.
- Modify: `src/tools/search.test.ts`
  Responsibility: canonical-first ranking and `asOf` behavior.
- Modify: `src/tools/context.ts`
  Responsibility: prefer canonical current-state memories while keeping context current-state only.
- Modify: `src/tools/context.test.ts`
  Responsibility: canonical-first context behavior.
- Modify: `src/tools/prune.ts`
  Responsibility: prevent pruning raw evidence still referenced by active canonical memories.
- Modify: `src/tools/prune.test.ts`
  Responsibility: canonical-aware prune safety.
- Modify: `src/core/scheduler.ts`
  Responsibility: ensure scheduled prune still uses canonical-safe pruning.
- Modify: `src/core/scheduler.test.ts`
  Responsibility: scheduled prune coverage.
- Modify: `src/tools/health.ts`
  Responsibility: canonical/evidence/edge integrity checks.
- Modify: `src/tools/health.test.ts`
  Responsibility: canonical integrity diagnostics coverage.
- Modify: `src/tools/stats.ts`
  Responsibility: expose canonical counts and evidence linkage totals.
- Modify: `src/tools/stats.test.ts`
  Responsibility: canonical stats coverage.
- Modify: `src/server.ts`
  Responsibility: register `memory.promote` and extend `memory.search` with `asOf`.
- Modify: `README.md`
  Responsibility: document promotion workflow and time-aware search.

## Canonical Schema Decision

Use explicit `canonical_*` tables so the new layer cannot be confused with existing raw `memory_*` tables.

```sql
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

CREATE TABLE IF NOT EXISTS canonical_evidence (
  canonical_id TEXT NOT NULL REFERENCES canonical_memories(id),
  memory_id TEXT NOT NULL REFERENCES memories(id),
  evidence_role TEXT NOT NULL CHECK (evidence_role IN ('source', 'decision-context')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (canonical_id, memory_id, evidence_role)
);

CREATE TABLE IF NOT EXISTS canonical_edges (
  from_canonical_id TEXT NOT NULL REFERENCES canonical_memories(id),
  to_canonical_id TEXT NOT NULL REFERENCES canonical_memories(id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('supersedes', 'contradicts')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_canonical_id, to_canonical_id, relation_type)
);
```

Canonical memories get their own indexes:

```sql
CREATE VIRTUAL TABLE canonical_memory_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[768]
);

CREATE VIRTUAL TABLE canonical_memory_fts USING fts5(
  id,
  title,
  content,
  scope,
  tokenize = "unicode61"
);
```

Design rules:

- `memories` stays the raw evidence store
- canonical truth lives in `canonical_memories`
- support is expressed through `canonical_evidence`, not a `supported_by` edge
- `supersedes` closes `valid_to`; `contradicts` does not auto-close anything

## MCP Surface Decision

Phase 2 v1 adds one new tool and one search extension:

- New tool: `memory.promote`
  Inputs: `memoryIds`, `kind`, `title`, `content`, `scope`, `confidence`, `importance`, `validFrom`, `decidedAt`, `supersedes`, `contradicts`
- Extend: `memory.search`
  New input: `asOf` in ISO-8601 format

Deliberate non-decision:

- No auto-promotion in Phase 2 v1
- No `memory.add` decision mode
- No `memory.context.asOf`

## Chunk 1: Canonical Storage And Manual Promotion

### Task 1: Lock The Canonical Contract

**Files:**
- Create: `docs/roadmap/phase-2-memory-model-notes.md`
- Modify: `docs/superpowers/plans/2026-03-12-phase-2-memory-model.md`
- Reference: `docs/roadmap/engram-feedback.md`
- Reference: `docs/roadmap/engram-feedback-roadmap.md`

- [ ] **Step 1: Write the failing contract note**

```md
## Canonical Contract

- raw `memories` are evidence records with mutable lifecycle metadata
- canonical truth lives only in `canonical_memories`
- `supersedes` closes predecessor validity
- `contradicts` marks conflict but does not auto-retire the target
```

- [ ] **Step 2: Review the note against roadmap language**

Run: `rg -n "promotion|decision|supersedes|contradicts|time-aware" docs/roadmap/engram-feedback*.md`
Expected: every Phase 2 item maps to one canonical-table or API responsibility

- [ ] **Step 3: Add explicit non-goals**

```md
- No auto-promotion
- No graph time-travel
- No new typed memory categories beyond fact/decision
- No connector ingestion in this phase
```

- [ ] **Step 4: Re-read and normalize names**

Run: `sed -n '1,220p' docs/roadmap/phase-2-memory-model-notes.md`
Expected: names exactly match `canonical_memories`, `canonical_evidence`, and `canonical_edges`

- [ ] **Step 5: Commit**

```bash
git add docs/roadmap/phase-2-memory-model-notes.md docs/superpowers/plans/2026-03-12-phase-2-memory-model.md
git commit -m "docs: lock phase 2 canonical contract"
```

### Task 2: Add Canonical Tables And Indexes

**Files:**
- Modify: `src/core/database.ts`
- Test: `src/core/canonical-memory.test.ts`
- Test: `src/core/database.test.ts`

- [ ] **Step 1: Write the failing schema tests**

```ts
it("creates canonical tables and indexes", () => {
  const tables = getSchemaObjects(db);
  expect(tables).toContain("canonical_memories");
  expect(tables).toContain("canonical_evidence");
  expect(tables).toContain("canonical_edges");
  expect(tables).toContain("canonical_memory_fts");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/core/canonical-memory.test.ts src/core/database.test.ts`
Expected: FAIL because canonical schema objects do not exist yet

- [ ] **Step 3: Implement the minimal schema in `openDatabase()`**

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS canonical_memories (...);
  CREATE TABLE IF NOT EXISTS canonical_evidence (...);
  CREATE TABLE IF NOT EXISTS canonical_edges (...);
`);
initCanonicalVec(db);
initCanonicalFts(db);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/core/canonical-memory.test.ts src/core/database.test.ts`
Expected: PASS with additive schema and no regression in current DB behavior

- [ ] **Step 5: Commit**

```bash
git add src/core/database.ts src/core/canonical-memory.test.ts src/core/database.test.ts
git commit -m "feat: add canonical memory schema"
```

### Task 3: Add Canonical Repository Helpers

**Files:**
- Create: `src/core/canonical-memory.ts`
- Test: `src/core/canonical-memory.test.ts`

- [ ] **Step 1: Write the failing repository tests**

```ts
it("creates a canonical memory with evidence rows", () => {
  const canonicalId = createCanonicalMemory(db, {
    kind: "fact",
    title: "Auth uses JWT",
    content: "Authentication uses JWT access tokens.",
    evidenceMemoryIds: [rawId],
  });
  expect(listCanonicalEvidence(db, canonicalId)).toHaveLength(1);
});

it("adds a supersedes edge without deleting the predecessor", () => {
  addCanonicalEdge(db, { fromId: newerId, toId: olderId, relationType: "supersedes" });
  expect(getCanonicalMemory(db, olderId)?.valid_to).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/core/canonical-memory.test.ts`
Expected: FAIL because the helper module does not exist

- [ ] **Step 3: Implement the minimal helper surface**

```ts
export function createCanonicalMemory(db, input): string
export function addCanonicalEdge(db, input): void
export function listCanonicalEvidence(db, canonicalId): CanonicalEvidenceRow[]
export function findCanonicalMemories(db, filters): CanonicalMemoryRow[]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/core/canonical-memory.test.ts`
Expected: PASS for create/list/edge/time-filter basics

- [ ] **Step 5: Commit**

```bash
git add src/core/canonical-memory.ts src/core/canonical-memory.test.ts
git commit -m "feat: add canonical memory repository"
```

### Task 4: Implement `memory.promote` For Facts And Decisions

**Files:**
- Create: `src/tools/promote.ts`
- Modify: `src/server.ts`
- Test: `src/tools/promote.test.ts`
- Test: `src/server.test.ts`

- [ ] **Step 1: Write the failing promotion tests**

```ts
it("promotes raw memories into a canonical fact", async () => {
  const result = await memoryPromote(db, {
    memoryIds: [rawId1, rawId2],
    kind: "fact",
    title: "Auth uses JWT",
    content: "Authentication uses JWT access tokens.",
  });
  expect(result.canonicalId).toBeTruthy();
});

it("promotes a canonical decision with decidedAt metadata", async () => {
  const result = await memoryPromote(db, {
    memoryIds: [rawDecisionId],
    kind: "decision",
    title: "Keep SQLite",
    content: "SQLite remains the primary local store.",
    decidedAt: "2026-03-12T00:00:00.000Z",
  });
  expect(result.kind).toBe("decision");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/tools/promote.test.ts src/server.test.ts`
Expected: FAIL because `memory.promote` is missing

- [ ] **Step 3: Implement minimal promotion flow**

```ts
const { embedding, model } = await embed(input.content, embedOpts, true);
db.transaction(() => {
  createCanonicalMemory(db, canonicalInput);
  insertCanonicalVec.run(canonicalId, Buffer.from(embedding.buffer));
  insertCanonicalFts.run(canonicalId, input.title, input.content, input.scope);
  for (const memoryId of input.memoryIds) {
    insertCanonicalEvidence.run(canonicalId, memoryId, "source", now);
  }
})();
```

- [ ] **Step 4: Register the MCP tool**

Run: `npm test -- src/tools/promote.test.ts src/server.test.ts`
Expected: PASS with `memory.promote` registered and tool I/O stable

- [ ] **Step 5: Commit**

```bash
git add src/tools/promote.ts src/tools/promote.test.ts src/server.ts src/server.test.ts
git commit -m "feat: add manual canonical promotion"
```

## Chunk 2: Retrieval And Operational Safety

### Task 5: Extend Search With Canonical Priority And `asOf`

**Files:**
- Modify: `src/tools/search.ts`
- Modify: `src/tools/search.test.ts`
- Modify: `src/server.ts`
- Test: `src/server.test.ts`

- [ ] **Step 1: Write the failing search tests**

```ts
it("prefers canonical memories over duplicate raw evidence", async () => {
  const results = await memorySearch(db, { query: "JWT auth", limit: 5 });
  expect(results[0].isCanonical).toBe(true);
});

it("filters canonical memories by asOf", async () => {
  const results = await memorySearch(db, {
    query: "auth mechanism",
    asOf: "2026-03-01T00:00:00.000Z",
  });
  expect(results.every((r) => !r.valid_to || r.valid_to >= "2026-03-01T00:00:00.000Z")).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/tools/search.test.ts src/server.test.ts`
Expected: FAIL because search only queries raw `memories`

- [ ] **Step 3: Implement canonical-first merge**

```ts
const canonicalResults = hybridSearchCanonical(db, params);
const rawResults = hybridSearchRaw(db, params);
const merged = mergeCanonicalFirst(canonicalResults, rawResults, params.limit);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/tools/search.test.ts src/server.test.ts`
Expected: PASS with `asOf` accepted by the MCP schema and canonical hits ranked first

- [ ] **Step 5: Commit**

```bash
git add src/tools/search.ts src/tools/search.test.ts src/server.ts src/server.test.ts
git commit -m "feat: add time-aware canonical search"
```

### Task 6: Keep Context Current-State Only, But Canonical-First

**Files:**
- Modify: `src/tools/context.ts`
- Modify: `src/tools/context.test.ts`

- [ ] **Step 1: Write the failing context test**

```ts
it("returns promoted canonical memories before duplicate raw chunks", () => {
  const result = memoryContext(db, { cwd: projectCwd, limit: 5 });
  expect(result.memories[0].isCanonical).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/tools/context.test.ts`
Expected: FAIL because context only reads raw `memories`

- [ ] **Step 3: Implement current-state canonical-first context**

```ts
const canonical = selectCanonicalCurrentState(db, scope, limit);
const raw = selectRawContextEvidence(db, scope, limit);
return dedupeContext(canonical, raw).slice(0, limit);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/tools/context.test.ts`
Expected: PASS with canonical memories preferred and no `asOf` added to context

- [ ] **Step 5: Commit**

```bash
git add src/tools/context.ts src/tools/context.test.ts
git commit -m "feat: prefer canonical memories in context"
```

### Task 7: Make Prune, Scheduler, Health, And Stats Canonical-Aware

**Files:**
- Modify: `src/tools/prune.ts`
- Modify: `src/tools/prune.test.ts`
- Modify: `src/core/scheduler.ts`
- Modify: `src/core/scheduler.test.ts`
- Modify: `src/tools/health.ts`
- Modify: `src/tools/health.test.ts`
- Modify: `src/tools/stats.ts`
- Modify: `src/tools/stats.test.ts`
- Modify: `README.md`
- Modify: `docs/roadmap/phase-2-memory-model-notes.md`

- [ ] **Step 1: Write the failing operational-safety tests**

```ts
it("does not prune raw memories referenced by active canonical memories", () => {
  const result = memoryPrune(db, { olderThanDays: 90, dryRun: false });
  expect(result.deletedCount).toBe(0);
});

it("reports canonical orphan counts in health", () => {
  const health = memoryHealth(db);
  expect(health.orphanedCanonicalEvidence).toBeDefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/tools/prune.test.ts src/core/scheduler.test.ts src/tools/health.test.ts src/tools/stats.test.ts`
Expected: FAIL because operational tools ignore canonical tables

- [ ] **Step 3: Implement minimal safety rules**

```ts
// prune.ts
WHERE id NOT IN (
  SELECT memory_id FROM canonical_evidence ce
  JOIN canonical_memories cm ON cm.id = ce.canonical_id
  WHERE cm.valid_to IS NULL
)
```

- [ ] **Step 4: Run tests to verify they pass and update docs**

Run: `npm test -- src/tools/prune.test.ts src/core/scheduler.test.ts src/tools/health.test.ts src/tools/stats.test.ts && npm test`
Expected: PASS, and docs explain that canonical memories protect linked raw evidence from prune

- [ ] **Step 5: Commit**

```bash
git add src/tools/prune.ts src/tools/prune.test.ts src/core/scheduler.ts src/core/scheduler.test.ts src/tools/health.ts src/tools/health.test.ts src/tools/stats.ts src/tools/stats.test.ts README.md docs/roadmap/phase-2-memory-model-notes.md
git commit -m "feat: make operations canonical-aware"
```

## Verification Steps

- Run: `npm test -- src/core/canonical-memory.test.ts src/tools/promote.test.ts src/tools/search.test.ts src/tools/context.test.ts src/tools/prune.test.ts src/tools/health.test.ts src/tools/stats.test.ts src/core/scheduler.test.ts`
  Expected: all Phase 2 tests pass
- Run: `npm test`
  Expected: entire suite stays green
- Run: `npm run build`
  Expected: TypeScript/tsup build succeeds without ESM import regressions
- Run: `node dist/cli.js stats`
  Expected: stats output includes canonical counts

## Risks And Mitigations

- Risk: canonical scope explodes into a full knowledge-model rewrite.
  Mitigation: restrict Phase 2 v1 to `fact` and `decision`.
- Risk: noisy `access_count` creates false canonical truths.
  Mitigation: do not ship auto-promotion in Phase 2 v1.
- Risk: raw/canonical boundaries blur again.
  Mitigation: keep `memory.add` raw-only and route all canonical creation through `memory.promote`.
- Risk: scheduled prune quietly removes canonical evidence.
  Mitigation: make `prune`, `scheduler`, `health`, and `stats` canonical-aware in the same phase.
- Risk: contradiction logic retires valid competing claims.
  Mitigation: only `supersedes` closes validity; `contradicts` remains non-destructive.

## Execution Notes

- Use @superpowers:test-driven-development for every task.
- Use @superpowers:verification-before-completion before claiming Phase 2 is done.
- Keep commits task-scoped.
- Defer graph/time-travel and auto-promotion until Phase 2 v1 is stable on real usage data.

Plan complete and saved to `docs/superpowers/plans/2026-03-12-phase-2-memory-model.md`. Ready to execute?
