import type Database from "better-sqlite3";
import { runGraphSearch, type SearchGraphParams, type SearchGraphResponse } from "../core/search-graph.js";

export async function memorySearchGraph(
  db: Database.Database,
  params: SearchGraphParams
): Promise<SearchGraphResponse> {
  return runGraphSearch(db, params);
}
