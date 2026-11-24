import { getMasterState } from "@/lib/upstox/instruments";
import { ensureSessionLoaded } from "@/lib/upstox/session";

/**
 * Cold-start warm-up.
 *
 * The first scan after a process start previously had to download and parse the
 * full Upstox instrument master (3.7 MB gzipped, ~137,000 rows) inside the request
 * path, which alone accounted for ~3.4 s of the first-scan latency. Warm it once at
 * boot so the first user scan finds it cached.
 *
 * This runs on the first API request rather than at import time, so it does not slow
 * server startup or break the health check.
 */

const globalForWarmup = globalThis as typeof globalThis & {
  __deWarmupStarted?: boolean;
  __deWarmupDone?: Promise<void> | null;
};

export function warmCache(): Promise<void> {
  if (globalForWarmup.__deWarmupDone) return globalForWarmup.__deWarmupDone;
  if (globalForWarmup.__deWarmupStarted) return Promise.resolve();
  globalForWarmup.__deWarmupStarted = true;

  globalForWarmup.__deWarmupDone = (async () => {
    const started = Date.now();
    try {
      // Restore a persisted session into this process (encrypted store), if any.
      await ensureSessionLoaded();
      // Download + parse the instrument master so subsequent scans are instant.
      await getMasterState();
      console.log(`[warmup] instrument master ready in ${Date.now() - started}ms`);
    } catch (err) {
      console.warn(`[warmup] instrument master warm-up failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  return globalForWarmup.__deWarmupDone;
}
