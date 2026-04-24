import { describe, it, expect } from "vitest";
import { startEventLoopWatchdog } from "./self-watchdog.js";

describe("event loop watchdog", () => {
  it("calls onLag when event loop is pinned longer than threshold", async () => {
    const lags: number[] = [];
    const watchdog = startEventLoopWatchdog({
      thresholdMs: 50,
      onLag: (lagMs) => lags.push(lagMs),
    });

    // Block the event loop for 200ms
    const blockEnd = Date.now() + 200;
    while (Date.now() < blockEnd) { /* spin */ }

    // Allow a few watchdog cycles to observe the lag
    await new Promise((r) => setTimeout(r, 400));
    watchdog.stop();

    expect(lags.length).toBeGreaterThan(0);
    expect(lags.some((l) => l >= 50)).toBe(true);
  });

  it("does not fire during normal operation", async () => {
    const lags: number[] = [];
    const watchdog = startEventLoopWatchdog({
      thresholdMs: 500,
      onLag: (lagMs) => lags.push(lagMs),
    });

    await new Promise((r) => setTimeout(r, 300));
    watchdog.stop();

    expect(lags.length).toBe(0);
  });

  it("stop() prevents further lag reports", async () => {
    const lags: number[] = [];
    const watchdog = startEventLoopWatchdog({
      thresholdMs: 50,
      onLag: (lagMs) => lags.push(lagMs),
    });
    watchdog.stop();

    // Block after stopping
    const blockEnd = Date.now() + 200;
    while (Date.now() < blockEnd) { /* spin */ }

    expect(lags.length).toBe(0);
  });
});
