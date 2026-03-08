/**
 * Tests for markdown chunker.
 */
import { describe, it, expect } from "vitest";
import {
  chunkMarkdown,
  parseFrontmatter,
  extractWikiLinks,
  estimateTokens,
  OBSIDIAN_CHUNK_OPTS,
  MEMORY_MD_CHUNK_OPTS,
} from "./chunker.js";

describe("parseFrontmatter", () => {
  it("extracts tags and scope from YAML frontmatter", () => {
    const content = `---
tags: [project, ai]
scope: todait-backend
title: My Note
---

# Hello

Content here.`;
    const { meta, body } = parseFrontmatter(content);
    expect(meta.tags).toEqual(["project", "ai"]);
    expect(meta.scope).toBe("todait-backend");
    expect(meta.title).toBe("My Note");
    expect(body).toContain("# Hello");
    expect(body).not.toContain("---");
  });

  it("returns empty meta when no frontmatter", () => {
    const content = "# Just a title\n\nSome content.";
    const { meta, body } = parseFrontmatter(content);
    expect(meta).toEqual({});
    expect(body).toBe(content);
  });

  it("handles multi-line tags", () => {
    const content = `---
tags:
  - project
  - ai
---

Content.`;
    const { meta } = parseFrontmatter(content);
    expect(meta.tags).toContain("project");
    expect(meta.tags).toContain("ai");
  });
});

describe("chunkMarkdown", () => {
  it("splits by H2 headings", () => {
    const md = `# Title

Intro paragraph with enough text to be meaningful.

## Section A

Content A is about redistribution policy and task processing, which is important for the system.

## Section B

Content B covers iOS build issues and code signing problems that need to be resolved.`;

    const chunks = chunkMarkdown(md, OBSIDIAN_CHUNK_OPTS);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Chunks should contain the section content
    const allText = chunks.map((c) => c.text).join(" ");
    expect(allText).toContain("Content A");
    expect(allText).toContain("Content B");
  });

  it("does not split code blocks", () => {
    const md = `## Setup

Some text.

\`\`\`typescript
## This is not a heading
const x = 1;
const y = 2;
\`\`\`

More text after code.

## Next Section

Other content here.`;

    const chunks = chunkMarkdown(md, OBSIDIAN_CHUNK_OPTS);
    // The code block should be in a single chunk, not split at "## This is not a heading"
    const codeChunk = chunks.find((c) => c.text.includes("const x = 1"));
    expect(codeChunk).toBeTruthy();
    expect(codeChunk!.text).toContain("## This is not a heading");
    expect(codeChunk!.text).toContain("const y = 2");
  });

  it("preserves wiki links", () => {
    const md = `## Notes

See [[Redistribution Policy]] and [[Task Processing|TP]] for details.`;

    const chunks = chunkMarkdown(md, OBSIDIAN_CHUNK_OPTS);
    expect(chunks[0].text).toContain("[[Redistribution Policy]]");
    expect(chunks[0].text).toContain("[[Task Processing|TP]]");
  });

  it("extracts frontmatter metadata into chunk meta", () => {
    const md = `---
tags: [backend, refactor]
scope: todait-backend
---

## Content

Some important content.`;

    const chunks = chunkMarkdown(md, OBSIDIAN_CHUNK_OPTS);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].meta.tags).toEqual(["backend", "refactor"]);
    expect(chunks[0].meta.scope).toBe("todait-backend");
  });

  it("merges small sections with next", () => {
    // Two very short sections (< 500 tokens each) should be merged
    const md = `## A

Short.

## B

Also short.`;

    const chunks = chunkMarkdown(md, OBSIDIAN_CHUNK_OPTS);
    // Both sections are tiny, should be merged into 1 chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("Short");
    expect(chunks[0].text).toContain("Also short");
  });

  it("returns empty for empty content", () => {
    expect(chunkMarkdown("", OBSIDIAN_CHUNK_OPTS)).toEqual([]);
    expect(chunkMarkdown("---\ntags: []\n---\n", OBSIDIAN_CHUNK_OPTS)).toEqual([]);
  });

  it("works with MEMORY_MD options (smaller chunks, no overlap)", () => {
    const md = `## Decision Log

We decided to use flat processing for redistribution.

## Architecture Notes

The backend uses event-driven architecture with message queues.`;

    const chunks = chunkMarkdown(md, MEMORY_MD_CHUNK_OPTS);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("assigns sequential chunk indices", () => {
    // Create content that will produce multiple chunks
    const longContent = "x".repeat(3000); // ~750 tokens
    const md = `## Section 1

${longContent}

## Section 2

${longContent}`;

    const chunks = chunkMarkdown(md, OBSIDIAN_CHUNK_OPTS);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
    }
  });
});

describe("extractWikiLinks", () => {
  it("extracts simple wiki links", () => {
    const text = "See [[Note A]] and [[Note B]] for details.";
    expect(extractWikiLinks(text)).toEqual(["Note A", "Note B"]);
  });

  it("handles aliased wiki links", () => {
    const text = "Check [[Long Note Name|short]] here.";
    expect(extractWikiLinks(text)).toEqual(["Long Note Name"]);
  });

  it("returns empty for no links", () => {
    expect(extractWikiLinks("No links here.")).toEqual([]);
  });
});

describe("estimateTokens", () => {
  it("estimates roughly 4 chars per token", () => {
    expect(estimateTokens("hello")).toBe(2); // 5/4 = 1.25, ceil = 2
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});
