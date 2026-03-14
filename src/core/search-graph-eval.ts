import type Database from "better-sqlite3";
import { memorySearch } from "../tools/search.js";
import { runGraphSearch } from "./search-graph.js";
import type { SearchQueryLogEntry } from "./query-log.js";

export interface SearchMetricSummary {
  hitAtK: number;
  mrr: number;
  top1Precision: number;
}

export interface SearchGraphEvalReport {
  queriesConsidered: number;
  queriesEvaluated: number;
  baseline: SearchMetricSummary;
  graph: SearchMetricSummary;
}

const ZERO_METRICS: SearchMetricSummary = {
  hitAtK: 0,
  mrr: 0,
  top1Precision: 0,
};

export async function evaluateSearchGraphQueries(
  db: Database.Database,
  entries: SearchQueryLogEntry[],
  limit = 5
): Promise<SearchGraphEvalReport> {
  let queriesEvaluated = 0;
  const baselineTotals = { ...ZERO_METRICS };
  const graphTotals = { ...ZERO_METRICS };

  for (const entry of entries) {
    const goldIds = await resolveCanonicalGoldIds(db, entry, limit);

    if (goldIds.size === 0) continue;

    queriesEvaluated += 1;

    const baselineResults = await memorySearch(db, {
      query: entry.query,
      scope: entry.scope,
      limit,
      asOf: entry.asOf,
    });
    const graphResults = await runGraphSearch(db, {
      query: entry.query,
      scope: entry.scope,
      limit,
      asOf: entry.asOf,
      hopDepth: 1,
    });

    const baselineIds = baselineResults
      .filter((row) => row.isCanonical === true)
      .map((row) => row.id);
    const graphIds = graphResults.results.map((row) => row.id);

    baselineTotals.hitAtK += computeHitAtK(baselineIds, goldIds);
    baselineTotals.mrr += computeReciprocalRank(baselineIds, goldIds);
    baselineTotals.top1Precision += computeTop1Precision(baselineIds, goldIds);

    graphTotals.hitAtK += computeHitAtK(graphIds, goldIds);
    graphTotals.mrr += computeReciprocalRank(graphIds, goldIds);
    graphTotals.top1Precision += computeTop1Precision(graphIds, goldIds);
  }

  return {
    queriesConsidered: entries.length,
    queriesEvaluated,
    baseline: averageMetrics(baselineTotals, queriesEvaluated),
    graph: averageMetrics(graphTotals, queriesEvaluated),
  };
}

async function resolveCanonicalGoldIds(
  db: Database.Database,
  entry: SearchQueryLogEntry,
  limit: number
): Promise<Set<string>> {
  const canonicalResults = await memorySearch(db, {
    query: entry.query,
    scope: entry.scope,
    limit: Math.max(limit * 5, 20),
    asOf: entry.asOf,
  });

  return new Set(
    canonicalResults
      .filter((row) => row.isCanonical === true)
      .map((row) => row.id)
  );
}

function averageMetrics(
  totals: SearchMetricSummary,
  divisor: number
): SearchMetricSummary {
  if (divisor === 0) return { ...ZERO_METRICS };

  return {
    hitAtK: totals.hitAtK / divisor,
    mrr: totals.mrr / divisor,
    top1Precision: totals.top1Precision / divisor,
  };
}

function computeHitAtK(resultIds: string[], goldIds: Set<string>): number {
  return resultIds.some((id) => goldIds.has(id)) ? 1 : 0;
}

function computeReciprocalRank(resultIds: string[], goldIds: Set<string>): number {
  const index = resultIds.findIndex((id) => goldIds.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

function computeTop1Precision(resultIds: string[], goldIds: Set<string>): number {
  return resultIds.length > 0 && goldIds.has(resultIds[0]) ? 1 : 0;
}
