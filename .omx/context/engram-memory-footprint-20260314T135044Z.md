# Task: Reduce Engram runtime footprint for Codex and lower startup overhead

## Desired Outcome

- Codex-launched Engram instances should avoid unnecessary background jobs.
- Engram startup should do less eager work before serving MCP requests.
- Changes should be covered by tests and verified with fresh build/test evidence.

## Known Facts / Evidence

- Direct stdio MCP initialize on the real DB connects in about 1.1s and `listTools` returns 12 tools.
- The shell command `node dist/server.js` appears silent because Engram is a stdio MCP server waiting for JSON-RPC input.
- Current DB footprint is large: `~/.engram/memory.db` about 5.1 GB and WAL about 331 MB.
- Live process checks showed multiple Engram processes; per-process RSS was typically tens of MB, with cumulative usage growing when several sessions were alive.
- Startup currently performs eager database initialization and startup checks before serving requests.

## Constraints

- Follow repo AGENTS rules, including ESM `.js` imports.
- Do not disturb unrelated dirty worktree changes on `master`.
- Use TDD for behavior changes.
- Verify with fresh tests/build before claiming completion.

## Unknowns / Open Questions

- Which startup operations are the best candidates to defer without changing behavior?
- What minimal test coverage best proves the lighter startup path?

## Likely Code Touchpoints

- `src/server.ts`
- `src/core/database.ts`
- `src/core/database.test.ts`
- `README.md`
- `~/.codex/config.toml`
