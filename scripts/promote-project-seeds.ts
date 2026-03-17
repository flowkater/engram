import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/core/database.ts";
import { memoryPromote } from "../src/tools/promote.ts";
import { requestOllamaGenerate } from "../src/core/ollama-client.ts";

type Tier = "a" | "b" | "all";
type CanonicalKind = "fact" | "decision";

interface ScriptOptions {
  root: string;
  tier: Tier;
  limit?: number;
  project?: string;
  dryRun: boolean;
  model?: string;
}

interface CandidateFile {
  sourcePath: string;
  topProject: string;
  scope: string;
  tier: "a" | "b";
}

interface ChunkRow {
  id: string;
  chunk_index: number;
  content: string;
}

interface NearbyCanonicalRow {
  id: string;
  kind: CanonicalKind;
  title: string;
  content: string;
  confidence: number;
}

interface ModelPayload {
  include: boolean;
  kind?: CanonicalKind;
  title?: string;
  content?: string;
  confidence?: number;
  importance?: number;
  decidedAt?: string | null;
  rationale?: string;
}

interface ParsedFrontmatter {
  title?: string;
}

const TIER_A_PATTERNS = [
  "확정",
  "요구사항",
  "prd",
  "로드맵",
  "roadmap",
  "기획서",
  "requirements",
];
const TIER_B_PATTERNS = ["spec"];
const DEFAULT_ROOT = "/Users/flowkater/Obsidian/flowkater/Project";
const GENERIC_TITLE_PATTERNS = ["requirements", "spec", "roadmap", "prd", "api", "plan"];

function parseArgs(argv: string[]): ScriptOptions {
  const opts: ScriptOptions = {
    root: DEFAULT_ROOT,
    tier: "a",
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--root" && next) {
      opts.root = next;
      i += 1;
      continue;
    }
    if (arg === "--tier" && next && (next === "a" || next === "b" || next === "all")) {
      opts.tier = next;
      i += 1;
      continue;
    }
    if (arg === "--limit" && next) {
      opts.limit = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--project" && next) {
      opts.project = next;
      i += 1;
      continue;
    }
    if (arg === "--model" && next) {
      opts.model = next;
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      opts.dryRun = true;
    }
  }

  return opts;
}

function slugifyProjectName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function classifyFile(fileName: string): "a" | "b" | null {
  const lower = fileName.toLowerCase();
  if (TIER_A_PATTERNS.some((pattern) => lower.includes(pattern))) return "a";
  if (TIER_B_PATTERNS.some((pattern) => lower.includes(pattern))) return "b";
  return null;
}

function scanCandidateFiles(root: string, options: ScriptOptions): CandidateFile[] {
  const queue = [root];
  const files: CandidateFile[] = [];

  while (queue.length > 0) {
    const current = queue.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const tier = classifyFile(entry.name);
      if (!tier) continue;
      if (options.tier !== "all" && tier !== options.tier) continue;

      const relativePath = path.relative(root, fullPath);
      const topProject = relativePath.split(path.sep, 1)[0];
      if (options.project && topProject !== options.project) continue;

      files.push({
        sourcePath: fullPath,
        topProject,
        scope: `project/${slugifyProjectName(topProject)}`,
        tier,
      });
    }
  }

  return files.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function getUniqueChunksForFile(db: Database.Database, sourcePath: string): ChunkRow[] {
  return db.prepare(`
    SELECT min(id) AS id, chunk_index, min(content) AS content
    FROM memories
    WHERE deleted = 0 AND source_path = ?
    GROUP BY chunk_index
    ORDER BY chunk_index
  `).all(sourcePath) as ChunkRow[];
}

