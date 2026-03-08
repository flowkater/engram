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
});
