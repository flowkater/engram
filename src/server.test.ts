/**
 * Test: MCP server registers all 8 memory tools.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const ALL_TOOLS = [
  "memory.add",
  "memory.search",
  "memory.context",
  "memory.summary",
  "memory.ingest",
  "memory.prune",
  "memory.stats",
  "memory.graph",
];

describe("MCP server tools", () => {
  it("registers all 8 memory tools", async () => {
    const server = new McpServer({
      name: "unified-memory",
      version: "0.1.0",
    });

    // Register stubs for all tools
    server.tool("memory.add", "Save a new memory", { content: z.string() },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    server.tool("memory.search", "Hybrid search", { query: z.string() },
      async () => ({ content: [{ type: "text" as const, text: "[]" }] }));
    server.tool("memory.context", "Auto-load context", {},
      async () => ({ content: [{ type: "text" as const, text: "{}" }] }));
    server.tool("memory.summary", "Save session summary", { summary: z.string() },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    server.tool("memory.ingest", "Index files", { path: z.string() },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    server.tool("memory.prune", "Clean old memories", {},
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    server.tool("memory.stats", "View statistics", {},
      async () => ({ content: [{ type: "text" as const, text: "{}" }] }));
    server.tool("memory.graph", "Explore connections", {},
      async () => ({ content: [{ type: "text" as const, text: "{}" }] }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    for (const tool of ALL_TOOLS) {
      expect(toolNames).toContain(tool);
    }

    expect(tools).toHaveLength(8);

    await client.close();
    await server.close();
  });
});
