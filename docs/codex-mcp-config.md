# Codex CLI MCP Configuration

## Setup

Add the following to `~/.codex/config.json`:

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

## AGENTS.md Integration

Add to your project's `AGENTS.md`:

```markdown
## Memory Context

At the start of each session, call `memory.context` to load relevant memories.
At the end of each session, call `memory.summary` to save a session summary.

Available memory tools:
- `memory.search` — Semantic + keyword search
- `memory.context` — Auto-load context by cwd
- `memory.add` — Save new memory
- `memory.summary` — Save session summary
- `memory.ingest` — Index files/directories
- `memory.prune` — Clean old memories
- `memory.stats` — View statistics
- `memory.graph` — Explore memory connections
```

## Verification

After setup, run Codex CLI and verify:

```bash
codex --model o4-mini
# Then ask: "List available MCP tools"
# Should show memory.* tools
```
