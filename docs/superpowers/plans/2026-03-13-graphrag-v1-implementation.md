# GraphRAG V1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an experimental `memory.search_graph` path that performs canonical-first graph-assisted retrieval and an internal evaluation harness that compares it against the current search path using real usage queries.

**Architecture:** Keep `memory.search` untouched as the production baseline. Build GraphRAG as a separate retrieval pipeline that reuses current canonical search behavior for seeds, expands through `canonical_edges` and `canonical_evidence`, reranks canonicals heuristically, and returns `results + graph` in a Cytoscape-friendly shape. Capture real search queries to a local query log, then evaluate baseline search versus GraphRAG offline using canonical memories as the temporary gold set.

**Tech Stack:** TypeScript, Node.js 22, better-sqlite3, sqlite-vec, FTS5, Vitest, MCP server (`@modelcontextprotocol/sdk`), JSONL query logs

---

## File Structure

### New Files

- Create: `src/core/search-graph.ts`
  Responsibility: canonical seed retrieval, graph expansion, heuristic rerank, and graph payload assembly.
- Create: `src/core/search-graph.test.ts`
  Responsibility: graph expansion, conflict flagging, and result ordering coverage.
- Create: `src/tools/search-graph.ts`
  Responsibility: MCP-facing adapter for experimental graph search.
- Create: `src/tools/search-graph.test.ts`
  Responsibility: tool-level response-shape coverage.
- Create: `src/core/query-log.ts`
  Responsibility: append/read JSONL search query logs for baseline and graph search.
- Create: `src/core/query-log.test.ts`
  Responsibility: query-log writer/reader coverage.
- Create: `src/core/search-graph-eval.ts`
  Responsibility: load query datasets, resolve temporary gold canonicals, execute baseline vs graph runs, and compute metrics.
- Create: `src/core/search-graph-eval.test.ts`
  Responsibility: dataset filtering and metric-computation coverage.
- Create: `scripts/eval-search-graph.ts`
  Responsibility: local CLI entrypoint for internal evaluation runs.
- Create: `test/e2e/query-log-wiring.test.ts`
  Responsibility: server-level verification that both search tools append distinct query-log entries.

### Existing Files To Modify

- Modify: `src/server.ts`
  Responsibility: register `memory.search_graph` and log `memory.search` / `memory.search_graph` queries for later evaluation.
- Modify: `src/server.test.ts`
  Responsibility: assert the new MCP tool is registered.
- Modify: `README.md`
  Responsibility: document the experimental tool, query-log behavior, and evaluation command.
- Reference: `docs/superpowers/specs/2026-03-13-graphrag-v1-design.md`
  Responsibility: approved design contract for this plan.

## Chunk 1: Graph Search Pipeline

### Task 1: Lock The Graph Search Contract

**Files:**
- Create: `src/tools/search-graph.test.ts`
- Modify: `src/server.test.ts`
- Reference: `docs/superpowers/specs/2026-03-13-graphrag-v1-design.md`

