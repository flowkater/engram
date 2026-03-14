#!/usr/bin/env node
import { openDatabase } from "../src/core/database.js";
import { readSearchQueryLog, resolveSearchQueryLogPath } from "../src/core/query-log.js";
import { evaluateSearchGraphQueries } from "../src/core/search-graph-eval.js";

async function main() {
  const dbPath = process.env.MEMORY_DB;
  if (!dbPath) {
    throw new Error("MEMORY_DB is required");
  }

  const { db, close } = openDatabase(dbPath);
  try {
    const entries = readSearchQueryLog(resolveSearchQueryLogPath());
    const report = await evaluateSearchGraphQueries(db, entries);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