function hasCanonicalEvidenceForFile(db: Database.Database, sourcePath: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM canonical_evidence e
    JOIN memories m ON m.id = e.memory_id
    WHERE m.deleted = 0 AND m.source_path = ?
    LIMIT 1
  `).get(sourcePath);
  return Boolean(row);
}

function listNearbyCanonicals(db: Database.Database, scope: string): NearbyCanonicalRow[] {
  return db.prepare(`
    SELECT id, kind, title, content, confidence
    FROM canonical_memories
    WHERE scope = ?
    ORDER BY decided_at DESC, updated_at DESC, created_at DESC
    LIMIT 8
  `).all(scope) as NearbyCanonicalRow[];
}

function extractDateHint(text: string): string | null {
  const match = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (!match) return null;
  return `${match[1]}T00:00:00.000Z`;
}

function clampScore(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith("---\n")) return {};
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return {};

  const frontmatter = raw.slice(4, end).split("\n");
  const parsed: ParsedFrontmatter = {};
  for (const line of frontmatter) {
    const match = line.match(/^title:\s*["']?(.*?)["']?\s*$/);
    if (match) parsed.title = match[1];
  }
  return parsed;
}

function cleanText(value: string): string {
  return value
    .replace(/^---[\s\S]*?---/m, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/\[\[(.*?)\]\]/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\|/g, " ")
    .replace(/[*_>`~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksGenericTitle(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return GENERIC_TITLE_PATTERNS.some((pattern) => normalized === pattern || normalized.endsWith(` ${pattern}`));
}

function contextualizeTitle(file: CandidateFile, title: string): string {
  const relativeDir = path.dirname(path.relative(DEFAULT_ROOT, file.sourcePath));
  const parts = relativeDir === "." ? [] : relativeDir.split(path.sep).slice(1);
  const context = parts.slice(-2).join(" ").trim();
  if (!context) return `${file.topProject} ${title}`.trim();
  return `${file.topProject} ${context} ${title}`.trim();
}

function splitSnippets(text: string): string[] {
  return cleanText(text)
    .split(/(?<=[.!?])\s+|(?<=\))\s+| (?=[A-Z가-힣][^A-Z]*: )/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 24);
}

function inferTitle(file: CandidateFile): string {
  const raw = fs.readFileSync(file.sourcePath, "utf8");
  const frontmatter = parseFrontmatter(raw);
  if (frontmatter.title?.trim()) {
    const title = frontmatter.title.trim();
    return looksGenericTitle(title) ? contextualizeTitle(file, title) : `${file.topProject} ${title}`;
  }

  const heading = raw.match(/^#\s+(.+)$/m);
  if (heading?.[1]) {
    const title = heading[1].trim();
    return looksGenericTitle(title) ? contextualizeTitle(file, title) : `${file.topProject} ${title}`;
  }

  const fileName = path.basename(file.sourcePath, ".md");
  return looksGenericTitle(fileName) ? contextualizeTitle(file, fileName) : `${file.topProject} ${fileName}`;
}

function buildHeuristicPayload(file: CandidateFile, chunks: ChunkRow[]): ModelPayload {
  const kind: CanonicalKind = file.tier === "a" ? "decision" : "fact";
  const excerpt = chunks.slice(0, file.tier === "a" ? 3 : 2).map((chunk) => chunk.content).join(" ");
  const snippets = splitSnippets(excerpt).slice(0, 3);
  const title = inferTitle(file);
  const contentBody = snippets.length > 0
    ? snippets.join(" ")
    : cleanText(excerpt).slice(0, 420);

  return {
    include: true,
    kind,
    title,
    content: contentBody,
    confidence: file.tier === "a" ? 0.62 : 0.55,
    importance: file.tier === "a" ? 0.74 : 0.6,
    decidedAt: extractDateHint(excerpt),
    rationale: "heuristic fallback",
  };
}

function buildPrompt(
  file: CandidateFile,
  root: string,
  chunks: ChunkRow[],
  nearbyCanonicals: NearbyCanonicalRow[]
): string {
  const excerpt = chunks
    .slice(0, file.tier === "a" ? 6 : 4)
    .map((chunk) => `Chunk ${chunk.chunk_index}:\n${chunk.content}`)
    .join("\n\n");
  const pathInfo = path.relative(root, file.sourcePath);

  return [
    "You are creating one canonical memory seed from a project markdown document.",
    "Return JSON only.",
    'Schema: {"include":boolean,"kind":"fact"|"decision","title":string,"content":string,"confidence":number,"importance":number,"decidedAt":string|null,"rationale":string}.',
    "Create at most one canonical memory for this file.",
    "Prefer durable project-level knowledge, not temporary implementation chatter.",
    "For PRD, roadmap, launch, requirement, planning, or strategy docs, prefer kind=decision.",
    "For API/spec/detail docs, prefer kind=fact unless the doc clearly records an explicit decision.",
    "If the file is too duplicate, too tactical, or too weak as a canonical seed, return include=false with rationale.",
    "Title must be concise and include the project name.",
    "Content must be 2 to 4 sentences, plain text, specific, and searchable.",
    "Confidence and importance must be numbers between 0 and 1.",
    "If a concrete date is obvious from the doc, set decidedAt as ISO 8601 midnight UTC. Otherwise use null.",
    `Project: ${file.topProject}`,
    `Scope: ${file.scope}`,
    `Tier: ${file.tier}`,
    `Document path: ${pathInfo}`,
    `Nearby canonicals in scope: ${JSON.stringify(nearbyCanonicals)}`,
    "Document excerpt:",
    excerpt,
  ].join("\n");
}

function parseModelPayload(raw: string): ModelPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const data = parsed as Record<string, unknown>;
  const include = Boolean(data.include);
  if (!include) {
    return {
      include: false,
      rationale: typeof data.rationale === "string" ? data.rationale.trim() : "model skipped",
    };
  }

  const kind = data.kind === "fact" || data.kind === "decision" ? data.kind : undefined;
  const title = typeof data.title === "string" ? data.title.trim() : "";
  const content = typeof data.content === "string" ? data.content.trim().replace(/\s+/g, " ") : "";
  const confidence = typeof data.confidence === "number" ? data.confidence : NaN;
  const importance = typeof data.importance === "number" ? data.importance : NaN;
  const decidedAt = typeof data.decidedAt === "string" ? data.decidedAt : null;
  const rationale = typeof data.rationale === "string" ? data.rationale.trim() : "";

  if (!kind || !title || !content || !Number.isFinite(confidence) || !Number.isFinite(importance)) {
    return null;
  }

  return {
    include: true,
    kind,
    title,
    content,
    confidence: clampScore(confidence, 0.6),
    importance: clampScore(importance, 0.7),
    decidedAt,
    rationale,
  };
}

