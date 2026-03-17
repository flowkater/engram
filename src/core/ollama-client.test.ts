import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ollama-client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_MODEL;
    delete process.env.ENGRAM_CANONICAL_JUDGE_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("posts embeddings to the configured Ollama base URL and model", async () => {
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:22434";
    process.env.OLLAMA_MODEL = "nomic-embed-text";

    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: new Array(768).fill(0.1) }),
    });

    const { requestOllamaEmbeddings } = await import("./ollama-client.js");

    const embedding = await requestOllamaEmbeddings("embed me", { request });

    expect(embedding).toBeInstanceOf(Float32Array);
    expect(embedding).toHaveLength(768);
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:22434/api/embeddings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "nomic-embed-text", prompt: "embed me" }),
      })
    );
  });

  it("posts generate requests with json format and returns the response text", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "{\"action\":\"reject\"}" }),
    });

    const { requestOllamaGenerate } = await import("./ollama-client.js");

    const text = await requestOllamaGenerate("judge this", {
      model: "llama3.2:3b",
      format: "json",
      request,
    });

    expect(text).toBe("{\"action\":\"reject\"}");
    expect(request).toHaveBeenCalledWith(
      "http://localhost:11434/api/generate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "llama3.2:3b",
          prompt: "judge this",
          stream: false,
          format: "json",
        }),
      })
    );
  });

  it("throws when Ollama returns an invalid embedding dimension", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2] }),
    });

    const { requestOllamaEmbeddings } = await import("./ollama-client.js");

    await expect(requestOllamaEmbeddings("bad dims", { request })).rejects.toThrow(
      "Unexpected embedding dimension"
    );
  });

  it("resolves the dedicated canonical judge model when configured", async () => {
    process.env.ENGRAM_CANONICAL_JUDGE_MODEL = "qwen2.5:7b";

    const { getCanonicalJudgeModelName } = await import("./ollama-client.js");

    expect(getCanonicalJudgeModelName()).toBe("qwen2.5:7b");
  });
});
