import { describe, expect, it } from "vitest";
import { resolveBackgroundJobConfig } from "./runtime-leases.js";
import { resolveBackgroundRuntime } from "./background-runtime.js";

describe("background runtime", () => {
  it("disables background work when background jobs are disabled", () => {
    const runtime = resolveBackgroundRuntime({
      ENGRAM_ENABLE_BACKGROUND_JOBS: "false",
    });

    expect(runtime.enabled).toBe(false);
    expect(runtime.backgroundConfig.backgroundEnabled).toBe(false);
  });

  it("enables candidate-only background mode when background jobs are on", () => {
    const env = {
      ENGRAM_ENABLE_BACKGROUND_JOBS: "true",
      ENGRAM_ENABLE_DIFF_SCAN: "false",
      ENGRAM_ENABLE_WATCHER: "false",
      ENGRAM_ENABLE_SCHEDULER: "false",
    };

    const runtime = resolveBackgroundRuntime(env);

    expect(runtime.enabled).toBe(true);
    expect(runtime.backgroundConfig).toEqual(resolveBackgroundJobConfig(env));
    expect(runtime.backgroundConfig).toEqual({
      backgroundEnabled: true,
      diffScanEnabled: false,
      watcherEnabled: false,
      schedulerEnabled: false,
    });
  });
});
