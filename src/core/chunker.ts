/**
 * Markdown chunker — splits markdown files into chunks for embedding.
 * - H2 (##) heading-based splitting
 * - Code blocks kept intact (never split mid-block)
 * - Frontmatter (YAML) extracted as metadata (via gray-matter)
 * - Small sections (<500 tokens) merged with next section
 * - Wiki links [[...]] preserved
 */
import matter from "gray-matter";

export interface ChunkOptions {
  maxTokens: number;
  overlap: number;
}

export interface ChunkMeta {
  tags?: string[];
  scope?: string;
  title?: string;
  [key: string]: unknown;
}

export interface Chunk {
  text: string;
  index: number;
  heading?: string;
  meta: ChunkMeta;
}

/** Default options for Obsidian notes */
export const OBSIDIAN_CHUNK_OPTS: ChunkOptions = { maxTokens: 512, overlap: 50 };

/** Default options for MEMORY.md files */
export const MEMORY_MD_CHUNK_OPTS: ChunkOptions = { maxTokens: 256, overlap: 0 };

/**
 * Rough token count estimation (~4 chars per token for mixed content).
 */
export function estimateTokens(text: string): number {
  // Korean characters (Hangul syllables + Jamo) use ~2 chars/token vs ~4 for Latin
  const koreanCount = (text.match(/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g) || []).length;
  const otherCount = text.length - koreanCount;
  return Math.ceil(koreanCount / 2 + otherCount / 4);
}

/**
 * Parse YAML frontmatter from markdown content using gray-matter.
 * Returns the extracted metadata and the content without frontmatter.
 */
