# GraphRAG V1 Design

Date: 2026-03-13
Status: Draft approved for planning

## Goal

Add a GraphRAG experiment to Engram that improves search accuracy without changing the production `memory.search` path.

The first version is an evaluation-first retrieval experiment:

- keep the current vector + FTS + RRF pipeline as the baseline
- add a separate experimental MCP tool for graph-assisted retrieval
- evaluate it against real usage queries
- treat current canonical memories as the temporary gold set

The goal is not graph visualization first. The goal is to determine whether canonical-graph expansion improves retrieval quality enough to justify later productization.

## Product Decision

GraphRAG v1 is an experiment, not the default search path.

- production search remains `memory.search`
- experimental search is exposed separately as `memory.search_graph`
- comparison is done by replaying real usage queries through both paths
- promotion to the main search path happens only if internal evaluation is clearly better

This keeps Phase 2 stable while allowing GraphRAG experimentation.

## Retrieval Scope

GraphRAG v1 uses a canonical-first graph only.

- seed retrieval starts from canonical memories
- raw memories are not first-class graph seeds
- raw evidence is expanded only through canonical evidence links

Graph edges used in v1:

- `supersedes`
- `contradicts`
- `canonical_evidence`

Explicitly excluded from v1:

- `wikilink`
- `tag`
- session graph
- git/build/test/failure graph
- graph time-travel
- ontology extraction
- PageRank-style broad graph ranking

This keeps graph semantics precise and aligned with the Phase 2 canonical layer.

## Retrieval Flow

The GraphRAG experiment should use the current retrieval stack as stage one, then apply graph-aware expansion and reranking.

### Stage 1: Seed Retrieval

- run the existing vector + FTS + RRF retrieval logic
- restrict the seed set to canonical memories
- use the same scope and `asOf` semantics already defined for canonical search

### Stage 2: Graph Expansion

- expand the top canonical seeds by `1-hop` or `2-hop`
- allow user-controlled hop depth
- follow only `supersedes`, `contradicts`, and `canonical_evidence`

Expansion intent:

- `supersedes` helps prefer current truth over retired truth
- `contradicts` helps identify conflicts and avoid overconfident ranking
- `canonical_evidence` helps recover supporting raw evidence when the canonical node is relevant

### Stage 3: Graph-Aware Rerank

The reranker should remain simple in v1.

Recommended signals:

- seed retrieval score
- current canonical bonus
- superseded canonical penalty
- contradiction penalty or uncertainty reduction
- evidence support bonus

The experiment should not try to learn weights in v1. Start with explicit heuristics and evaluate them.

## API Shape

Introduce a separate MCP tool:

- `memory.search_graph`

Expected inputs:

- `query`
- `scope`
- `limit`
- `asOf`
- `hopDepth` (`1` or `2`)

Expected outputs:

- ranked canonical-only results
- graph payload that can later feed inspector tooling

The output shape should be UI-agnostic so the same payload can power TUI, JSON export, and later web visualization.

### Response Structure

`memory.search_graph` should return two top-level artifacts:

- `results`
- `graph`

The ranked `results` list is canonical-only.

- do not place raw evidence directly in the top-level ranked list
- keep the meaning of the ranked list consistent: these are the canonical truths the system is surfacing
- expose raw evidence only through the graph payload

Each ranked result should include at least:

- canonical identity fields
- ranking score
- `hasConflict: boolean`

`contradicts` should influence both ranking and visibility.

- use contradiction as a rerank penalty or uncertainty signal
- also expose an explicit `hasConflict` flag in each result item
- keep the actual contradiction relationships in the graph payload

### Graph Payload Shape

The graph payload should use a standard graph JSON shape:

- `nodes[]`
- `edges[]`
- `meta`

This structure is preferred over nesting graph data inside individual result items because it is directly reusable for:

- internal evaluation tooling
- TUI inspection
- JSON export
- later Cytoscape.js rendering

Raw evidence should appear only inside this graph payload and only when expanded from canonical nodes.

### Graph Meta

The first version of `meta` should include:

- `seedCount`
- `expandedNodeCount`
- `hopDepth`
- `rerankVersion`

This is enough for v1 debugging and offline evaluation.

## Evaluation Strategy

Evaluation should use real usage data rather than synthetic queries.

### Query Source

- collect recent real usage queries from actual Engram usage logs
- build a replayable local evaluation set from those queries

### Temporary Gold Set

- use canonical memories as the temporary relevance target
- apply current validity rules when judging correctness
- prefer currently valid canonical truth over superseded truth

This means the evaluation is initially biased by canonical coverage, but it is still the best practical starting point because GraphRAG v1 is intentionally canonical-first.

### Metrics

Minimum metrics:

- hit@k
- MRR
- top-1 precision

Secondary metrics for later:

- stale retrieval rate
- contradiction exposure rate
- token efficiency

## Inspector And Visualization

Visualization is not part of the first GraphRAG implementation milestone. It is a later layer on top of the retrieval experiment.

### Initial Inspection Model

- headless graph payload from the backend
- JSON export
- DOT / Mermaid export
- optional TUI inspection first

### Web UI Direction

If the experiment proves useful, add a web inspector later.

Approved direction:

- web visualization comes last
- use `Cytoscape.js`
- default view shows canonical nodes only
- raw evidence expands on node click
- user can switch between `1-hop` and `2-hop`

The initial web inspector should optimize for topology inspection first:

- graph node view is the primary surface
- edge inspection is the second priority
- score explanation remains secondary in the first UI pass

The first web view is a graph explorer, not a graph editor.

Primary focus:

- graph node view
- graph edges

Secondary focus:

- rerank reason
- score explanation
- detailed provenance panels

## Architecture Direction

The GraphRAG experiment should not introduce a separate graph database.

Recommended stack:

- storage: existing SQLite schema
- graph substrate: `canonical_memories`, `canonical_edges`, `canonical_evidence`
- retrieval/rerank logic: TypeScript in-process
- experimental API surface: MCP tool
- visualization later: React + Cytoscape.js

This preserves Engram's current strengths:

- local-first
- inspectable
- low operational complexity
- easy provenance tracing

## Risks

### Semantic Risk

If graph semantics expand too early, retrieval quality will get noisier instead of better.

Mitigation:

- keep v1 edges narrow
- avoid raw `wikilink` and `tag` edges in the first version

### Evaluation Bias

Canonical memories as the gold set can hide recall problems when canonical coverage is incomplete.

Mitigation:

- treat this as internal evaluation only
- revisit with richer feedback data later

### Product Scope Drift

Inspector work can overtake retrieval work.

Mitigation:

- retrieval experiment first
- web UI last
- keep backend graph payload reusable and headless

## Out Of Scope

Not included in GraphRAG v1:

- replacing `memory.search`
- learned reranking
- full mixed raw + canonical graph
- connector-derived graph nodes from Phase 3
- entity extraction / ontology modeling
- graph database migration
- final product web UI

## Recommendation

Proceed with a narrow GraphRAG v1 experiment:

- separate tool
- canonical-first seeds
- three explicit edge types
- heuristic rerank
- real usage query replay
- canonical-based internal evaluation

This is the smallest design that can answer the only question that matters right now:

"Does graph expansion improve retrieval accuracy enough to justify becoming part of Engram's future search stack?"
