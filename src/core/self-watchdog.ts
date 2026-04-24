/**
 * Event-loop watchdog. Measures `setImmediate` turnaround to detect when
 * the event loop is pinned (hot loop, sync CPU-bound work, etc).
 *
 * Opt-in via `ENGRAM_CPU_WATCHDOG_MS` env var — see README.
 */

export interface WatchdogOptions {
  thresholdMs: number;
  onLag: (lagMs: number) => void;
}

export interface WatchdogInstance {
  stop(): void;
}

/**
 * Start the watchdog. Runs `setImmediate` → measure turnaround → sleep 250ms → repeat.
 * Reports lag when the measured turnaround exceeds `thresholdMs`.
 */
export function startEventLoopWatchdog(opts: WatchdogOptions): WatchdogInstance {
  let stopped = false;

  function tick(): void {
    if (stopped) return;
    const t0 = Date.now();
    setImmediate(() => {
      if (stopped) return;
      const lag = Date.now() - t0;
      if (lag > opts.thresholdMs) {
        opts.onLag(lag);
      }
      setTimeout(tick, 250).unref?.();
    });
  }

  tick();

  return {
    stop() {
      stopped = true;
    },
  };
}
