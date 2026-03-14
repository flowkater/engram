import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendSearchQueryLog,
  readSearchQueryLog,
  resolveSearchQueryLogPath,
} from "./query-log.js";

describe("query log", () => {
  it("appends JSONL entries and reads them back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "um-query-log-"));
    const logPath = path.join(dir, "search-queries.jsonl");

    appendSearchQueryLog(logPath, {
      tool: "memory.search",
      query: "jwt auth",
      scope: "todait-backend",
      timestamp: "2026-03-13T00:00:00.000Z",
    });

    const rows = readSearchQueryLog(logPath);
    expect(rows).toHaveLength(1);
    expect(rows[0].query).toBe("jwt auth");
  });

  it("prefers ENGRAM_QUERY_LOG_PATH when resolving the log file", () => {
    const resolved = resolveSearchQueryLogPath({
      HOME: "/tmp/home",
      ENGRAM_QUERY_LOG_PATH: "/tmp/custom/search.jsonl",
    });

    expect(resolved).toBe("/tmp/custom/search.jsonl");
  });
});
