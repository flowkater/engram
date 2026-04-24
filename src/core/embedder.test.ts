/**
 * Tests for ENGRAM_STRICT_LOCAL mode in embedder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("ENGRAM_STRICT_LOCAL", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.ENGRAM_STRICT_LOCAL;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("strict local mode (default): throws on Ollama failure even if OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    // ENGRAM_STRICT_LOCAL not set → defaults to true

    const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    const { embed } = await import("./embedder.js");

    await expect(embed("test text")).rejects.toThrow("ENGRAM_STRICT_LOCAL");

    // Should NOT have called OpenAI
    const openaiCalls = mockFetch.mock.calls.filter((c: any) =>
      String(c[0]).includes("openai.com")
    );
    expect(openaiCalls).toHaveLength(0);
  });

  it("strict local disabled: falls back to OpenAI when Ollama fails", async () => {
    process.env.ENGRAM_STRICT_LOCAL = "false";
    process.env.OPENAI_API_KEY = "sk-test-key";

    const fakeEmbedding = new Array(768).fill(0.1);
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("openai.com")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [{ embedding: fakeEmbedding }] }),
        });
      }
      return Promise.reject(new Error("Connection refused"));
    });
    vi.stubGlobal("fetch", mockFetch);

    const { embed } = await import("./embedder.js");

    const result = await embed("test text");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(768);
  });

  it("strict local disabled + withModel: returns openai model name on fallback", async () => {
    process.env.ENGRAM_STRICT_LOCAL = "false";
    process.env.OPENAI_API_KEY = "sk-test-key";

    const fakeEmbedding = new Array(768).fill(0.1);
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("openai.com")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [{ embedding: fakeEmbedding }] }),
        });
      }
      return Promise.reject(new Error("Connection refused"));
    });
    vi.stubGlobal("fetch", mockFetch);

    const { embed } = await import("./embedder.js");

    const result = await embed("test text", undefined, true);
    expect(result.model).toBe("openai/text-embedding-3-small");
  });

  it("uses deterministic mock embeddings when ENGRAM_MOCK_EMBEDDINGS=true", async () => {
    process.env.ENGRAM_MOCK_EMBEDDINGS = "true";

    const { embed } = await import("./embedder.js");

    const first = await embed("test text", undefined, true);
    const second = await embed("test text", undefined, true);
    const third = await embed("different text", undefined, true);

    expect(first.model).toBe("mock/nomic-embed-text");
    expect(Array.from(first.embedding)).toEqual(Array.from(second.embedding));
    expect(Array.from(first.embedding)).not.toEqual(Array.from(third.embedding));
  });
});

describe("embedOllama exponential backoff", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.ENGRAM_STRICT_LOCAL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ENGRAM_MOCK_EMBEDDINGS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("computeEmbedBackoffMs returns 1s/2s/4s for attempts 0/1/2", async () => {
    const { computeEmbedBackoffMs } = await import("./embedder.js");
    expect(computeEmbedBackoffMs(0)).toBe(1000);
    expect(computeEmbedBackoffMs(1)).toBe(2000);
    expect(computeEmbedBackoffMs(2)).toBe(4000);
  });

  it("retries up to 3 total attempts before throwing", async () => {
    // STRICT_LOCAL default = true → no OpenAI fallback, so Ollama errors bubble up.
    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      attempts++;
      return Promise.reject(new Error("simulated network error"));
    });
    vi.stubGlobal("fetch", mockFetch);

    // Patch setTimeout to fire synchronously so we don't actually wait 1s+2s.
    const realSetTimeout = globalThis.setTimeout;
    const fastSetTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;
    vi.stubGlobal("setTimeout", fastSetTimeout);

    const { embed } = await import("./embedder.js");

    await expect(embed("test text")).rejects.toThrow();

    // Only count calls to the ollama endpoint (exclude any other fetches).
    const ollamaCalls = mockFetch.mock.calls.filter((c: any) =>
      String(c[0]).includes("/api/embeddings")
    );
    expect(ollamaCalls.length).toBe(3);
    expect(attempts).toBe(3);
  });
});
