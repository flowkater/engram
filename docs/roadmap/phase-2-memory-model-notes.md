# Phase 2 Memory Model Notes

## Canonical Contract

- raw `memories` are evidence records with mutable lifecycle metadata such as `access_count`, `deleted`, and `updated_at`
- canonical truth lives only in `canonical_memories`
- Phase 2 v1 supports only canonical `fact` and `decision`
- canonical truth is created manually through `memory.promote`
- `memory.add` remains raw-evidence-only in Phase 2 v1
- `supersedes` closes predecessor validity
- `contradicts` records conflict and does not auto-retire the target
- time-aware retrieval starts with `memory.search.asOf` only
- graph time-travel and auto-promotion are explicitly deferred

## Non-Goals

- No auto-promotion
- No graph time-travel
- No new typed memory categories beyond `fact` and `decision`
- No connector ingestion in this phase

## Naming

- `canonical_memories`
- `canonical_evidence`
- `canonical_edges`
- `canonical_memory_vec`
- `canonical_memory_fts`
