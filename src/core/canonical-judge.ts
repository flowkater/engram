import {
  getCanonicalJudgeModelName,
  requestOllamaGenerate,
  type OllamaRequestFn,
} from "./ollama-client.js";

export interface JudgeCandidateInput {
  id: string;
  scope: string;
  candidateKind: "fact" | "decision" | "unknown";
  candidateTitle?: string | null;
  candidateContent: string;
}

export interface NearbyCanonicalContext {
  id: string;
  kind: "fact" | "decision";
  title: string;
  content: string;
  scope: string;
  confidence: number;
  updatedAt: string;
  createdAt: string;
}

export type JudgeResult =
  | {
      action: "approve";
      canonicalKind: "fact" | "decision";
      title: string;
      content: string;
      confidence: number;
      rationale: string;
      matchedCanonicalId?: string;
    }
  | {
      action: "reject";
      confidence: number;
      rationale: string;
      matchedCanonicalId?: string;
    }
  | {
      action: "retry";
      reason: "timeout" | "connection" | "invalid_response";
      rationale: string;
    };

export interface CanonicalJudgeOptions {
  baseUrl?: string;
  model?: string;
  request?: OllamaRequestFn;
  timeoutMs?: number;
}

interface ParsedApprovePayload {
  action: "approve";
  canonicalKind: "fact" | "decision";
  title: string;
  content: string;
  confidence: number;
  rationale: string;
  matchedCanonicalId?: string;
}

interface ParsedRejectPayload {
  action: "reject";
  confidence: number;
  rationale: string;
  matchedCanonicalId?: string;
}

type ParsedJudgePayload = ParsedApprovePayload | ParsedRejectPayload;

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function buildJudgePrompt(
  candidate: JudgeCandidateInput,
  nearbyCanonicals: NearbyCanonicalContext[]
): string {
  return [
    "You are judging whether a raw memory candidate should become a canonical memory.",
    "Return JSON only.",
    "Allowed actions: approve, reject.",
    "For approve, include canonicalKind, title, content, confidence, rationale, optional matchedCanonicalId.",
    "For reject, include confidence and rationale.",
    `Candidate scope: ${candidate.scope}`,
    `Candidate kind hint: ${candidate.candidateKind}`,
    `Candidate title: ${normalizeText(candidate.candidateTitle) || "(none)"}`,
    `Candidate content: ${normalizeText(candidate.candidateContent)}`,
    `Nearby canonicals: ${JSON.stringify(nearbyCanonicals)}`,
  ].join("\n");
}

function isValidConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function classifyRetryReason(error: Error): "timeout" | "connection" {
  return /timeout|timed out|aborted/i.test(error.message) ? "timeout" : "connection";
}

function parseJudgePayload(raw: string): ParsedJudgePayload | JudgeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      action: "retry",
      reason: "invalid_response",
      rationale: `Invalid judge response: ${(error as Error).message}`,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      action: "retry",
      reason: "invalid_response",
      rationale: "Invalid judge response: expected JSON object",
    };
  }

  const payload = parsed as Record<string, unknown>;
  if (payload.action === "reject") {
    if (!isValidConfidence(payload.confidence) || !normalizeText(String(payload.rationale ?? ""))) {
      return {
        action: "retry",
        reason: "invalid_response",
        rationale: "Invalid reject payload from judge model",
      };
    }

    return {
      action: "reject",
      confidence: payload.confidence,
      rationale: normalizeText(String(payload.rationale)),
      matchedCanonicalId:
        typeof payload.matchedCanonicalId === "string" ? payload.matchedCanonicalId : undefined,
    };
  }

  if (payload.action === "approve") {
    const canonicalKind = payload.canonicalKind;
    const title = normalizeText(typeof payload.title === "string" ? payload.title : "");
    const content = normalizeText(typeof payload.content === "string" ? payload.content : "");
    const rationale = normalizeText(typeof payload.rationale === "string" ? payload.rationale : "");

    if (
      (canonicalKind !== "fact" && canonicalKind !== "decision") ||
      !title ||
      !content ||
      !rationale ||
      !isValidConfidence(payload.confidence)
    ) {
      return {
        action: "retry",
        reason: "invalid_response",
        rationale: "Invalid approve payload from judge model",
      };
    }

    return {
      action: "approve",
      canonicalKind,
      title,
      content,
      confidence: payload.confidence,
      rationale,
      matchedCanonicalId:
        typeof payload.matchedCanonicalId === "string" ? payload.matchedCanonicalId : undefined,
    };
  }

  return {
    action: "retry",
    reason: "invalid_response",
    rationale: "Invalid judge response: unsupported action",
  };
}

function validateMatchedCanonicalId(
  result: ParsedApprovePayload | ParsedRejectPayload,
  nearbyCanonicals: NearbyCanonicalContext[]
): ParsedApprovePayload | ParsedRejectPayload {
  if (!result.matchedCanonicalId) return result;

  const matched = nearbyCanonicals.find((item) => item.id === result.matchedCanonicalId);
  if (!matched) {
    const { matchedCanonicalId: _ignored, ...rest } = result;
    return rest;
  }

  if (result.action === "approve" && matched.kind !== result.canonicalKind) {
    const { matchedCanonicalId: _ignored, ...rest } = result;
    return rest;
  }

  return result;
}

export async function judgeCanonicalCandidate(
  candidate: JudgeCandidateInput,
  nearbyCanonicals: NearbyCanonicalContext[],
  opts?: CanonicalJudgeOptions
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(candidate, nearbyCanonicals);

  try {
    const responseText = await requestOllamaGenerate(prompt, {
      baseUrl: opts?.baseUrl,
      model: getCanonicalJudgeModelName(opts?.model),
      request: opts?.request,
      timeoutMs: opts?.timeoutMs,
      format: "json",
    });

    const parsed = parseJudgePayload(responseText);
    if (parsed.action === "retry") return parsed;

    return validateMatchedCanonicalId(parsed, nearbyCanonicals);
  } catch (error) {
    const err = error as Error;
    return {
      action: "retry",
      reason: classifyRetryReason(err),
      rationale: `Local Ollama judge failed: ${err.message}`,
    };
  }
}
