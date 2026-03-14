/**
 * Embedding client — Ollama (primary) + OpenAI (fallback).
 * Generates 768-dim vectors from text using nomic-embed-text.
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "nomic-embed-text";
const EMBEDDING_DIM = 768;
const STRICT_LOCAL = (process.env.ENGRAM_STRICT_LOCAL ?? "true") !== "false";
// nomic-embed-text context limit is 8192 tokens (~28,000 chars)
const MAX_EMBED_CHARS = 28_000;

export interface EmbedderOptions {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  openaiApiKey?: string;
}

/**
 * Embed text using Ollama's nomic-embed-text model.
 * Falls back to OpenAI text-embedding-3-small if Ollama is unavailable and OPENAI_API_KEY is set.
 */
export interface EmbedResult {
  embedding: Float32Array;
  model: string;
}

export async function embed(text: string, opts?: EmbedderOptions): Promise<Float32Array>;
export async function embed(text: string, opts: EmbedderOptions | undefined, withModel: true): Promise<EmbedResult>;
export async function embed(text: string, opts?: EmbedderOptions, withModel?: true): Promise<Float32Array | EmbedResult> {
  if (process.env.ENGRAM_MOCK_EMBEDDINGS === "true") {
    const embedding = createMockEmbedding(text);
    return withModel ? { embedding, model: "mock/nomic-embed-text" } : embedding;
  }

  // Sanitize: Ollama's nomic-embed-text can trigger YAML parsing on prompt text.
  // Strip frontmatter blocks entirely and normalize problematic patterns.
  const sanitized = text
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/m, "") // strip full frontmatter block
    .replace(/^---\s*\n/gm, "")                    // stray delimiters
    .replace(/\n---\s*$/gm, "");
  // Truncate to stay within nomic-embed-text context limit (8192 tokens)
  const truncatedText = sanitized.length > MAX_EMBED_CHARS ? sanitized.slice(0, MAX_EMBED_CHARS) : sanitized;
  const baseUrl = opts?.ollamaBaseUrl || OLLAMA_BASE_URL;
  const model = opts?.ollamaModel || OLLAMA_MODEL;

  try {
    const embedding = await embedOllama(truncatedText, baseUrl, model);
    return withModel ? { embedding, model: `ollama/${model}` } : embedding;
  } catch (err) {
    const apiKey = opts?.openaiApiKey || process.env.OPENAI_API_KEY;
    if (apiKey && !STRICT_LOCAL) {
      console.warn("[embedder] Ollama failed, falling back to OpenAI:", (err as Error).message);
      const embedding = await embedOpenAI(truncatedText, apiKey);
      return withModel ? { embedding, model: "openai/text-embedding-3-small" } : embedding;
    }
    if (apiKey && STRICT_LOCAL) {
      throw new Error(
        `Embedding failed: Ollama unavailable. ENGRAM_STRICT_LOCAL=true blocks OpenAI fallback. Set ENGRAM_STRICT_LOCAL=false to allow.`
      );
    }
    throw new Error(
      `Embedding failed: Ollama unavailable (${(err as Error).message}) and no OPENAI_API_KEY set`
    );
  }
}

/**
 * @deprecated Use embed(text, opts, true) and read result.model instead.
 * Kept only for health-check model mismatch detection.
 */
export function getCurrentModelName(opts?: EmbedderOptions): string {
  return `ollama/${opts?.ollamaModel || OLLAMA_MODEL}`;
}

async function embedOllama(text: string, baseUrl: string, model: string): Promise<Float32Array> {
  const TIMEOUT_MS = 30_000;
  const MAX_RETRIES = 1;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: text }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as { embedding: number[] };
      if (!data.embedding || data.embedding.length !== EMBEDDING_DIM) {
        throw new Error(
          `Unexpected embedding dimension: got ${data.embedding?.length}, expected ${EMBEDDING_DIM}`
        );
      }

      return new Float32Array(data.embedding);
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES) {
        console.warn(`[embedder] Ollama attempt ${attempt + 1} failed: ${lastError.message}, retrying in 1s...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  throw lastError!;
}

async function embedOpenAI(text: string, apiKey: string): Promise<Float32Array> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
      dimensions: EMBEDDING_DIM,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return new Float32Array(data.data[0].embedding);
}

export { EMBEDDING_DIM };

function createMockEmbedding(text: string): Float32Array {
  let seed = 0;
  for (let index = 0; index < text.length; index += 1) {
    seed = (seed * 31 + text.charCodeAt(index)) >>> 0;
  }

  const values = new Float32Array(EMBEDDING_DIM);
  for (let index = 0; index < EMBEDDING_DIM; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    values[index] = (seed % 1000) / 1000;
  }

  return values;
}
