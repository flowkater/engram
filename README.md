# Unified Memory MCP Server

Local AI agent memory server using MCP (Model Context Protocol). Provides semantic + keyword hybrid search across Obsidian vault, MEMORY.md files, and agent sessions.

**100% local, $0, privacy-first** — runs on Ollama + SQLite.

## Features

- **8 MCP Tools**: add, search, context, summary, ingest, prune, stats, graph
- **Hybrid Search**: Vector similarity (sqlite-vec) + FTS5 keyword + RRF merge
- **Obsidian Integration**: Auto-indexes vault, watches for changes via chokidar
- **Multi-Agent**: Codex CLI, Claude Code, OpenClaw share one memory store
- **Graph Layer**: Wikilink/tag/scope-based relationships with 1-3 hop traversal
- **Scope Isolation**: Project-scoped memories (todait-backend, blog, etc.)

## Prerequisites

```bash
# Ollama with nomic-embed-text model
ollama pull nomic-embed-text
```

- Node.js 22+
- Ollama running locally

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
| `memory.search` | Semantic + keyword hybrid search |
| `memory.context` | Auto-load context by cwd scope detection |
| `memory.summary` | Save session summary for continuity |
| `memory.ingest` | Index files/directories into memory |
| `memory.prune` | Clean old/unused memories (dry-run default) |
| `memory.stats` | View store statistics |
| `memory.graph` | Explore memory connections (1-3 hops) |

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
npm test             # Run all tests
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
