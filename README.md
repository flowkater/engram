# Engram MCP Server

Local AI agent memory server using MCP (Model Context Protocol). Provides semantic + keyword hybrid search across Obsidian vault, MEMORY.md files, and agent sessions.

**100% local, $0, privacy-first** — runs on Ollama + SQLite.

## Features

- **12 MCP Tools**: add, search, search_graph, context, summary, ingest, prune, stats, graph, health, restore, promote
- **Hybrid Search**: Vector similarity (sqlite-vec) + FTS5 keyword + RRF merge + adaptive fetch
- **Obsidian Integration**: Auto-indexes vault, watches for changes, diff scan on restart
- **Multi-Agent**: Codex CLI, Claude Code, OpenClaw share one memory store
- **Graph Layer**: Normalized tag table + wikilink relationships with UNION dedup
- **Scope Isolation**: Config-based project scoping (external `config.json`)
- **Integrity**: Health checks, transactional writes, soft-delete with sync cleanup
- **147 Tests**: Unit + E2E with fixture vault

## Quick Start (로컬 테스트)

```bash~
# 1. Ollama 설치 & 임베딩 모델 다운로드
brew install ollama        # macOS
ollama serve &             # 백그라운드 실행
ollama pull nomic-embed-text

# 2. 프로젝트 빌드
cd ~/.engram
npm install
npm run build

# 3. 테스트 실행 (Ollama 없이도 동작 — mock embedder)
npm test                   # 147 tests expected

# 4. Obsidian vault 인덱싱
node dist/cli.js index ~/Obsidian/flowkater/flowkater --source obsidian

# 5. MCP 서버 직접 실행 (stdio)
node dist/server.js        # Ctrl+C로 종료

# 6. 통계 확인
node dist/cli.js stats
```

`node dist/server.js`를 터미널에서 직접 실행하면 보통 프롬프트가 돌아오지 않습니다. 이 서버는 stdio MCP 서버라서, MCP 클라이언트가 JSON-RPC 요청을 보내기 전까지 조용히 대기하는 것이 정상입니다.

## Prerequisites

- **Node.js 22+**
- **Ollama** running locally (`ollama serve`)
- **nomic-embed-text** model (`ollama pull nomic-embed-text`)

## Installation

```bash
cd ~/.engram
npm install
npm run build
```

## MCP Configuration

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "engram": {
      "command": "node",
      "args": ["/Users/flowkater/.engram/dist/server.js"],
      "env": {
        "MEMORY_DB": "/Users/flowkater/.engram/memory.db",
        "VAULT_PATH": "/Users/flowkater/Obsidian/flowkater/flowkater"
      }
    }
  }
}
```

### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.engram]
command = "/Users/flowkater/.volta/bin/node"
args = ["/Users/flowkater/workspace/side/engram/dist/server.js"]
enabled = true
startup_timeout_sec = 30

[mcp_servers.engram.env]
MEMORY_DB = "/Users/flowkater/.engram/memory.db"
VAULT_PATH = "/Users/flowkater/Obsidian/flowkater"
```

`node`는 절대 경로로 두는 편이 안전합니다. GUI/비로그인 셸 환경에서는 PATH가 달라져 bare `node`가 실패할 수 있습니다.

Codex는 MCP 설정을 세션 시작 시 읽으므로, `config.toml` 수정 후에는 Codex 세션을 다시 시작해야 합니다.

See `docs/` for detailed configuration guides.

## CLI

```bash
# Index Obsidian vault
engram index ~/Obsidian/flowkater/flowkater --source obsidian

# View stats
engram stats

# Preview prune candidates
engram prune --days 90

# Actually prune
engram prune --days 180 --execute
```

## MCP Tools

| Tool             | Description                                        |
| ---------------- | -------------------------------------------------- |
| `memory.add`     | Save a new memory with embedding                   |
| `memory.search`  | Semantic + keyword hybrid search (adaptive fetch)  |
| `memory.search_graph` | Experimental canonical-first graph-assisted search |
| `memory.context` | Auto-load context by cwd scope (weighted scoring)  |
| `memory.summary` | Save session summary for continuity                |
| `memory.ingest`  | Index files/directories into memory                |
| `memory.prune`   | Clean old/unused memories (dry-run default)        |
| `memory.stats`   | View store statistics                              |
| `memory.graph`   | Explore memory connections (UNION dedup, 1-3 hops) |
| `memory.health`  | Check DB integrity (orphans, model mismatch)       |
| `memory.restore` | Restore soft-deleted memory with re-embedding      |
| `memory.promote` | Promote raw memories into canonical facts/decisions |

## Scope Configuration

