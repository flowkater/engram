import { describe, it, expect } from "vitest";
import { limitResponseText } from "./response-limit.js";

describe("limitResponseText", () => {
  it("returns original text when under limit", () => {
    const text = "hello world";
    expect(limitResponseText(text, 1024)).toBe(text);
  });

  it("truncates text that exceeds limit and appends notice", () => {
    const text = "a".repeat(100_000);
    const limited = limitResponseText(text, 1024);
    expect(new TextEncoder().encode(limited).byteLength).toBeLessThanOrEqual(1024);
    expect(limited).toMatch(/truncated by engram/);
    expect(limited.startsWith("a")).toBe(true);
  });

  it("uses default 64KB limit when no maxBytes passed", () => {
    const text = "b".repeat(100_000);
    const limited = limitResponseText(text);
    expect(new TextEncoder().encode(limited).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(limited).toMatch(/truncated by engram/);
  });

  it("cuts at UTF-8 safe boundary (does not produce invalid multi-byte sequence)", () => {
    const text = "😀".repeat(10_000);
    const limited = limitResponseText(text, 256);
    // Should not throw when decoded back
    const bytes = new TextEncoder().encode(limited);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(decoded).toBeTypeOf("string");
  });
});
