/**
 * Markdown chunker — splits markdown files into chunks for embedding.
 * - H2 (##) heading-based splitting
 * - Code blocks kept intact (never split mid-block)
 * - Frontmatter (YAML) extracted as metadata
 * - Small sections (<500 tokens) merged with next section
 * - Wiki links [[...]] preserved
 */

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
  return Math.ceil(text.length / 4);
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns the extracted metadata and the content without frontmatter.
 */
export function parseFrontmatter(content: string): { meta: ChunkMeta; body: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fmMatch) {
    return { meta: {}, body: content };
  }

  const meta: ChunkMeta = {};
  const yamlBlock = fmMatch[1];
  const body = content.slice(fmMatch[0].length);

  // Simple YAML parsing for common fields
  for (const line of yamlBlock.split("\n")) {
    const tagMatch = line.match(/^tags:\s*\[(.*)\]/);
    if (tagMatch) {
      meta.tags = tagMatch[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const tagListMatch = line.match(/^tags:\s*$/);
    if (tagListMatch) {
      // Multi-line tags list — collect in next lines
      continue;
    }
    const tagItemMatch = line.match(/^\s*-\s+(.+)/);
    if (tagItemMatch && !meta.tags) {
      meta.tags = meta.tags || [];
    }
    if (tagItemMatch && yamlBlock.includes("tags:")) {
      meta.tags = meta.tags || [];
      meta.tags.push(tagItemMatch[1].trim().replace(/^["']|["']$/g, "").replace(/^#/, ""));
    }
    const scopeMatch = line.match(/^scope:\s*(.+)/);
    if (scopeMatch) {
      meta.scope = scopeMatch[1].trim();
    }
    const titleMatch = line.match(/^title:\s*(.+)/);
    if (titleMatch) {
      meta.title = titleMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  return { meta, body };
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
