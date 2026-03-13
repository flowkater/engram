# Claude Code MCP Configuration

## Setup

Create or add to `.mcp.json` in your home directory or project root:

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

## CLAUDE.md Integration

Add to your project's `CLAUDE.md`:

```markdown
## Memory

Use the unified-memory MCP server for persistent context:
- Start of session: call `memory.context` to load relevant memories
- End of session: call `memory.summary` to save what was done
- When learning something important: call `memory.add`
- When searching for context: call `memory.search`
```

## Available Tools

| Tool | Description |
|------|-------------|
| `memory.search` | Semantic + keyword hybrid search |
| `memory.context` | Auto-load context based on cwd |
| `memory.add` | Save a new memory |
| `memory.summary` | Save session summary |
| `memory.ingest` | Index files/directories |
| `memory.prune` | Clean old memories (dry-run by default) |
| `memory.stats` | View memory store statistics |
| `memory.graph` | Explore memory graph connections |

## Verification

In Claude Code, run:
```
/mcp
```
Should show `unified-memory` server with all tools listed.
