/**
 * Shared mock embedder for tests.
 * Usage: vi.mock("./embedder.js", () => createMockEmbedder());
 */

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
    embed: (text: string, _opts?: unknown, withModel?: boolean) => {
      const p = fakeEmbed(text);
      if (withModel) return p.then((embedding: Float32Array) => ({ embedding, model: modelName }));
      return p;
    },
    EMBEDDING_DIM: 768,
    getCurrentModelName: () => modelName,
  };
}
