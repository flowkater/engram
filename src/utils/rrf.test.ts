/**
 * Tests for RRF merge utility.
 */
import { describe, it, expect } from "vitest";
import { rrfMerge } from "./rrf.js";

describe("rrfMerge", () => {
  it("merges two ranked lists", () => {
    const list1 = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const list2 = [{ id: "b" }, { id: "a" }, { id: "d" }];

    const result = rrfMerge([list1, list2], 60, 10);

    // "a" is rank 0 in list1 and rank 1 in list2
    // "b" is rank 1 in list1 and rank 0 in list2
    // Both should have the same total RRF score → tied
    expect(result.length).toBeGreaterThanOrEqual(3);
    // "a" and "b" should both score higher than "c" and "d"
    const ids = result.map((r) => r.id);
    expect(ids.slice(0, 2).sort()).toEqual(["a", "b"]);
  });

  it("respects limit", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const result = rrfMerge([list], 60, 2);
    expect(result).toHaveLength(2);
  });

  it("handles empty lists", () => {
    const result = rrfMerge([[], []], 60, 10);
    expect(result).toHaveLength(0);
  });

  it("handles single list", () => {
    const list = [{ id: "x" }, { id: "y" }];
    const result = rrfMerge([list], 60, 10);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("x");
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });
});
