/**
 * Shared mock embedder for tests.
 * Usage: vi.mock("./embedder.js", () => createMockEmbedder());
 */

let mockDelayMs = 0;

/**
 * Set an artificial delay (ms) for every mock embed call.
 * Used by tests that need to observe parallelism vs serial timing.
 */
export function setEmbedderMockDelayMs(ms: number): void {
  mockDelayMs = ms;
}

/**
 * Reset the artificial delay back to 0.
 */
export function resetEmbedderMockDelay(): void {
  mockDelayMs = 0;
}

export function fakeEmbed(text: string): Promise<Float32Array> {
  const vec = new Float32Array(768);
  for (let i = 0; i < Math.min(text.length, 768); i++) {
    vec[i] = text.charCodeAt(i) / 256;
  }
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 768; i++) vec[i] /= norm;
  return Promise.resolve(vec);
}

export function createMockEmbedder(modelName = "test-model") {
  return {
    embed: async (text: string, _opts?: unknown, withModel?: boolean) => {
      if (mockDelayMs > 0) {
        await new Promise((r) => setTimeout(r, mockDelayMs));
      }
      const embedding = await fakeEmbed(text);
      if (withModel) return { embedding, model: modelName };
      return embedding;
    },
    EMBEDDING_DIM: 768,
    getCurrentModelName: () => modelName,
  };
}