export function parseFrontmatter(content: string): { meta: ChunkMeta; body: string } {
  const parsed = matter(content);
  const data = parsed.data as Record<string, unknown>;
  const meta: ChunkMeta = {};

  // Extract tags (supports inline array, multi-line list, and #-prefixed)
  if (Array.isArray(data.tags)) {
    meta.tags = data.tags.map((t: unknown) =>
      String(t).trim().replace(/^#/, "")
    );
  } else if (typeof data.tags === "string") {
    meta.tags = [data.tags.trim().replace(/^#/, "")];
  }

  if (typeof data.scope === "string") {
    meta.scope = data.scope.trim();
  }
  if (typeof data.title === "string") {
    meta.title = data.title.trim();
  }

  // Preserve any other frontmatter fields
  for (const [key, value] of Object.entries(data)) {
    if (!["tags", "scope", "title"].includes(key)) {
      meta[key] = value;
    }
  }

  return { meta, body: parsed.content };
}

/**
 * Split markdown by H2 (##) headings while preserving code blocks.
 * Returns sections where each section has a heading (optional) and content.
 */
function splitByH2(body: string): Array<{ heading?: string; content: string }> {
  const sections: Array<{ heading?: string; content: string }> = [];
  const lines = body.split("\n");

  let currentHeading: string | undefined;
  let currentLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Track code block state
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      currentLines.push(line);
      continue;
    }

    // Only split on ## when not inside a code block
    if (!inCodeBlock && /^##\s+/.test(line)) {
      // Save previous section
      if (currentLines.length > 0 || currentHeading) {
        sections.push({
          heading: currentHeading,
          content: currentLines.join("\n").trim(),
        });
      }
      currentHeading = line.replace(/^##\s+/, "").trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Last section
  if (currentLines.length > 0 || currentHeading) {
    sections.push({
      heading: currentHeading,
      content: currentLines.join("\n").trim(),
    });
  }

  return sections;
}

/**
 * Merge small sections (< minTokens) with the next section.
 */
function mergeSections(
  sections: Array<{ heading?: string; content: string }>,
  minTokens: number
): Array<{ heading?: string; content: string }> {
  if (sections.length <= 1) return sections;

  const merged: Array<{ heading?: string; content: string }> = [];
  let buffer: { heading?: string; content: string } | null = null;

  for (const section of sections) {
    if (buffer) {
      const bufferTokens = estimateTokens(buffer.content);
      if (bufferTokens < minTokens) {
        // Merge with current section
        const headingLine = section.heading ? `## ${section.heading}\n\n` : "";
        buffer = {
          heading: buffer.heading,
          content: (buffer.content + "\n\n" + headingLine + section.content).trim(),
        };
        continue;
      } else {
        merged.push(buffer);
      }
    }
    buffer = { ...section };
  }

  if (buffer) {
    // If last buffer is still small and we have previous sections, merge with last
    if (merged.length > 0 && estimateTokens(buffer.content) < minTokens) {
      const last = merged[merged.length - 1];
      const headingLine = buffer.heading ? `## ${buffer.heading}\n\n` : "";
      last.content = (last.content + "\n\n" + headingLine + buffer.content).trim();
    } else {
      merged.push(buffer);
    }
  }

  return merged;
}

/**
 * Split a section that exceeds maxTokens by paragraph boundaries.
 */
function splitLargeSection(
  section: { heading?: string; content: string },
  maxTokens: number
): Array<{ heading?: string; content: string }> {
  if (estimateTokens(section.content) <= maxTokens) {
    return [section];
  }

  const paragraphs = section.content.split(/\n\n+/);
  const results: Array<{ heading?: string; content: string }> = [];
  let currentParts: string[] = [];
  let currentTokens = 0;
  let isFirst = true;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    if (currentTokens + paraTokens > maxTokens && currentParts.length > 0) {
      results.push({
        heading: isFirst ? section.heading : section.heading ? `${section.heading} (cont.)` : undefined,
        content: currentParts.join("\n\n").trim(),
      });
      isFirst = false;
      currentParts = [];
      currentTokens = 0;
    }

    currentParts.push(para);
    currentTokens += paraTokens;
  }

  if (currentParts.length > 0) {
    results.push({
      heading: isFirst ? section.heading : section.heading ? `${section.heading} (cont.)` : undefined,
      content: currentParts.join("\n\n").trim(),
    });
  }

  return results;
}

/**
 * Add overlap text from previous chunk to the beginning of the next chunk.
 */
function addOverlap(chunks: Chunk[], overlapTokens: number): Chunk[] {
  if (overlapTokens <= 0 || chunks.length <= 1) return chunks;

  const result: Chunk[] = [chunks[0]];
  const overlapChars = overlapTokens * 4;

  for (let i = 1; i < chunks.length; i++) {
    const prevText = chunks[i - 1].text;
    const overlapText = prevText.slice(-overlapChars);
    result.push({
      ...chunks[i],
      text: overlapText + "\n\n" + chunks[i].text,
    });
  }

  return result;
}

/**
 * Chunk a markdown document into embeddable segments.
 *
 * @param content - Raw markdown content (including optional frontmatter)
 * @param opts - Chunking options (maxTokens, overlap)
 * @returns Array of chunks with metadata
 */
export function chunkMarkdown(content: string, opts: ChunkOptions = OBSIDIAN_CHUNK_OPTS): Chunk[] {
  const { meta, body } = parseFrontmatter(content);

  if (!body.trim()) {
    return [];
  }

  // Split by H2 headings
  let sections = splitByH2(body);

  // Merge small sections (< 500 tokens / ~2000 chars)
  sections = mergeSections(sections, 125); // 500 tokens ≈ 125 * 4 chars — we use token count in mergeSections

  // Split oversized sections
  const finalSections: Array<{ heading?: string; content: string }> = [];
  for (const section of sections) {
    finalSections.push(...splitLargeSection(section, opts.maxTokens));
  }

  // Create chunks
  let chunks: Chunk[] = finalSections
    .filter((s) => s.content.trim().length > 0)
    .map((s, i) => ({
      text: s.heading ? `## ${s.heading}\n\n${s.content}` : s.content,
      index: i,
      heading: s.heading,
      meta: { ...meta },
    }));

  // Add overlap
  chunks = addOverlap(chunks, opts.overlap);

  // Re-index after overlap
  chunks = chunks.map((c, i) => ({ ...c, index: i }));

  return chunks;
}

/**
 * Extract wiki links from text. Returns array of linked note names.
 */
export function extractWikiLinks(text: string): string[] {
  const matches = text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
  return [...matches].map((m) => m[1].trim());
}
