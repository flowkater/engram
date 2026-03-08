/**
 * Embedding client — Ollama (primary) + OpenAI (fallback).
 * Generates 768-dim vectors from text using nomic-embed-text.
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "nomic-embed-text";
const EMBEDDING_DIM = 768;

export interface EmbedderOptions {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  openaiApiKey?: string;
}

/**
 * Embed text using Ollama's nomic-embed-text model.
 * Falls back to OpenAI text-embedding-3-small if Ollama is unavailable and OPENAI_API_KEY is set.
 */
export async function embed(text: string, opts?: EmbedderOptions): Promise<Float32Array> {
  const baseUrl = opts?.ollamaBaseUrl || OLLAMA_BASE_URL;
  const model = opts?.ollamaModel || OLLAMA_MODEL;

  try {
    return await embedOllama(text, baseUrl, model);
  } catch (err) {
    const apiKey = opts?.openaiApiKey || process.env.OPENAI_API_KEY;
    if (apiKey) {
      console.warn("[embedder] Ollama failed, falling back to OpenAI:", (err as Error).message);
      return await embedOpenAI(text, apiKey);
    }
    throw new Error(
      `Embedding failed: Ollama unavailable (${(err as Error).message}) and no OPENAI_API_KEY set`
    );
  }
}

async function embedOllama(text: string, baseUrl: string, model: string): Promise<Float32Array> {
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
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
