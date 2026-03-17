import { describe, expect, it, vi, beforeEach } from "vitest";

const startServerFromProcess = vi.fn().mockResolvedValue(undefined);

vi.mock("./core/server-bootstrap.js", () => ({
  startServerFromProcess,
}));

describe("server entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    startServerFromProcess.mockClear();
  });

  it("delegates to the bootstrap seam without extra import-time work", async () => {
    await import("./server.js");
    expect(startServerFromProcess).toHaveBeenCalledTimes(1);
  });
});
