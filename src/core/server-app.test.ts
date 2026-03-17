import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { createEngramServer } from "./server-app.js";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `engram-server-app-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const ALL_TOOLS = [
  "memory.add",
  "memory.search",
  "memory.search_graph",
  "memory.context",
  "memory.summary",
  "memory.ingest",
  "memory.prune",
  "memory.stats",
  "memory.graph",
  "memory.health",
  "memory.restore",
  "memory.promote",
];

describe("server app", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("registers the real MCP tool surface", async () => {
    const server = createEngramServer({
      db: inst.db,
      dbPath: tmpDbPath(),
      log: () => {},
      sessionTracker: {
        recordActivity: () => {},
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining(ALL_TOOLS));
    expect(tools).toHaveLength(12);

    await client.close();
    await server.close();
  });
});