Scope detection is configured via `~/.engram/config.json`. Without this file, all memories default to `"global"` scope.

```bash
# Copy the example and customize
cp config.example.json ~/.engram/config.json
```

See `config.example.json` for the full format with `scopeMap` (cwd → scope) and `obsidianScopeMap` (Obsidian path prefix → scope).

> **Migration warning**: If you re-index without a `config.json`, all new memories will get `"global"` scope, causing mismatch with previously scoped data. Create `~/.engram/config.json` before re-indexing.

## minScore Guide

The `minScore` parameter in `memory.search` uses a **0~1 normalized scale** where 1.0 = best match in the result set.

- Scores are normalized per-query: the top result always gets 1.0
- A single result always scores 1.0 (no quality comparison possible)
- If all results have identical RRF scores, they all get 1.0 (no differentiation possible)
- Recommended: `minScore: 0.3` for loose filtering, `minScore: 0.7` for strict

## Canonical Memory

Phase 2 adds a separate canonical-memory layer on top of raw `memories`.

- `memory.add` still stores raw evidence only
- `memory.promote` creates canonical `fact` or `decision` memories from raw evidence
- `memory.search` accepts optional `asOf` for time-aware canonical retrieval
- canonical memories protect their linked raw evidence from automated prune

## Experimental Graph Search

- `memory.search_graph` is an internal experiment and does not replace `memory.search`
- search queries are logged to `~/.engram/logs/search-queries.jsonl` for offline evaluation
- `ENGRAM_QUERY_LOG_PATH` overrides the default query-log file for isolated dev/test runs
- offline evaluation uses canonical-derived temporary gold targets, not human labels
- run `MEMORY_DB=/path/to/memory.db npx tsx scripts/eval-search-graph.ts` to compare baseline search and GraphRAG

## Background Workers

Only one Engram process should run startup `diffScan`, watcher, and scheduler work for a shared DB/vault.

- Engram now takes a DB lease so only one process owns background jobs at a time
- Other concurrent MCP processes stay usable for read/write tools, but skip startup indexing work until they win the lease
- If the current leader dies, a follower retries and takes over automatically after lease expiry
- You can force-disable all startup background work with `ENGRAM_ENABLE_BACKGROUND_JOBS=false`

## Environment Variables

| Variable              | Default                      | Description                                 |
| --------------------- | ---------------------------- | ------------------------------------------- |
| `MEMORY_DB`           | `~/.engram/memory.db`        | Database path                               |
| `VAULT_PATH`          | `~/Obsidian/flowkater/flowkater` | Obsidian vault path                     |
| `OLLAMA_BASE_URL`     | `http://localhost:11434`     | Ollama API URL                              |
| `OLLAMA_MODEL`        | `nomic-embed-text`           | Embedding model                             |
| `OPENAI_API_KEY`      | —                            | Fallback embedding (explicit opt-in only)   |
| `ENGRAM_STRICT_LOCAL` | `true`                       | Block OpenAI fallback; set `false` to allow |
| `ENGRAM_ENABLE_BACKGROUND_JOBS` | `true`            | Enable startup diff scan, watcher, scheduler |
| `ENGRAM_ENABLE_DIFF_SCAN` | `true`                   | Per-job override for startup diff scan      |
| `ENGRAM_ENABLE_WATCHER` | `true`                    | Per-job override for watcher                |
| `ENGRAM_ENABLE_SCHEDULER` | `true`                  | Per-job override for scheduler              |
| `ENGRAM_QUERY_LOG_PATH` | `~/.engram/logs/search-queries.jsonl` | Override search-query log path          |
| `ENGRAM_BACKGROUND_LEASE_TTL_MS` | `60000`         | Background worker lease TTL; mainly for tests |
| `ENGRAM_BACKGROUND_RENEW_MS` | `20000`            | Background worker renew cadence; mainly for tests |
| `ENGRAM_BACKGROUND_RETRY_MS` | `5000`             | Follower retry cadence for background takeover |

## Development

```bash
npm run dev          # Run server in dev mode
npm test             # Run all tests (147)
npm run test:watch   # Watch mode
npm run build        # Build for production
```

## Architecture

```
Codex CLI ──┐
Claude Code ─┤──> Engram MCP Server <── Obsidian vault
OpenClaw ────┘    (SQLite + sqlite-vec + FTS5)  <── MEMORY.md
```

- **Embedder**: Ollama nomic-embed-text (768-dim, local)
- **Storage**: SQLite + WAL + sqlite-vec + FTS5
- **Search**: Vector cosine similarity + BM25 + Reciprocal Rank Fusion
- **Watcher**: chokidar v4 with 2s debounce
- **Scheduler**: node-cron (6h reindex, weekly prune)
