# Codex CLI MCP Configuration

## Setup

Add the following to `~/.codex/config.toml`:

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

Restart Codex after editing `config.toml`. MCP servers are loaded when the session starts.

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
