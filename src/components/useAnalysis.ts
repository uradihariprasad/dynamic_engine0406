"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisSnapshot } from "@/lib/engine/types";

export type SnapshotMap = Record<string, AnalysisSnapshot | null>;

/** Auto-scan interval: 30 seconds (configurable via NEXT_PUBLIC_POLL_MS). */
export const SCAN_INTERVAL_MS = Number(process.env.NEXT_PUBLIC_POLL_MS ?? 30000);

/**
 * Per-request timeout. Without this a slow first scan would hang the UI with no
 * feedback at all, which is indistinguishable from a broken connection.
 */
const FETCH_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_FETCH_TIMEOUT_MS ?? 25000);

export interface ScanState {
  /** Timestamp of the last completed scan. */
  lastScanAt: number | null;
  /** True while a scan is in flight. */
  scanning: boolean;
  /** Seconds until the next automatic scan (-1 when auto-scan is off). */
  secondsUntilNext: number;
  /** Whether the automatic scan cycle is enabled. */
  autoScan: boolean;
  /** Number of scans completed in this session. */
  scanCount: number;
  /** True on the first scan of a session, when cold caches make it slower. */
  coldStart: boolean;
  /** Elapsed seconds of the in-flight scan, for user feedback. */
  elapsedSeconds: number;
}

export interface UseAnalysisResult {
  snapshots: SnapshotMap;
  errors: Record<string, string>;
  loading: boolean;
  lastRefresh: number | null;
  /** Triggers a scan immediately and restarts the auto-scan countdown. */
  scanNow: () => Promise<void>;
  /** Toggles the automatic 30-second scan cycle. */
  setAutoScan: (enabled: boolean) => void;
  scan: ScanState;
}

/**
 * Shared analysis scanner.
 *
 * Auto-scans every SCAN_INTERVAL_MS and supports manual triggering. Invariants:
 *  - an in-flight scan is never duplicated;
 *  - a manual scan cancels the pending timer and restarts the countdown afterwards,
 *    so manual and automatic scans can never pile up on top of each other;
 *  - all timers are cleared on unmount.
 */
