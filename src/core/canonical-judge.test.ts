import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("canonical judge", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.ENGRAM_CANONICAL_JUDGE_MODEL;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("parses approved fact output", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          action: "approve",
          canonicalKind: "fact",
          title: "Auth uses JWT",
          content: "Authentication uses JWT access tokens.",
          confidence: 0.91,
          rationale: "Clear factual statement with direct evidence.",
        }),
      }),
    });

    const { judgeCanonicalCandidate } = await import("./canonical-judge.js");

    const result = await judgeCanonicalCandidate(
      {
        id: "cand-1",
        scope: "todait-backend",
        candidateKind: "fact",
        candidateTitle: "Auth uses JWT",
        candidateContent: "Authentication uses JWT access tokens.",
      },
      [],
      { request }
    );

    expect(result).toEqual({
      action: "approve",
      canonicalKind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      confidence: 0.91,
      rationale: "Clear factual statement with direct evidence.",
    });
  });

  it("parses approved decision output and preserves a valid matched canonical id", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          action: "approve",
          canonicalKind: "decision",
          title: "JWT rollout approved",
          content: "The team decided to roll out JWT auth in production.",
          confidence: 0.88,
          rationale: "Explicit decision language and existing canonical match.",
          matchedCanonicalId: "canon-1",
        }),
      }),
    });

    const { judgeCanonicalCandidate } = await import("./canonical-judge.js");

    const result = await judgeCanonicalCandidate(
      {
        id: "cand-2",
        scope: "todait-backend",
        candidateKind: "decision",
        candidateTitle: "JWT rollout approved",
        candidateContent: "The team decided to roll out JWT auth in production.",
      },
      [
        {
          id: "canon-1",
          kind: "decision",
          title: "JWT rollout approved",
          content: "The team decided to roll out JWT auth in production.",
          scope: "todait-backend",
          confidence: 0.93,
          updatedAt: "2026-03-15T00:00:00.000Z",
          createdAt: "2026-03-14T00:00:00.000Z",
        },
      ],
      { request }
    );

    expect(result).toEqual({
      action: "approve",
      canonicalKind: "decision",
      title: "JWT rollout approved",
      content: "The team decided to roll out JWT auth in production.",
      confidence: 0.88,
      rationale: "Explicit decision language and existing canonical match.",
      matchedCanonicalId: "canon-1",
    });
  });

  it("parses rejected output", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          action: "reject",
          confidence: 0.16,
          rationale: "Not enough evidence to promote this note.",
        }),
      }),
    });

    const { judgeCanonicalCandidate } = await import("./canonical-judge.js");

    const result = await judgeCanonicalCandidate(
      {
        id: "cand-3",
        scope: "todait-backend",
        candidateKind: "unknown",
        candidateTitle: "Auth note",
        candidateContent: "Need to think more about auth.",
      },
      [],
      { request }
    );

    expect(result).toEqual({
      action: "reject",
      confidence: 0.16,
      rationale: "Not enough evidence to promote this note.",
    });
  });

  it("maps malformed output to retry invalid_response", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "{\"action\":\"approve\"" }),
    });

    const { judgeCanonicalCandidate } = await import("./canonical-judge.js");

    const result = await judgeCanonicalCandidate(
      {
        id: "cand-4",
        scope: "todait-backend",
        candidateKind: "fact",
        candidateTitle: "Auth uses JWT",
        candidateContent: "Authentication uses JWT access tokens.",
      },
      [],
      { request }
    );

    expect(result).toEqual({
      action: "retry",
      reason: "invalid_response",
      rationale: expect.stringContaining("Invalid judge response"),
    });
  });

  it("maps unusable approve payloads to retry invalid_response", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          action: "approve",
          canonicalKind: "fact",
          title: "   ",
          content: "",
          confidence: 4,
          rationale: "Looks good",
        }),
      }),
    });

    const { judgeCanonicalCandidate } = await import("./canonical-judge.js");

    const result = await judgeCanonicalCandidate(
      {
        id: "cand-5",
        scope: "todait-backend",
        candidateKind: "fact",
        candidateTitle: "Auth uses JWT",
        candidateContent: "Authentication uses JWT access tokens.",
      },
      [],
      { request }
    );

    expect(result).toEqual({
      action: "retry",
      reason: "invalid_response",
      rationale: expect.stringContaining("Invalid approve payload"),
    });
  });

  it("does not use remote fallback when local Ollama fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    const request = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));

    const { judgeCanonicalCandidate } = await import("./canonical-judge.js");

    const result = await judgeCanonicalCandidate(
      {
        id: "cand-6",
        scope: "todait-backend",
        candidateKind: "fact",
        candidateTitle: "Auth uses JWT",
        candidateContent: "Authentication uses JWT access tokens.",
      },
      [],
      { request }
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      action: "retry",
      reason: "connection",
      rationale: expect.stringContaining("connect ECONNREFUSED"),
    });
  });

  it("honors ENGRAM_CANONICAL_JUDGE_MODEL when set", async () => {
    process.env.ENGRAM_CANONICAL_JUDGE_MODEL = "qwen2.5:14b";

    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          action: "reject",
          confidence: 0.2,
          rationale: "Insufficient evidence",
        }),
      }),
    });

    const { judgeCanonicalCandidate } = await import("./canonical-judge.js");

    await judgeCanonicalCandidate(
      {
        id: "cand-7",
        scope: "todait-backend",
        candidateKind: "fact",
        candidateTitle: "Auth uses JWT",
        candidateContent: "Authentication uses JWT access tokens.",
      },
      [],
      { request }
    );

    const [, init] = request.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body).model).toBe("qwen2.5:14b");
  });

  it("maps timeout failures to retry timeout", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Request timed out after 30000ms"));

    const { judgeCanonicalCandidate } = await import("./canonical-judge.js");

    const result = await judgeCanonicalCandidate(
      {
        id: "cand-8",
        scope: "todait-backend",
        candidateKind: "fact",
        candidateTitle: "Auth uses JWT",
        candidateContent: "Authentication uses JWT access tokens.",
      },
      [],
      { request }
    );

    expect(result).toEqual({
      action: "retry",
      reason: "timeout",
      rationale: expect.stringContaining("Request timed out"),
    });
  });

  it("drops unknown matched canonical ids from approve results", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          action: "approve",
          canonicalKind: "fact",
          title: "Auth uses JWT",
          content: "Authentication uses JWT access tokens.",
          confidence: 0.89,
          rationale: "Factual statement",
          matchedCanonicalId: "canon-missing",
        }),
      }),
    });

    const { judgeCanonicalCandidate } = await import("./canonical-judge.js");

    const result = await judgeCanonicalCandidate(
      {
        id: "cand-9",
        scope: "todait-backend",
        candidateKind: "fact",
        candidateTitle: "Auth uses JWT",
        candidateContent: "Authentication uses JWT access tokens.",
      },
      [],
      { request }
    );

    expect(result).toEqual({
      action: "approve",
      canonicalKind: "fact",
      title: "Auth uses JWT",
      content: "Authentication uses JWT access tokens.",
      confidence: 0.89,
      rationale: "Factual statement",
    });
  });

  it("drops matched canonical ids whose kind conflicts with the approved kind", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          action: "approve",
          canonicalKind: "decision",
          title: "JWT rollout approved",
          content: "The team decided to roll out JWT auth in production.",
          confidence: 0.9,
          rationale: "Decision language",
          matchedCanonicalId: "canon-fact",
        }),
      }),
    });

    const { judgeCanonicalCandidate } = await import("./canonical-judge.js");

    const result = await judgeCanonicalCandidate(
      {
        id: "cand-10",
        scope: "todait-backend",
        candidateKind: "decision",
        candidateTitle: "JWT rollout approved",
        candidateContent: "The team decided to roll out JWT auth in production.",
      },
      [
        {
          id: "canon-fact",
          kind: "fact",
          title: "Auth uses JWT",
          content: "Authentication uses JWT access tokens.",
          scope: "todait-backend",
          confidence: 0.92,
          updatedAt: "2026-03-15T00:00:00.000Z",
          createdAt: "2026-03-14T00:00:00.000Z",
        },
      ],
      { request }
    );

    expect(result).toEqual({
      action: "approve",
      canonicalKind: "decision",
      title: "JWT rollout approved",
      content: "The team decided to roll out JWT auth in production.",
      confidence: 0.9,
      rationale: "Decision language",
    });
  });
});