- [ ] **Step 1: Write the failing tool contract test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "../core/database.js";
import { memoryAdd } from "./add.js";
import { memoryPromote } from "./promote.js";
import { memorySearchGraph } from "./search-graph.js";
import path from "node:path";
import os from "node:os";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-search-graph-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("memory.search_graph", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("returns canonical-only ranked results plus graph payload", async () => {
    const raw = await memoryAdd(inst.db, {
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      source: "manual",
    });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const result = await memorySearchGraph(inst.db, {
      query: "jwt auth",
      scope: "todait-backend",
      limit: 5,
      hopDepth: 1,
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((item) => item.isCanonical === true)).toBe(true);
    expect(result.graph.nodes.length).toBeGreaterThan(0);
    expect(result.graph.meta.hopDepth).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tool contract test and server tool test to verify failure**

Run: `npm test -- src/tools/search-graph.test.ts src/server.test.ts`
Expected: FAIL because `memorySearchGraph` and the `memory.search_graph` MCP registration do not exist yet

- [ ] **Step 3: Extend the server registration test**

Add `"memory.search_graph"` to `ALL_TOOLS` in `src/server.test.ts` and update the expected count from `11` to `12`.

- [ ] **Step 4: Re-run the same test command**

Run: `npm test -- src/tools/search-graph.test.ts src/server.test.ts`
Expected: FAIL with the new tool still missing but the expected tool count updated

- [ ] **Step 5: Do not commit yet**

Because this repository forbids commits while tests are failing, keep these red tests uncommitted and carry them into Task 2.

### Task 2: Build The Graph Retrieval Core

**Files:**
- Create: `src/core/search-graph.ts`
- Create: `src/core/search-graph.test.ts`
- Reference: `src/tools/search.ts`
- Reference: `src/core/canonical-memory.ts`

- [ ] **Step 1: Write the failing core tests for expansion and conflict handling**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { memoryAdd } from "../tools/add.js";
import { memoryPromote } from "../tools/promote.js";
import { runGraphSearch } from "./search-graph.js";
import path from "node:path";
import os from "node:os";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-search-graph-core-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("runGraphSearch", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("uses canonical seeds and returns canonical-only ranked results", async () => {
    const raw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const result = await runGraphSearch(inst.db, { query: "jwt auth", scope: "todait-backend", limit: 5, hopDepth: 1 });
    expect(result.results.every((row) => row.isCanonical === true)).toBe(true);
    expect(result.graph.nodes.some((node) => node.kind === "raw")).toBe(false);
  });

  it("sets hasConflict when contradiction edges are expanded", async () => {
    const oldRaw = await memoryAdd(inst.db, { content: "Authentication uses cookie sessions.", scope: "todait-backend" });
    const newRaw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    const oldCanon = await memoryPromote(inst.db, {
      memoryIds: [oldRaw.id],
      kind: "fact",
      title: "Old auth",
      content: "Authentication uses cookie sessions.",
      scope: "todait-backend",
    });
    await memoryPromote(inst.db, {
      memoryIds: [newRaw.id],
      kind: "fact",
      title: "Current auth",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      contradicts: [oldCanon.canonicalId],
    });

    const result = await runGraphSearch(inst.db, { query: "authentication", scope: "todait-backend", limit: 5, hopDepth: 1 });
    expect(result.results.some((row) => row.hasConflict)).toBe(true);
    expect(result.graph.edges.some((edge) => edge.type === "contradicts")).toBe(true);
  });

  it("adds raw evidence only to graph payload after expansion", async () => {
    const raw = await memoryAdd(inst.db, { content: "Procedure note: rotate JWT signing keys monthly.", scope: "todait-backend" });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "decision",
      title: "JWT signing key rotation",
      content: "JWT signing keys rotate monthly.",
      scope: "todait-backend",
    });

    const result = await runGraphSearch(inst.db, { query: "signing keys", scope: "todait-backend", limit: 5, hopDepth: 1 });
    expect(result.results.every((row) => row.kind !== "raw")).toBe(true);
    expect(result.graph.nodes.some((node) => node.kind === "raw")).toBe(true);
  });

  it("honors asOf and prefers current canonical truth over superseded truth", async () => {
    const oldRaw = await memoryAdd(inst.db, { content: "Authentication uses cookie sessions.", scope: "todait-backend" });
    const newRaw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    const oldCanon = await memoryPromote(inst.db, {
      memoryIds: [oldRaw.id],
      kind: "fact",
      title: "Old auth",
      content: "Authentication uses cookie sessions.",
      scope: "todait-backend",
      validFrom: "2026-01-01T00:00:00.000Z",
    });
    await memoryPromote(inst.db, {
      memoryIds: [newRaw.id],
      kind: "fact",
      title: "Current auth",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
      validFrom: "2026-03-01T00:00:00.000Z",
      supersedes: [oldCanon.canonicalId],
    });

    const february = await runGraphSearch(inst.db, {
      query: "authentication",
      scope: "todait-backend",
      asOf: "2026-02-01T00:00:00.000Z",
      limit: 5,
      hopDepth: 1,
    });
    const april = await runGraphSearch(inst.db, {
      query: "authentication",
      scope: "todait-backend",
      asOf: "2026-04-01T00:00:00.000Z",
      limit: 5,
      hopDepth: 1,
    });

    expect(february.results[0].content).toContain("cookie sessions");
    expect(april.results[0].content).toContain("JWT access tokens");
  });

  it("fills graph.meta with the agreed debug fields", async () => {
    const raw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const result = await runGraphSearch(inst.db, { query: "jwt auth", scope: "todait-backend", limit: 5, hopDepth: 1 });
    expect(result.graph.meta.seedCount).toBeGreaterThan(0);
    expect(result.graph.meta.expandedNodeCount).toBeGreaterThanOrEqual(result.graph.nodes.length);
    expect(result.graph.meta.rerankVersion).toBe("v1");
  });
});
```

- [ ] **Step 2: Run the core test file to verify failure**

Run: `npm test -- src/core/search-graph.test.ts`
Expected: FAIL because `runGraphSearch` does not exist yet

- [ ] **Step 3: Implement the minimal graph-search contracts**

Create `src/core/search-graph.ts` with these exact public interfaces:

```ts
import type Database from "better-sqlite3";
import { memorySearch } from "../tools/search.js";

export interface SearchGraphParams {
  query: string;
  scope?: string;
  limit?: number;
  asOf?: string;
  hopDepth?: 1 | 2;
}

export interface SearchGraphResultItem {
  id: string;
  summary: string | null;
  content: string;
  scope: string;
  score: number;
  isCanonical: true;
  kind: "fact" | "decision";
  hasConflict: boolean;
}

export interface GraphNodePayload {
  id: string;
  kind: "canonical" | "raw";
  label: string;
  scope: string;
  canonicalKind?: "fact" | "decision";
}

export interface GraphEdgePayload {
  id: string;
  source: string;
  target: string;
  type: "supersedes" | "contradicts" | "canonical_evidence";
}

export interface SearchGraphResponse {
  results: SearchGraphResultItem[];
  graph: {
    nodes: GraphNodePayload[];
    edges: GraphEdgePayload[];
    meta: {
      seedCount: number;
      expandedNodeCount: number;
      hopDepth: 1 | 2;
      rerankVersion: string;
    };
  };
}

export async function runGraphSearch(
  db: Database.Database,
  params: SearchGraphParams
): Promise<SearchGraphResponse> {
  // implement in later steps
}
```

- [ ] **Step 4: Implement seed retrieval by reusing `memorySearch`**

Use `memorySearch(db, { query, scope, limit: seedLimit, asOf })`, but keep fetching until you have enough canonical seeds for the requested limit. Do not rely on one mixed raw+canonical result page.

```ts
const requestedLimit = params.limit ?? 10;
const hopDepth = params.hopDepth ?? 1;
const multipliers = [3, 5, 10];
let canonicalSeeds: Awaited<ReturnType<typeof memorySearch>> = [];

for (const multiplier of multipliers) {
  const baseline = await memorySearch(db, {
    query: params.query,
    scope: params.scope,
    limit: Math.max(requestedLimit * multiplier, 10),
    asOf: params.asOf,
  });

  canonicalSeeds = baseline.filter((row) => row.isCanonical === true);
  if (canonicalSeeds.length >= requestedLimit || baseline.length < Math.max(requestedLimit * multiplier, 10)) {
    break;
  }
}
```

- [ ] **Step 5: Implement graph expansion with only approved edge types**

Query `canonical_edges` bidirectionally for `supersedes` / `contradicts`, and query `canonical_evidence` for raw evidence links.

```ts
const edgeRows = db.prepare(`
  SELECT from_canonical_id, to_canonical_id, relation_type
  FROM canonical_edges
  WHERE (from_canonical_id = ? OR to_canonical_id = ?)
`).all(canonicalId, canonicalId) as Array<{
  from_canonical_id: string;
  to_canonical_id: string;
  relation_type: "supersedes" | "contradicts";
}>;

const evidenceRows = db.prepare(`
  SELECT canonical_id, memory_id
  FROM canonical_evidence
  WHERE canonical_id = ?
`).all(canonicalId) as Array<{ canonical_id: string; memory_id: string }>;
```

- [ ] **Step 6: Implement the minimal heuristic rerank**

Start with explicit constants in `src/core/search-graph.ts`:

```ts
const RERANK_VERSION = "v1";
const CURRENT_CANONICAL_BONUS = 0.15;
const SUPERSEDED_PENALTY = 0.20;
const CONTRADICTION_PENALTY = 0.10;
const EVIDENCE_BONUS = 0.05;
```

Apply them to canonical result rows only:

- add `CURRENT_CANONICAL_BONUS` when `valid_to` is null or after `asOf`
- subtract `SUPERSEDED_PENALTY` when the node is retired
- subtract `CONTRADICTION_PENALTY` when any contradiction edge is present
- add `EVIDENCE_BONUS` when the node has at least one evidence link

- [ ] **Step 7: Re-run the core tests**

Run: `npm test -- src/core/search-graph.test.ts`
Expected: PASS with graph nodes, edges, and `hasConflict` all present

- [ ] **Step 8: Commit the core**

```bash
git add src/core/search-graph.ts src/core/search-graph.test.ts
git commit -m "feat: add canonical graph retrieval core"
```

### Task 3: Expose The Experimental MCP Tool

**Files:**
- Create: `src/tools/search-graph.ts`
- Modify: `src/server.ts`
- Test: `src/tools/search-graph.test.ts`
- Test: `src/server.test.ts`

- [ ] **Step 1: Implement the tool adapter**

Create `src/tools/search-graph.ts`:

```ts
import type Database from "better-sqlite3";
import { runGraphSearch, type SearchGraphParams, type SearchGraphResponse } from "../core/search-graph.js";

export async function memorySearchGraph(
  db: Database.Database,
  params: SearchGraphParams
): Promise<SearchGraphResponse> {
  return runGraphSearch(db, params);
}
```

- [ ] **Step 2: Register the MCP tool in `src/server.ts`**

Add the import:

```ts
import { memorySearchGraph } from "./tools/search-graph.js";
```

Register the tool with this schema:

```ts
server.tool(
  "memory.search_graph",
  "Experimental canonical-first graph-assisted search.",
  {
    query: z.string().describe("Search query"),
    scope: z.string().optional().describe("Project scope filter"),
    limit: z.number().optional().describe("Max results (default 10)"),
    asOf: z.string().optional().describe("Optional ISO timestamp for time-aware canonical search"),
    hopDepth: z.union([z.literal(1), z.literal(2)]).optional().describe("Graph expansion depth"),
  },
  async ({ query, scope, limit, asOf, hopDepth }) => {
    try {
      sessionTracker.recordActivity("memory.search_graph", { query, scope, limit, asOf, hopDepth });
      const results = await memorySearchGraph(db, { query, scope, limit, asOf, hopDepth });
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return errorResponse("memory.search_graph", err);
    }
  }
);
```

- [ ] **Step 3: Re-run the tool contract and server tests**

Run: `npm test -- src/tools/search-graph.test.ts src/server.test.ts`
Expected: PASS with `memory.search_graph` registered and returning the agreed response shape

- [ ] **Step 4: Add one focused integration test for `asOf` + `hopDepth` passthrough**

Extend `src/tools/search-graph.test.ts` with:

```ts
it("passes asOf and hopDepth through to the core response meta", async () => {
  const raw = await memoryAdd(inst.db, {
    content: "Authentication uses JWT access tokens.",
    scope: "todait-backend",
  });
  await memoryPromote(inst.db, {
    memoryIds: [raw.id],
    kind: "fact",
    title: "Current auth mechanism",
    content: "Authentication uses JWT access tokens.",
    scope: "todait-backend",
    validFrom: "2026-03-01T00:00:00.000Z",
  });

  const result = await memorySearchGraph(inst.db, {
    query: "auth mechanism",
    scope: "todait-backend",
    asOf: "2026-04-01T00:00:00.000Z",
    hopDepth: 2,
  });

  expect(result.graph.meta.hopDepth).toBe(2);
});
```

- [ ] **Step 5: Re-run all GraphRAG pipeline tests**

Run: `npm test -- src/core/search-graph.test.ts src/tools/search-graph.test.ts src/server.test.ts`
Expected: PASS

- [ ] **Step 6: Commit the MCP surface**

```bash
git add src/tools/search-graph.ts src/tools/search-graph.test.ts src/server.ts src/server.test.ts
git commit -m "feat: expose experimental graph search tool"
```

## Chunk 2: Real-Usage Evaluation Harness

### Task 4: Capture Real Search Queries

**Files:**
- Create: `src/core/query-log.ts`
- Create: `src/core/query-log.test.ts`
- Create: `test/e2e/query-log-wiring.test.ts`
- Modify: `src/server.ts`
- Reference: `src/core/session-tracker.ts`

- [ ] **Step 1: Write the failing query-log tests**

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendSearchQueryLog, readSearchQueryLog } from "./query-log.js";

describe("query log", () => {
  it("appends JSONL entries and reads them back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-query-log-"));
    const logPath = path.join(dir, "search-queries.jsonl");

    appendSearchQueryLog(logPath, {
      tool: "memory.search",
      query: "jwt auth",
      scope: "todait-backend",
      timestamp: "2026-03-13T00:00:00.000Z",
    });

    const rows = readSearchQueryLog(logPath);
    expect(rows).toHaveLength(1);
    expect(rows[0].query).toBe("jwt auth");
  });
});
```

- [ ] **Step 2: Run the query-log test to verify failure**

Run: `npm test -- src/core/query-log.test.ts`
Expected: FAIL because `query-log.ts` does not exist yet

- [ ] **Step 3: Implement the JSONL query log helpers**

Create `src/core/query-log.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

export interface SearchQueryLogEntry {
  tool: "memory.search" | "memory.search_graph";
  query: string;
  scope?: string;
  timestamp: string;
}

export function resolveSearchQueryLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGRAM_QUERY_LOG_PATH ||
    path.join(env.HOME || "~", ".engram", "logs", "search-queries.jsonl");
}

export function appendSearchQueryLog(logPath: string, entry: SearchQueryLogEntry): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

export function readSearchQueryLog(logPath: string): SearchQueryLogEntry[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SearchQueryLogEntry);
}
```

- [ ] **Step 4: Wire query logging into `src/server.ts`**

Only log real search queries:

```ts
import { appendSearchQueryLog, resolveSearchQueryLogPath } from "./core/query-log.js";
```

Inside the `memory.search` handler:

```ts
appendSearchQueryLog(resolveSearchQueryLogPath(), {
  tool: "memory.search",
  query,
  scope,
  timestamp: new Date().toISOString(),
});
```

Inside the `memory.search_graph` handler:

```ts
appendSearchQueryLog(resolveSearchQueryLogPath(), {
  tool: "memory.search_graph",
  query,
  scope,
  timestamp: new Date().toISOString(),
});
```

- [ ] **Step 5: Re-run query-log tests and the server tool test**

Run: `npm test -- src/core/query-log.test.ts`
Expected: PASS

- [ ] **Step 6: Add a focused server-level wiring test**

Create `test/e2e/query-log-wiring.test.ts` that:

- boots the built server with temp `HOME`, `MEMORY_DB`, and `ENGRAM_QUERY_LOG_PATH`
- invokes `memory.search`
- invokes `memory.search_graph`
- reads the JSONL log file
- asserts two entries exist with distinct `tool` values

Minimum assertion shape:

```ts
expect(rows.map((row) => row.tool)).toEqual([
  "memory.search",
  "memory.search_graph",
]);
```

- [ ] **Step 7: Re-run the same verification after the wiring test exists**

Run: `npm test -- src/core/query-log.test.ts test/e2e/query-log-wiring.test.ts`
Expected: PASS

- [ ] **Step 8: Commit query capture**

```bash
git add src/core/query-log.ts src/core/query-log.test.ts test/e2e/query-log-wiring.test.ts src/server.ts
git commit -m "feat: log search queries for graph eval"
```

### Task 5: Add The Offline Evaluation Core

**Files:**
- Create: `src/core/search-graph-eval.ts`
- Create: `src/core/search-graph-eval.test.ts`
- Reference: `src/tools/search.ts`
- Reference: `src/core/search-graph.ts`
- Reference: `src/core/query-log.ts`

- [ ] **Step 1: Write the failing evaluation tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { memoryAdd } from "../tools/add.js";
import { memoryPromote } from "../tools/promote.js";
import { evaluateSearchGraphQueries } from "./search-graph-eval.js";
import path from "node:path";
import os from "node:os";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-search-graph-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("evaluateSearchGraphQueries", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("filters logged queries to those with at least one canonical gold target", async () => {
    const raw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const report = await evaluateSearchGraphQueries(inst.db, [
      { tool: "memory.search", query: "jwt auth", scope: "todait-backend", timestamp: "2026-03-13T00:00:00.000Z" },
      { tool: "memory.search", query: "unrelated query", scope: "todait-backend", timestamp: "2026-03-13T00:00:00.000Z" },
    ]);

    expect(report.queriesConsidered).toBe(2);
    expect(report.queriesEvaluated).toBe(1);
  });

  it("reports hit@k, MRR, and top-1 precision for baseline and graph search", async () => {
    const raw = await memoryAdd(inst.db, { content: "Authentication uses JWT access tokens.", scope: "todait-backend" });
    await memoryPromote(inst.db, {
      memoryIds: [raw.id],
      kind: "fact",
      title: "Current auth mechanism",
      content: "Authentication uses JWT access tokens.",
      scope: "todait-backend",
    });

    const report = await evaluateSearchGraphQueries(inst.db, [
      { tool: "memory.search", query: "jwt auth", scope: "todait-backend", timestamp: "2026-03-13T00:00:00.000Z" },
    ]);

    expect(report.baseline.hitAtK).toBeGreaterThanOrEqual(0);
    expect(report.graph.hitAtK).toBeGreaterThanOrEqual(0);
    expect(report.graph.mrr).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run the evaluation test to verify failure**

Run: `npm test -- src/core/search-graph-eval.test.ts`
Expected: FAIL because the evaluation module does not exist yet

- [ ] **Step 3: Implement the minimal evaluation contracts**

Create `src/core/search-graph-eval.ts` with these public exports:

```ts
import type Database from "better-sqlite3";
import { memorySearch } from "../tools/search.js";
import { runGraphSearch } from "./search-graph.js";
import type { SearchQueryLogEntry } from "./query-log.js";

export interface SearchMetricSummary {
  hitAtK: number;
  mrr: number;
  top1Precision: number;
}

export interface SearchGraphEvalReport {
  queriesConsidered: number;
  queriesEvaluated: number;
  baseline: SearchMetricSummary;
  graph: SearchMetricSummary;
}

export async function evaluateSearchGraphQueries(
  db: Database.Database,
  entries: SearchQueryLogEntry[],
  limit = 5
): Promise<SearchGraphEvalReport> {
  // implement in later steps
}
```

- [ ] **Step 4: Implement temporary gold resolution from canonical memories**

For each logged query:

- run `memorySearch(db, { query, scope, limit, asOf })`
- keep only canonical rows
- skip the query if no canonical rows exist
- treat the remaining canonical IDs as the temporary gold set

- [ ] **Step 5: Implement baseline vs graph comparison**

For every evaluable query:

- run `memorySearch` as baseline
- run `runGraphSearch` as graph variant
- map both result sets to canonical IDs only before scoring
- compare the canonical IDs against the temporary gold set

Implement metric helpers directly in the file:

```ts
function computeHitAtK(resultIds: string[], goldIds: Set<string>): number {
  return resultIds.some((id) => goldIds.has(id)) ? 1 : 0;
}

function computeReciprocalRank(resultIds: string[], goldIds: Set<string>): number {
  const index = resultIds.findIndex((id) => goldIds.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

function computeTop1Precision(resultIds: string[], goldIds: Set<string>): number {
  return resultIds.length > 0 && goldIds.has(resultIds[0]) ? 1 : 0;
}
```

Canonical-only normalization should be explicit:

```ts
const baselineIds = baselineResults
  .filter((row) => row.isCanonical === true)
  .map((row) => row.id);

const graphIds = graphResults.results.map((row) => row.id);
```

- [ ] **Step 6: Re-run the evaluation tests**

Run: `npm test -- src/core/search-graph-eval.test.ts`
Expected: PASS

- [ ] **Step 7: Commit the evaluation core**

```bash
git add src/core/search-graph-eval.ts src/core/search-graph-eval.test.ts
git commit -m "feat: add graph search eval core"
```

### Task 6: Add The CLI Runner And Documentation

**Files:**
- Create: `scripts/eval-search-graph.ts`
- Modify: `README.md`
- Test: `src/core/search-graph-eval.test.ts`
- Test: `src/core/query-log.test.ts`

- [ ] **Step 1: Add the CLI runner**

Create `scripts/eval-search-graph.ts`:

```ts
#!/usr/bin/env node
import { openDatabase } from "../src/core/database.js";
import { readSearchQueryLog, resolveSearchQueryLogPath } from "../src/core/query-log.js";
import { evaluateSearchGraphQueries } from "../src/core/search-graph-eval.js";

async function main() {
  const dbPath = process.env.MEMORY_DB;
  if (!dbPath) {
    throw new Error("MEMORY_DB is required");
  }

  const { db, close } = openDatabase(dbPath);
  try {
    const entries = readSearchQueryLog(resolveSearchQueryLogPath());
    const report = await evaluateSearchGraphQueries(db, entries);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Document the experiment in `README.md`**

Add a short section:

```md
## Experimental Graph Search

- `memory.search_graph` is an internal experiment and does not replace `memory.search`
- search queries are logged to `~/.engram/logs/search-queries.jsonl` for offline evaluation
- `ENGRAM_QUERY_LOG_PATH` overrides the default query-log file for isolated dev/test runs
- run `npx tsx scripts/eval-search-graph.ts` with `MEMORY_DB=/path/to/memory.db` to compare baseline search and GraphRAG
```

- [ ] **Step 3: Run the focused verification for the evaluation slice**

Run: `npm test -- src/core/query-log.test.ts src/core/search-graph-eval.test.ts src/tools/search-graph.test.ts`
Expected: PASS

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS with all existing tests green and new GraphRAG tests included

- [ ] **Step 5: Run the production build**

Run: `npm run build`
Expected: PASS and `dist/server.js` updated successfully

- [ ] **Step 6: Commit the evaluation runner and docs**

```bash
git add scripts/eval-search-graph.ts README.md
git commit -m "docs: wire graph search evaluation flow"
```

## Final Verification

- [ ] Run: `npm test`
  Expected: PASS
- [ ] Run: `npm run build`
  Expected: PASS
- [ ] Run: `git status --short`
  Expected: clean working tree

## Notes For Implementers

- Keep GraphRAG v1 headless. Do not start Cytoscape.js or web UI work in this plan.
- Do not touch `memory.graph`; this experiment is separate from the existing raw `memory_links` traversal tool.
- Do not add `wikilink`, `tag`, or connector-derived edges.
- Do not change the production behavior of `memory.search`.
- Keep the query-log format append-only and local-only.
- If query logging raises privacy concerns later, gate it with an env flag in a follow-up instead of expanding this plan now.
