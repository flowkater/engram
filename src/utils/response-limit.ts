/**
 * Cap MCP tool response text size. Prevents strict-client MCP consumers
 * (e.g. Codex CLI) from rejecting giant JSON payloads, and bounds memory
 * usage when search/graph tools return unexpectedly large result sets.
 */
const DEFAULT_RESPONSE_MAX_BYTES = 64 * 1024;
const TRUNCATION_NOTICE = "\n\n… [truncated by engram: response exceeds limit]";

/**
 * Truncate `text` so that its UTF-8 byte length does not exceed `maxBytes`.
 * Appends a truncation notice when shortened. UTF-8 safe — never produces
 * a mid-codepoint byte sequence.
 */
export function limitResponseText(text: string, maxBytes = DEFAULT_RESPONSE_MAX_BYTES): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;

  const noticeBytes = encoder.encode(TRUNCATION_NOTICE).byteLength;
  const budget = Math.max(maxBytes - noticeBytes, 0);

  // Binary search for the largest prefix that fits in `budget` bytes.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (encoder.encode(text.slice(0, mid)).byteLength <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return text.slice(0, lo) + TRUNCATION_NOTICE;
}
