import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readSearchQueryLog } from "../../src/core/query-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DIST_SERVER = path.resolve(REPO_ROOT, "dist", "server.js");

let built = false;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("query log wiring", () => {
  beforeEach(async () => {
    if (!built) {
      execFileSync("npm", ["run", "build"], {
        cwd: REPO_ROOT,
        stdio: "pipe",
      });
      built = true;
    }
  });

  afterEach(async () => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("logs memory.search and memory.search_graph queries to JSONL", async () => {
    const homeDir = makeTempDir("um-query-home-");
    const dbPath = path.join(homeDir, ".engram", "memory.db");
    const logPath = path.join(homeDir, ".engram", "logs", "search-queries.jsonl");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_SERVER],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        MEMORY_DB: dbPath,
        ENGRAM_QUERY_LOG_PATH: logPath,
        ENGRAM_ENABLE_BACKGROUND_JOBS: "false",
        ENGRAM_MOCK_EMBEDDINGS: "true",
      } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "query-log-test", version: "1.0.0" });

    try {
      await client.connect(transport);

      await client.callTool({
        name: "memory.search",
        arguments: { query: "jwt auth", limit: 3 },
      });
      await client.callTool({
        name: "memory.search_graph",
        arguments: { query: "jwt auth", limit: 3, hopDepth: 1 },
      });

      const rows = readSearchQueryLog(logPath);
      expect(rows.map((row) => row.tool)).toEqual([
        "memory.search",
        "memory.search_graph",
      ]);
      expect(rows.every((row) => row.query === "jwt auth")).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 20000);
});
