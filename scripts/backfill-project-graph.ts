import type Database from "better-sqlite3";
import { openDatabase } from "../src/core/database.ts";
import { addCanonicalEdge, mergeCanonicalMemories } from "../src/core/canonical-memory.ts";

type RelationType = "supersedes" | "contradicts";

interface CanonicalRow {
  id: string;
  scope: string;
  kind: "fact" | "decision";
  title: string;
  content: string;
  confidence: number;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  evidence_count: number;
}

interface ScriptOptions {
  dryRun: boolean;
  dbPath: string;
  scope?: string;
}

const STATUS_CURRENT = ["current", "new", "latest"];
const STATUS_OLD = ["old", "legacy", "deprecated"];

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    dryRun: false,
    dbPath: process.env.MEMORY_DB || "/Users/flowkater/.engram/memory.db",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--scope" && next) {
      options.scope = next;
      i += 1;
      continue;
    }
    if (arg === "--db" && next) {
      options.dbPath = next;
      i += 1;
    }
  }
  return options;
}

function fetchProjectCanonicals(db: Database.Database, scope?: string): CanonicalRow[] {
  const where = scope ? "WHERE c.scope = ?" : "WHERE c.scope LIKE 'project/%'";
  const params = scope ? [scope] : [];
  return db.prepare(`
    SELECT c.id,
           c.scope,
           c.kind,
           c.title,
           c.content,
           c.confidence,
           c.decided_at,
           c.created_at,
           c.updated_at,
           COUNT(e.memory_id) AS evidence_count
    FROM canonical_memories c
    LEFT JOIN canonical_evidence e ON e.canonical_id = c.id
    ${where}
    GROUP BY c.id
    ORDER BY c.scope, c.title, c.created_at
  `).all(...params) as CanonicalRow[];
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/\*+/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1);
}

function normalizeTitleKey(scope: string, title: string): string {
  const projectToken = scope.replace(/^project\//, "").replace(/-/g, " ");
  return title
    .toLowerCase()
    .replace(new RegExp(projectToken, "g"), " ")
    .replace(/\*+/g, " ")
    .replace(/\bv\d+(?:\.\d+)?\b/g, " ")
    .replace(/\bphase\s+\d+\b/g, " ")
    .replace(/\bappendix\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function compareCanonicals(a: CanonicalRow, b: CanonicalRow): number {
  if (b.evidence_count !== a.evidence_count) return b.evidence_count - a.evidence_count;
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  const aDate = a.decided_at ?? a.updated_at ?? a.created_at;
  const bDate = b.decided_at ?? b.updated_at ?? b.created_at;
  return bDate.localeCompare(aDate);
}

function parseVersionWeight(title: string, row: CanonicalRow): number {
  const versionMatches = [...title.matchAll(/\bv(\d+(?:\.\d+)?)\b/gi)];
  if (versionMatches.length > 0) {
    return Number(versionMatches[versionMatches.length - 1][1]);
  }

  const phaseMatch = title.match(/\bphase\s+(\d+)\b/i);
  if (phaseMatch) {
    return Number(phaseMatch[1]);
  }

  if (/\bappendix\b/i.test(title)) {
    return 0.1;
  }

  const dateValue = row.decided_at ?? row.updated_at ?? row.created_at;
  return Date.parse(dateValue) / 1_000_000_000_000;
}

function groupByScope(rows: CanonicalRow[]): Map<string, CanonicalRow[]> {
  const grouped = new Map<string, CanonicalRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.scope);
    if (existing) existing.push(row);
    else grouped.set(row.scope, [row]);
  }
  return grouped;
}

function hasStatusToken(title: string, tokens: string[]): boolean {
  const lower = title.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

function edgeExists(
  db: Database.Database,
  fromId: string,
  toId: string,
  relationType: RelationType
): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM canonical_edges
    WHERE from_canonical_id = ? AND to_canonical_id = ? AND relation_type = ?
    LIMIT 1
  `).get(fromId, toId, relationType);
  return Boolean(row);
}

function hasSearchArtifacts(db: Database.Database, canonicalId: string): boolean {
  const vecRow = db.prepare("SELECT 1 FROM canonical_memory_vec WHERE id = ? LIMIT 1").get(canonicalId);
  const ftsRow = db.prepare("SELECT 1 FROM canonical_memory_fts WHERE id = ? LIMIT 1").get(canonicalId);
  return Boolean(vecRow) || Boolean(ftsRow);
}

function mergeDuplicates(
  db: Database.Database,
  rows: CanonicalRow[],
  options: ScriptOptions
): { merged: number; logs: string[] } {
  const grouped = new Map<string, CanonicalRow[]>();
  for (const row of rows) {
    const key = `${row.scope}::${row.kind}::${normalizeTitleKey(row.scope, row.title)}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }

  let merged = 0;
  const logs: string[] = [];

  for (const bucket of grouped.values()) {
    if (bucket.length < 2) continue;

      const exactDuplicates = bucket.filter((candidate) =>
        bucket.some((other) =>
          candidate.id !== other.id &&
          candidate.kind === other.kind &&
          candidate.title === other.title &&
          jaccardSimilarity(candidate.content, other.content) >= 0.6
        )
      );

    if (exactDuplicates.length < 2) continue;
    const sorted = [...exactDuplicates].sort(compareCanonicals);
    const primary = sorted[0];

    for (const duplicate of sorted.slice(1)) {
      if (
        edgeExists(db, primary.id, duplicate.id, "supersedes") ||
        !hasSearchArtifacts(db, duplicate.id)
      ) {
        continue;
      }
      logs.push(`merge ${duplicate.scope} :: ${duplicate.title} :: ${duplicate.id} -> ${primary.id}`);
      if (!options.dryRun) {
        db.transaction(() => {
          mergeCanonicalMemories(db, {
            sourceCanonicalId: duplicate.id,
            targetCanonicalId: primary.id,
          });
        })();
      }
      merged += 1;
    }
  }

  return { merged, logs };
}

