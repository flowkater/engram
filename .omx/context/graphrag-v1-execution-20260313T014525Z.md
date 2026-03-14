# GraphRAG V1 Execution Context

## Task Statement

Execute `docs/superpowers/plans/2026-03-13-graphrag-v1-implementation.md` using a Ralph-style persistent workflow with subagent-driven development and provide a final performance comparison between existing `memory.search` and the new `memory.search_graph`.

## Desired Outcome

- `memory.search_graph` exists as a separate experimental MCP tool
- canonical-first graph retrieval is implemented with `results + graph`
- query logging and offline evaluation harness are implemented
- tests pass
- build passes
- final report includes baseline search versus graph search comparison summary

## Known Facts / Evidence

- Repository is on `master`
- Current working tree is not clean:
  - modified `docs/superpowers/specs/2026-03-13-graphrag-v1-design.md`
  - untracked `docs/superpowers/plans/2026-03-13-graphrag-v1-implementation.md`
- Phase 2 canonical memory layer already exists
- `memory.search` already supports canonical search and `asOf`
- `memory.graph` exists separately for raw `memory_links`
- Plan and spec were both reviewed and approved after revisions

## Constraints

- Use subagent-driven-development because subagents are available
- Do not use git worktrees; stay in the current branch/session
- Use apply_patch for edits
- Do not revert unrelated user changes
- Must run `npm test` before any commit that touches source/test files
- Need a final performance comparison against existing search

## Unknowns / Open Questions

- Whether real query logs already exist locally or need to be generated during execution
- Whether the final comparison will rely on current local log volume or a controlled evaluation dataset built during implementation
- Whether server-level query log wiring can be tested entirely with current MCP test surfaces or needs a dedicated end-to-end process test

## Likely Codebase Touchpoints

- `src/core/search-graph.ts`
- `src/tools/search-graph.ts`
- `src/core/query-log.ts`
- `src/core/search-graph-eval.ts`
- `src/server.ts`
- `src/server.test.ts`
- `src/tools/search-graph.test.ts`
- `src/core/search-graph.test.ts`
- `src/core/query-log.test.ts`
- `src/core/search-graph-eval.test.ts`
- `test/e2e/query-log-wiring.test.ts`
- `scripts/eval-search-graph.ts`
- `README.md`
