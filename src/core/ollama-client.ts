export const OLLAMA_EMBEDDING_DIM = 768;

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_EMBED_MODEL = "nomic-embed-text";
const DEFAULT_CANONICAL_JUDGE_MODEL = "llama3.2:3b";
const DEFAULT_TIMEOUT_MS = 30_000;

interface OllamaJsonResponse {
  ok: boolean;
  status?: number;
  statusText?: string;
  json(): Promise<unknown>;
}

export type OllamaRequestFn = (
  url: string,
  init: RequestInit
) => Promise<OllamaJsonResponse>;

export interface OllamaRequestOptions {
  baseUrl?: string;
  model?: string;
  request?: OllamaRequestFn;
  timeoutMs?: number;
}

export interface OllamaGenerateOptions extends OllamaRequestOptions {
  format?: "json";
}

function defaultRequest(url: string, init: RequestInit): Promise<OllamaJsonResponse> {
  return fetch(url, init) as Promise<OllamaJsonResponse>;
}

export function getOllamaBaseUrl(override?: string): string {
  return override || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
}

export function getOllamaEmbeddingModelName(override?: string): string {
  return override || process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_EMBED_MODEL;
}

export function getCanonicalJudgeModelName(override?: string): string {
  return override || process.env.ENGRAM_CANONICAL_JUDGE_MODEL || DEFAULT_CANONICAL_JUDGE_MODEL;
}

export async function requestOllamaEmbeddings(
  text: string,
  opts?: OllamaRequestOptions
): Promise<Float32Array> {
  const request = opts?.request ?? defaultRequest;
  const baseUrl = getOllamaBaseUrl(opts?.baseUrl);
  const model = getOllamaEmbeddingModelName(opts?.model);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const response = await request(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { embedding?: number[] };
  if (!Array.isArray(data.embedding) || data.embedding.length !== OLLAMA_EMBEDDING_DIM) {
    throw new Error(
      `Unexpected embedding dimension: got ${data.embedding?.length}, expected ${OLLAMA_EMBEDDING_DIM}`
    );
  }

  return new Float32Array(data.embedding);
}

export async function requestOllamaGenerate(
  prompt: string,
  opts?: OllamaGenerateOptions
): Promise<string> {
  const request = opts?.request ?? defaultRequest;
  const baseUrl = getOllamaBaseUrl(opts?.baseUrl);
  const model = getCanonicalJudgeModelName(opts?.model);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const response = await request(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      format: opts?.format,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { response?: string };
  if (typeof data.response !== "string") {
    throw new Error("Ollama generate response missing text payload");
  }

  return data.response;
}