function backfillEdges(
  db: Database.Database,
  rows: CanonicalRow[],
  options: ScriptOptions
): { supersedes: number; contradicts: number; logs: string[] } {
  const grouped = groupByScope(rows);
  let supersedes = 0;
  let contradicts = 0;
  const logs: string[] = [];

  for (const scopeRows of grouped.values()) {
    const byTopic = new Map<string, CanonicalRow[]>();
    for (const row of scopeRows) {
      const key = `${row.kind}::${normalizeTitleKey(row.scope, row.title)}`;
      const bucket = byTopic.get(key);
      if (bucket) bucket.push(row);
      else byTopic.set(key, [row]);
    }

    for (const bucket of byTopic.values()) {
      if (bucket.length < 2) continue;

      const versioned = bucket.filter((row) =>
        /\bv\d+(?:\.\d+)?\b/i.test(row.title) ||
        /\bphase\s+\d+\b/i.test(row.title) ||
        row.decided_at !== null
      );
      if (versioned.length >= 2) {
        const sorted = [...versioned].sort((a, b) => {
          const versionDiff = parseVersionWeight(b.title, b) - parseVersionWeight(a.title, a);
          if (versionDiff !== 0) return versionDiff;
          return compareCanonicals(a, b);
        });

        for (let i = 0; i < sorted.length - 1; i += 1) {
          const newer = sorted[i];
          const older = sorted[i + 1];
          if (newer.id === older.id || newer.title === older.title) continue;
          if (!edgeExists(db, newer.id, older.id, "supersedes")) {
            logs.push(`supersedes ${newer.scope} :: ${newer.title} -> ${older.title}`);
            if (!options.dryRun) {
              db.transaction(() => {
                addCanonicalEdge(db, {
                  fromId: newer.id,
                  toId: older.id,
                  relationType: "supersedes",
                });
              })();
            }
            supersedes += 1;
          }
        }
      }

      const currentRows = bucket.filter((row) => hasStatusToken(row.title, STATUS_CURRENT));
      const oldRows = bucket.filter((row) => hasStatusToken(row.title, STATUS_OLD));
      for (const current of currentRows) {
        for (const old of oldRows) {
          if (current.id === old.id) continue;
          if (!edgeExists(db, current.id, old.id, "supersedes")) {
            logs.push(`supersedes ${current.scope} :: ${current.title} -> ${old.title}`);
            if (!options.dryRun) {
              addCanonicalEdge(db, {
                fromId: current.id,
                toId: old.id,
                relationType: "supersedes",
              });
            }
            supersedes += 1;
          }
          if (!edgeExists(db, current.id, old.id, "contradicts")) {
            logs.push(`contradicts ${current.scope} :: ${current.title} -> ${old.title}`);
            if (!options.dryRun) {
              addCanonicalEdge(db, {
                fromId: current.id,
                toId: old.id,
                relationType: "contradicts",
              });
            }
            contradicts += 1;
          }
        }
      }
    }
  }

  return { supersedes, contradicts, logs };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { db, close } = openDatabase(options.dbPath, { runMaintenance: false });

  try {
    const beforeRows = fetchProjectCanonicals(db, options.scope);
    const mergedResult = mergeDuplicates(db, beforeRows, options);
    const afterMergeRows = fetchProjectCanonicals(db, options.scope);
    const edgeResult = backfillEdges(db, afterMergeRows, options);

    for (const log of [...mergedResult.logs, ...edgeResult.logs]) {
      console.log(options.dryRun ? `DRYRUN ${log}` : log);
    }

    console.log(JSON.stringify({
      dryRun: options.dryRun,
      dbPath: options.dbPath,
      scope: options.scope ?? "project/*",
      mergedCanonicals: mergedResult.merged,
      supersedesAdded: edgeResult.supersedes,
      contradictsAdded: edgeResult.contradicts,
    }, null, 2));
  } finally {
    close();
  }
}

await main();
