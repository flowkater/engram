Task statement
- Improve `search_graph` quality for Project-folder canonicals by doing all of:
- add meaningful `supersedes` / `contradicts` edges
- create merge/update clusters for existing promoted canonicals
- patch `search_graph` seed retrieval so it is not just a repackaged `memory.search`

Desired outcome
- `search_graph` should produce measurably different and better canonical-first results for `project/*` scopes.
- Project canonicals should gain graph structure, not just isolated promoted rows.
- The work should include code, data backfill/enrichment, verification, and review.

Known facts / evidence
- `project/*` canonicals currently total 108 in `canonical_memories`.
- `canonical_edges` is currently 0.
- `canonical_candidates` currently has only 1 queued item.
- Current `search_graph` seeds come from `memory.search`, so quality is often nearly identical.
- Project-wide seed promotion already added canonical rows for `project/todait`, `project/todait-ios`, `project/todait-backend-v2`, `project/scrumble-backend`, `project/reading-provocateur`, `project/ax-studio`, `project/engram`, `project/openclaw`, and `project/side-project`.

Constraints
- Work directly on `master`.
- Follow `AGENTS.md` rules.
- For any `src/**` or `test/**` edits, run full `npm test` before any commit.
- Use `apply_patch` for file edits.
- Avoid reverting unrelated existing changes.
- Ollama currently exposes `nomic-embed-text:latest`; no generation model is available by default.

Unknowns / open questions
- Best heuristic for auto-linking `supersedes` / `contradicts` among existing project canonicals.
- Best cluster strategy for merging near-duplicate promoted canonicals without damaging scope semantics.
- Best seed retrieval path for `search_graph` that materially differs from `memory.search` while staying performant.

Likely codebase touchpoints
- `src/core/search-graph.ts`
- `src/core/canonical-memory.ts`
- `src/tools/promote.ts`
- `src/core/search-graph.test.ts`
- `src/tools/search-graph.test.ts`
- `src/core/canonical-memory.test.ts`
- `scripts/promote-project-seeds.ts`
- new scripts for project graph enrichment / merge backfill
