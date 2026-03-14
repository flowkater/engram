import fs from "node:fs";
import path from "node:path";

export interface SearchQueryLogEntry {
  tool: "memory.search" | "memory.search_graph";
  query: string;
  scope?: string;
  asOf?: string;
  timestamp: string;
}

export function resolveSearchQueryLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGRAM_QUERY_LOG_PATH ||
    path.join(env.HOME || "~", ".engram", "logs", "search-queries.jsonl");
}

export function appendSearchQueryLog(logPath: string, entry: SearchQueryLogEntry): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

export function readSearchQueryLog(logPath: string): SearchQueryLogEntry[] {
  if (!fs.existsSync(logPath)) return [];

  return fs.readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SearchQueryLogEntry];
      } catch {
        return [];
      }
    });
}
