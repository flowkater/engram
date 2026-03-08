# Unified Memory MCP Server

Local AI agent memory server using MCP (Model Context Protocol). Provides semantic + keyword hybrid search across Obsidian vault, MEMORY.md files, and agent sessions.

**100% local, $0, privacy-first** — runs on Ollama + SQLite.

## Features

- **10 MCP Tools**: add, search, context, summary, ingest, prune, stats, graph, health, restore
- **Hybrid Search**: Vector similarity (sqlite-vec) + FTS5 keyword + RRF merge + adaptive fetch
- **Obsidian Integration**: Auto-indexes vault, watches for changes, diff scan on restart
- **Multi-Agent**: Codex CLI, Claude Code, OpenClaw share one memory store
- **Graph Layer**: Normalized tag table + wikilink relationships with UNION dedup
- **Scope Isolation**: Config-based project scoping (external `config.json`)
- **Integrity**: Health checks, transactional writes, soft-delete with sync cleanup
- **108 Tests**: Unit + E2E with fixture vault

## Quick Start (로컬 테스트)

```bash
# 1. Ollama 설치 & 임베딩 모델 다운로드
brew install ollama        # macOS
ollama serve &             # 백그라운드 실행
ollama pull nomic-embed-text

# 2. 프로젝트 빌드
cd ~/.unified-memory
npm install
npm run build

# 3. 테스트 실행 (Ollama 없이도 동작 — mock embedder)
npm test                   # 81 tests expected

# 4. Obsidian vault 인덱싱
node dist/cli.js index ~/Obsidian/flowkater/flowkater --source obsidian

# 5. MCP 서버 직접 실행 (stdio)
node dist/server.js        # Ctrl+C로 종료

# 6. 통계 확인
node dist/cli.js stats
```

## Prerequisites

- **Node.js 22+**
- **Ollama** running locally (`ollama serve`)
- **nomic-embed-text** model (`ollama pull nomic-embed-text`)

## Installation

```bash
cd ~/.unified-memory
npm install
npm run build
```

## MCP Configuration

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "unified-memory": {
      "command": "node",
      "args": ["/Users/flowkater/.unified-memory/dist/server.js"],
      "env": {
        "MEMORY_DB": "/Users/flowkater/.unified-memory/memory.db",
        "VAULT_PATH": "/Users/flowkater/Obsidian/flowkater/flowkater"
      }
    }
  }
}
```

### Codex CLI (`~/.codex/config.json`)

Same format under `mcpServers` key.

See `docs/` for detailed configuration guides.

## CLI

```bash
# Index Obsidian vault
unified-memory index ~/Obsidian/flowkater/flowkater --source obsidian

# View stats
unified-memory stats

# Preview prune candidates
unified-memory prune --days 90

# Actually prune
unified-memory prune --days 180 --execute
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory.add` | Save a new memory with embedding |
| `memory.search` | Semantic + keyword hybrid search (adaptive fetch) |
| `memory.context` | Auto-load context by cwd scope (weighted scoring) |
| `memory.summary` | Save session summary for continuity |
| `memory.ingest` | Index files/directories into memory |
| `memory.prune` | Clean old/unused memories (dry-run default) |
| `memory.stats` | View store statistics |
| `memory.graph` | Explore memory connections (UNION dedup, 1-3 hops) |
| `memory.health` | Check DB integrity (orphans, model mismatch) |
| `memory.restore` | Restore soft-deleted memory with re-embedding |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_DB` | `~/.unified-memory/memory.db` | Database path |
| `VAULT_PATH` | `~/Obsidian/flowkater/flowkater` | Obsidian vault path |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API URL |
| `OLLAMA_MODEL` | `nomic-embed-text` | Embedding model |
| `OPENAI_API_KEY` | — | Fallback embedding (optional) |

## Development

```bash
npm run dev          # Run server in dev mode
npm test             # Run all tests (108)
npm run test:watch   # Watch mode
npm run build        # Build for production
```

## Architecture

```
Codex CLI ──┐
Claude Code ─┤──> Unified Memory MCP Server <── Obsidian vault
OpenClaw ────┘    (SQLite + sqlite-vec + FTS5)  <── MEMORY.md
```

- **Embedder**: Ollama nomic-embed-text (768-dim, local)
- **Storage**: SQLite + WAL + sqlite-vec + FTS5
- **Search**: Vector cosine similarity + BM25 + Reciprocal Rank Fusion
- **Watcher**: chokidar v4 with 2s debounce
- **Scheduler**: node-cron (6h reindex, weekly prune)
