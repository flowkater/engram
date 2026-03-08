---
title: Unified Memory MCP Server
tags: [mcp, typescript, ai]
scope: unified-memory
---

# Unified Memory MCP Server

MCP server for persistent memory across AI coding sessions.
Stores embeddings with semantic search capabilities.

Related: [[Embedding Strategy]], [[API Design Guide]]

## Architecture

- SQLite with vec extension for vector search
- FTS5 for full-text search
- Hybrid RRF ranking