async function summarizeFile(
  db: Database.Database,
  file: CandidateFile,
  root: string,
  chunks: ChunkRow[],
  model?: string
): Promise<ModelPayload | null> {
  const nearbyCanonicals = listNearbyCanonicals(db, file.scope);
  const prompt = buildPrompt(file, root, chunks, nearbyCanonicals);
  try {
    const raw = await requestOllamaGenerate(prompt, {
      model,
      format: "json",
      timeoutMs: 60_000,
    });
    const parsed = parseModelPayload(raw);
    if (parsed?.include && !parsed.decidedAt) {
      parsed.decidedAt = extractDateHint(chunks.map((chunk) => chunk.content).join("\n"));
    }
    if (parsed) return parsed;
  } catch (error) {
    const message = (error as Error).message;
    console.warn(`[promote-project-seeds] Ollama generation failed for ${file.sourcePath}: ${message}`);
  }

  return buildHeuristicPayload(file, chunks);
}

async function promoteFile(
  db: Database.Database,
  file: CandidateFile,
  payload: ModelPayload,
  chunks: ChunkRow[]
): Promise<string> {
  const result = await memoryPromote(db, {
    memoryIds: chunks.slice(0, file.tier === "a" ? 6 : 4).map((chunk) => chunk.id),
    kind: payload.kind!,
    title: payload.title!,
    content: payload.content!,
    scope: file.scope,
    confidence: payload.confidence,
    importance: payload.importance,
    decidedAt: payload.decidedAt ?? undefined,
  });
  return result.canonicalId;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const files = scanCandidateFiles(options.root, options);
  const limitedFiles = typeof options.limit === "number" ? files.slice(0, options.limit) : files;
  const { db, close } = openDatabase("/Users/flowkater/.engram/memory.db", { runMaintenance: false });

  let scanned = 0;
  let skipped = 0;
  let promoted = 0;

  try {
    for (const file of limitedFiles) {
      scanned += 1;
      if (hasCanonicalEvidenceForFile(db, file.sourcePath)) {
        skipped += 1;
        console.log(`SKIP evidence-exists ${path.relative(options.root, file.sourcePath)}`);
        continue;
      }

      const chunks = getUniqueChunksForFile(db, file.sourcePath);
      if (chunks.length === 0) {
        skipped += 1;
        console.log(`SKIP no-chunks ${path.relative(options.root, file.sourcePath)}`);
        continue;
      }

      const payload = await summarizeFile(db, file, options.root, chunks, options.model);
      if (!payload) {
        skipped += 1;
        console.log(`SKIP invalid-model-response ${path.relative(options.root, file.sourcePath)}`);
        continue;
      }
      if (!payload.include) {
        skipped += 1;
        console.log(`SKIP model-excluded ${path.relative(options.root, file.sourcePath)} :: ${payload.rationale}`);
        continue;
      }

      if (options.dryRun) {
        promoted += 1;
        console.log(`DRYRUN ${file.scope} :: ${payload.kind} :: ${payload.title}`);
        continue;
      }

      const canonicalId = await promoteFile(db, file, payload, chunks);
      promoted += 1;
      console.log(`PROMOTED ${file.scope} :: ${payload.kind} :: ${canonicalId} :: ${payload.title}`);
    }

    console.log(
      JSON.stringify(
        {
          scanned,
          promoted,
          skipped,
          tier: options.tier,
          project: options.project ?? null,
          dryRun: options.dryRun,
        },
        null,
        2
      )
    );
  } finally {
    close();
  }
}

await main();