export function useAnalysis(symbolKeys: string[], timeframe: string, sessionVersion?: number): UseAnalysisResult {
  // `symbolKeys` must be stable: an inline array literal would recreate the effect
  // on every render and cause an unbounded fetch loop.
  const symbols = useMemo(() => symbolKeys.join(","), [symbolKeys]);
  const symbolList = useMemo(() => symbols.split(",").filter(Boolean), [symbols]);

  const [snapshots, setSnapshots] = useState<SnapshotMap>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [secondsUntilNext, setSecondsUntilNext] = useState(Math.round(SCAN_INTERVAL_MS / 1000));
  const [autoScan, setAutoScanState] = useState(true);
  const [scanCount, setScanCount] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const inFlight = useRef(false);
  const mounted = useRef(true);
  const cycleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextScanAt = useRef<number>(Date.now() + SCAN_INTERVAL_MS);
  const autoScanRef = useRef(true);
  const runCycleRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchOnce = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setScanning(true);
    setElapsedSeconds(0);
    const nextErrors: Record<string, string> = {};
    try {
      const results = await Promise.all(
        symbolList.map(async (s) => {
          try {
            const res = await fetch(`/api/analysis/${s}?timeframe=${timeframe}`, {
              cache: "no-store",
              // AbortSignal.timeout fails the request visibly rather than hanging forever.
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            const json = (await res.json()) as { ok: boolean; snapshot?: AnalysisSnapshot; error?: string };
            if (!json.ok) {
              nextErrors[s] = json.error ?? `HTTP ${res.status}`;
              return [s, null] as const;
            }
            return [s, json.snapshot ?? null] as const;
          } catch (err) {
            const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
            nextErrors[s] = isTimeout
              ? `Scan timed out after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s — the server was still fetching Upstox data. Retrying on the next cycle.`
              : err instanceof Error
                ? err.message
                : "fetch failed";
            return [s, null] as const;
          }
        }),
      );
      if (!mounted.current) return;
      const next: SnapshotMap = {};
      for (const [s, snap] of results) next[s] = snap;
      setSnapshots((prev) => ({ ...prev, ...next }));
      setErrors(nextErrors);
      setLastRefresh(Date.now());
      setScanCount((c) => c + 1);
    } finally {
      inFlight.current = false;
      nextScanAt.current = Date.now() + SCAN_INTERVAL_MS;
      setSecondsUntilNext(Math.round(SCAN_INTERVAL_MS / 1000));
      if (mounted.current) {
        setLoading(false);
        setScanning(false);
      }
    }
  }, [symbolList, timeframe]);

  /** One cycle: fetch, then schedule the next cycle while auto-scan is enabled. */
  const runCycle = useCallback(async (): Promise<void> => {
    await fetchOnce();
    if (!mounted.current || !autoScanRef.current) return;
    if (cycleTimer.current) clearTimeout(cycleTimer.current);
    cycleTimer.current = setTimeout(() => {
      void runCycleRef.current?.();
    }, SCAN_INTERVAL_MS);
  }, [fetchOnce]);
  runCycleRef.current = runCycle;

  /** Manual scan: cancel the pending cycle, scan now, then restart the countdown. */
  const scanNow = useCallback(async (): Promise<void> => {
    if (cycleTimer.current) {
      clearTimeout(cycleTimer.current);
      cycleTimer.current = null;
    }
    await fetchOnce();
    if (!mounted.current) return;
    if (autoScanRef.current) {
      cycleTimer.current = setTimeout(() => {
        void runCycleRef.current?.();
      }, SCAN_INTERVAL_MS);
    }
  }, [fetchOnce]);

  const setAutoScan = useCallback((enabled: boolean) => {
    autoScanRef.current = enabled;
    setAutoScanState(enabled);
    if (cycleTimer.current) {
      clearTimeout(cycleTimer.current);
      cycleTimer.current = null;
    }
    if (enabled) {
      nextScanAt.current = Date.now() + SCAN_INTERVAL_MS;
      setSecondsUntilNext(Math.round(SCAN_INTERVAL_MS / 1000));
      cycleTimer.current = setTimeout(() => {
        void runCycleRef.current?.();
      }, SCAN_INTERVAL_MS);
    } else {
      setSecondsUntilNext(-1);
    }
  }, []);

  // Start the cycle. Re-runs when the symbol set or timeframe changes.
  useEffect(() => {
    void runCycle();
    return () => {
      if (cycleTimer.current) clearTimeout(cycleTimer.current);
    };
  }, [runCycle]);

  // 1-second tick for the countdown and the in-flight elapsed indicator. Never fetches.
  useEffect(() => {
    countdownTimer.current = setInterval(() => {
      if (inFlight.current) {
        setElapsedSeconds((e) => e + 1);
      } else if (autoScanRef.current) {
        setSecondsUntilNext(Math.max(0, Math.ceil((nextScanAt.current - Date.now()) / 1000)));
      }
    }, 1000);
    return () => {
      if (countdownTimer.current) clearInterval(countdownTimer.current);
    };
  }, []);

  // A connect/disconnect bumps sessionVersion: scan immediately rather than waiting.
  const initialVersion = useRef(sessionVersion);
  useEffect(() => {
    if (sessionVersion === undefined) return;
    if (initialVersion.current === sessionVersion) return;
    initialVersion.current = sessionVersion;
    void scanNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionVersion]);

  return {
    snapshots,
    errors,
    loading,
    lastRefresh,
    scanNow,
    setAutoScan,
    scan: {
      lastScanAt: lastRefresh,
      scanning,
      secondsUntilNext,
      autoScan,
      scanCount,
      coldStart: scanCount <= 1,
      elapsedSeconds,
    },
  };
}
