import { and, desc, eq, gte } from "drizzle-orm";

import { db } from "@/db";
import { futuresSnapshot, oiSnapshot, zoneScoreHistory } from "@/db/schema";
import type { OptionChainStrike } from "@/lib/upstox/market";

/**
 * Structured persistence layer.
 *
 * WHY THIS EXISTS: the previous implementation wrapped every database call in
 * `try { ... } catch { return [] }`. That made a database outage look *identical*
 * to a genuinely empty history, so OI Intelligence reported "no snapshots yet"
 * when in fact the read had failed. Every operation here returns a structured
 * result carrying success/failure, record counts and a sanitized error, and the
 * pipeline surfaces those results to the UI and diagnostics.
 */

export type StorageOperation = "INSERT" | "SELECT" | "DELETE" | "UPDATE";

export interface StorageResult {
  ok: boolean;
  operation: StorageOperation;
  /** e.g. "oi_snapshot", "futures_snapshot", "zone_score_history" */
  table: string;
  symbol: string | null;
  expiry: string | null;
  /** Number of records written or read. */
  recordCount: number;
  error: string | null;
  durationMs: number;
  at: string;
  /** Whether this specific operation was skipped (e.g. nothing new to write). */
  skipped: boolean;
  skipReason: string | null;
}

export function okResult(args: {
  operation: StorageOperation;
  table: string;
  symbol?: string | null;
  expiry?: string | null;
  recordCount: number;
  durationMs: number;
  skipped?: boolean;
  skipReason?: string | null;
}): StorageResult {
  return {
    ok: true,
    operation: args.operation,
    table: args.table,
    symbol: args.symbol ?? null,
    expiry: args.expiry ?? null,
    recordCount: args.recordCount,
    error: null,
    durationMs: args.durationMs,
    at: new Date().toISOString(),
    skipped: args.skipped ?? false,
    skipReason: args.skipReason ?? null,
  };
}

export function errorResult(args: {
  operation: StorageOperation;
  table: string;
  symbol?: string | null;
  expiry?: string | null;
  error: unknown;
  durationMs: number;
}): StorageResult {
  return {
    ok: false,
    operation: args.operation,
    table: args.table,
    symbol: args.symbol ?? null,
    expiry: args.expiry ?? null,
    recordCount: 0,
    error: sanitizeDbError(args.error),
    durationMs: args.durationMs,
    at: new Date().toISOString(),
    skipped: false,
    skipReason: null,
  };
}

/** Strips connection strings and secrets from driver errors before surfacing them. */
export function sanitizeDbError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgres://<redacted>")
    .replace(/password=[^\s&"']+/gi, "password=<redacted>")
    .slice(0, 400);
}

/* ------------------------------------------------------------------ *
 * Contract identity + write throttling
 * ------------------------------------------------------------------ */

/** Canonical contract identity: symbol + expiry + instrument_key. */
export function contractIdentity(args: {
  symbol: string;
  expiry: string;
  instrumentKey: string;
  strike: number;
  optionType: "CE" | "PE";
}): string {
  return `${args.symbol}|${args.expiry}|${args.instrumentKey}|${args.strike}|${args.optionType}`;
}

const globalForPersistence = globalThis as typeof globalThis & {
  __dePersistState?: Map<string, { at: number; signature: string }>;
  __dePersistLog?: StorageResult[];
};

const writeState = (globalForPersistence.__dePersistState ??= new Map());
const persistLog = (globalForPersistence.__dePersistLog ??= []);

function recordLog(result: StorageResult): void {
  persistLog.push(result);
  if (persistLog.length > 200) persistLog.splice(0, persistLog.length - 200);
}

export function recentPersistenceLog(limit = 25): StorageResult[] {
  return persistLog.slice(-limit).reverse();
}

function signatureOf(strikes: OptionChainStrike[]): string {
  // Signature covers the values that matter for rolling OI/premium deltas.
  const parts: string[] = [];
  for (const s of strikes.slice(0, 60)) {
    parts.push(`${s.strike}:${s.ce.oi ?? "-"}:${s.ce.ltp ?? "-"}:${s.pe.oi ?? "-"}:${s.pe.ltp ?? "-"}`);
  }
  return parts.join(",");
}

/* ------------------------------------------------------------------ *
 * OI + premium snapshots
 * ------------------------------------------------------------------ */

export interface OiSnapshotRow {
  strike: number;
  optionType: "CE" | "PE";
  instrumentKey: string;
  oi: number | null;
  prevOi: number | null;
  volume: number | null;
  ltp: number | null;
  prevClose: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  bidQty: number | null;
  askQty: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
}

function rowsFromStrikes(
  symbol: string,
  expiry: string,
  strikes: OptionChainStrike[],
  now: number,
): (typeof oiSnapshot.$inferInsert)[] {
  const rows: (typeof oiSnapshot.$inferInsert)[] = [];
  for (const s of strikes) {
    for (const side of ["ce", "pe"] as const) {
      const leg = s[side];
      // Never write a row for a contract whose identity we cannot establish.
      if (!leg.instrumentKey) continue;
      rows.push({
        symbol,
        expiry,
        strike: s.strike,
        optionType: side === "ce" ? "CE" : "PE",
        instrumentKey: leg.instrumentKey,
        oi: leg.oi,
        prevOi: leg.prevOi,
        volume: leg.volume,
        ltp: leg.ltp,
        prevClose: leg.prevClose,
        bidPrice: leg.bidPrice,
        askPrice: leg.askPrice,
        bidQty: leg.bidQty,
        askQty: leg.askQty,
        delta: leg.delta,
        gamma: leg.gamma,
        theta: leg.theta,
        vega: leg.vega,
        iv: leg.iv,
        pop: leg.pop,
        sourceTs: new Date(now),
        receivedAt: new Date(now),
      });
    }
  }
  return rows;
}

/**
 * Persists OI + premium observations for one symbol+expiry.
 *
 * - Skipped when nothing changed, so 5m/15m deltas compare real states.
 * - A genuine change is ALWAYS written, never throttled away: losing an
 *   observation would corrupt the rolling-window comparisons.
 * - Batched inserts; a failure is REPORTED, never swallowed.
 */
export async function persistOiSnapshots(args: {
  symbol: string;
  expiry: string;
  strikes: OptionChainStrike[];
  now: number;
  force?: boolean;
}): Promise<StorageResult> {
  const { symbol, expiry, strikes, now, force } = args;
  const started = Date.now();
  const stateKey = `${symbol}|${expiry}`;
  const signature = signatureOf(strikes);
  const prior = writeState.get(stateKey);

  if (strikes.length === 0) {
    const r = okResult({ operation: "INSERT", table: "oi_snapshot", symbol, expiry, recordCount: 0, durationMs: Date.now() - started, skipped: true, skipReason: "no chain rows available" });
    recordLog(r);
    return r;
  }
  // ORDER MATTERS: a real change is always written, even inside the throttle
  // window. The throttle only suppresses repeated writes of UNCHANGED data, which
  // is what keeps 5m/15m rolling deltas meaningful without flooding the table.
  const unchanged = prior !== undefined && prior.signature === signature;
  if (!force && unchanged) {
    const r = okResult({
      operation: "INSERT",
      table: "oi_snapshot",
      symbol,
      expiry,
      recordCount: 0,
      durationMs: Date.now() - started,
      skipped: true,
      skipReason: "OI and premium values unchanged since last write",
    });
    recordLog(r);
    return r;
  }

  const rows = rowsFromStrikes(symbol, expiry, strikes, now);
  if (rows.length === 0) {
    const r = okResult({ operation: "INSERT", table: "oi_snapshot", symbol, expiry, recordCount: 0, durationMs: Date.now() - started, skipped: true, skipReason: "no rows with a resolvable instrument key" });
    recordLog(r);
    return r;
  }

  try {
    // Batch to keep individual statements small (Upstox chains can exceed 100 strikes).
    const batchSize = 400;
    for (let i = 0; i < rows.length; i += batchSize) {
      await db.insert(oiSnapshot).values(rows.slice(i, i + batchSize));
    }
    writeState.set(stateKey, { at: now, signature });
    const r = okResult({ operation: "INSERT", table: "oi_snapshot", symbol, expiry, recordCount: rows.length, durationMs: Date.now() - started });
    recordLog(r);
    return r;
  } catch (err) {
    const r = errorResult({ operation: "INSERT", table: "oi_snapshot", symbol, expiry, error: err, durationMs: Date.now() - started });
    recordLog(r);
    return r;
  }
}

export interface OiHistoryPoint {
  strike: number;
  optionType: "CE" | "PE";
  instrumentKey: string;
  oi: number | null;
  prevOi: number | null;
  volume: number | null;
  ltp: number | null;
  prevClose: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  pop: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  bidQty: number | null;
  askQty: number | null;
  receivedAt: number;
}

export interface OiHistoryRead {
  ok: boolean;
  rows: OiHistoryPoint[];
  recordCount: number;
  error: string | null;
  durationMs: number;
  oldestAt: string | null;
  newestAt: string | null;
  /** Distinct capture times available in the window. */
  distinctObservations: number;
  /** Whether the window is old enough to support a 5m rolling comparison. */
  has5m: boolean;
  /** Whether the window is old enough to support a 15m rolling comparison. */
  has15m: boolean;
  /** Whether a session baseline exists. */
  hasBaseline: boolean;
  at: string;
}

/**
 * Reads OI/premium history for ONE symbol + ONE expiry. Never mixes expiries or
 * symbols. A database failure is reported in `error` and explicitly distinguished
 * from an empty result via `ok: false`.
 */
export async function loadOiHistory(args: {
  symbol: string;
  expiry: string;
  sinceMs: number;
  now: number;
}): Promise<OiHistoryRead> {
  const { symbol, expiry, sinceMs, now } = args;
  const started = Date.now();
  try {
    const rows = await db
      .select()
      .from(oiSnapshot)
      .where(and(eq(oiSnapshot.symbol, symbol), eq(oiSnapshot.expiry, expiry), gte(oiSnapshot.receivedAt, new Date(sinceMs))))
      .orderBy(desc(oiSnapshot.receivedAt))
      .limit(20000);

    const points: OiHistoryPoint[] = rows.map((r) => ({
      strike: r.strike,
      optionType: r.optionType === "CE" ? "CE" : "PE",
      instrumentKey: r.instrumentKey,
      oi: r.oi,
      prevOi: r.prevOi,
      volume: r.volume,
      ltp: r.ltp,
      prevClose: r.prevClose,
      delta: r.delta,
      gamma: r.gamma,
      theta: r.theta,
      vega: r.vega,
      iv: r.iv,
      pop: r.pop,
      bidPrice: r.bidPrice,
      askPrice: r.askPrice,
      bidQty: r.bidQty,
      askQty: r.askQty,
      receivedAt: new Date(r.receivedAt).getTime(),
    }));

    const times = [...new Set(points.map((p) => p.receivedAt))].sort((a, b) => a - b);
    const oldest = times.length > 0 ? times[0] : null;
    const newest = times.length > 0 ? times[times.length - 1] : null;

    return {
      ok: true,
      rows: points,
      recordCount: points.length,
      error: null,
      durationMs: Date.now() - started,
      oldestAt: oldest ? new Date(oldest).toISOString() : null,
      newestAt: newest ? new Date(newest).toISOString() : null,
      distinctObservations: times.length,
      // A comparison is only legitimate when an observation actually exists
      // at/inside the tolerance window used by the engine.
      has5m: times.some((t) => now - t >= 3 * 60000),
      has15m: times.some((t) => now - t >= 12 * 60000),
      hasBaseline: times.length > 0,
      at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      rows: [],
      recordCount: 0,
      error: sanitizeDbError(err),
      durationMs: Date.now() - started,
      oldestAt: null,
      newestAt: null,
      distinctObservations: 0,
      has5m: false,
      has15m: false,
      hasBaseline: false,
      at: new Date().toISOString(),
    };
  }
}

export async function countOiSnapshots(args: { symbol: string; expiry: string; sinceMs: number }): Promise<{ ok: boolean; count: number; error: string | null }> {
  try {
    const rows = await db
      .select({ id: oiSnapshot.id })
      .from(oiSnapshot)
      .where(and(eq(oiSnapshot.symbol, args.symbol), eq(oiSnapshot.expiry, args.expiry), gte(oiSnapshot.receivedAt, new Date(args.sinceMs))));
    return { ok: true, count: rows.length, error: null };
  } catch (err) {
    return { ok: false, count: 0, error: sanitizeDbError(err) };
  }
}

/* ------------------------------------------------------------------ *
 * Futures snapshots
 * ------------------------------------------------------------------ */

export interface FuturesObservation {
  ltp: number | null;
  oi: number | null;
  prevOi: number | null;
  volume: number | null;
}

/**
 * Persists a futures observation. Throttled per symbol+expiry and skipped when
 * unchanged, so a 5-minute reference snapshot always belongs to the SAME contract.
 */
export async function persistFuturesSnapshot(args: {
  symbol: string;
  expiry: string;
  instrumentKey: string;
  observation: FuturesObservation;
  spot: number | null;
  now: number;
  force?: boolean;
}): Promise<StorageResult> {
  const { symbol, expiry, instrumentKey, observation, spot, now, force } = args;
  const started = Date.now();
  const stateKey = `fut|${symbol}|${expiry}`;
  const signature = `${observation.ltp ?? "-"}:${observation.oi ?? "-"}:${observation.volume ?? "-"}`;
  const prior = writeState.get(stateKey);

  if (observation.ltp === null) {
    const r = okResult({ operation: "INSERT", table: "futures_snapshot", symbol, expiry, recordCount: 0, durationMs: Date.now() - started, skipped: true, skipReason: "no LTP to persist" });
    recordLog(r);
    return r;
  }
  // As above: a real change is always written; only identical repeats are throttled.
  if (!force && prior && prior.signature === signature) {
    const r = okResult({ operation: "INSERT", table: "futures_snapshot", symbol, expiry, recordCount: 0, durationMs: Date.now() - started, skipped: true, skipReason: "futures LTP/OI/volume unchanged" });
    recordLog(r);
    return r;
  }

  try {
    await db.insert(futuresSnapshot).values({
      symbol,
      expiry,
      instrumentKey,
      ltp: observation.ltp,
      volume: observation.volume,
      oi: observation.oi,
      prevOi: observation.prevOi,
      spot,
      sourceTs: null,
      receivedAt: new Date(now),
    });
    writeState.set(stateKey, { at: now, signature });
    const r = okResult({ operation: "INSERT", table: "futures_snapshot", symbol, expiry, recordCount: 1, durationMs: Date.now() - started });
    recordLog(r);
    return r;
  } catch (err) {
    const r = errorResult({ operation: "INSERT", table: "futures_snapshot", symbol, expiry, error: err, durationMs: Date.now() - started });
    recordLog(r);
    return r;
  }
}

export interface FuturesReference {
  ok: boolean;
  reference: { ltp: number | null; oi: number | null; prevOi: number | null; volume: number | null } | null;
  referenceAgeMinutes: number | null;
  error: string | null;
  /** Total observations available for this contract. */
  observationCount: number;
  durationMs: number;
}

/**
 * Reads the futures observation closest to ~5 minutes ago for the SAME contract
 * and expiry. A read failure is reported, never converted into "no reference".
 */
export async function loadFuturesReference(args: {
  symbol: string;
  expiry: string;
  instrumentKey: string;
  now: number;
}): Promise<FuturesReference> {
  const { symbol, expiry, instrumentKey, now } = args;
  const started = Date.now();
  try {
    const rows = await db
      .select()
      .from(futuresSnapshot)
      .where(and(eq(futuresSnapshot.symbol, symbol), eq(futuresSnapshot.expiry, expiry), eq(futuresSnapshot.instrumentKey, instrumentKey)))
      .orderBy(desc(futuresSnapshot.receivedAt))
      .limit(50);

    if (rows.length === 0) {
      return { ok: true, reference: null, referenceAgeMinutes: null, error: null, observationCount: 0, durationMs: Date.now() - started };
    }
    const target = now - 5 * 60000;
    let best: (typeof rows)[number] | null = null;
    let bestDelta = Infinity;
    for (const r of rows) {
      const d = Math.abs(new Date(r.receivedAt).getTime() - target);
      if (d < bestDelta) {
        bestDelta = d;
        best = r;
      }
    }
    // Only accept a reference close enough to be a legitimate ~5 minute comparison.
    if (!best || bestDelta > 8 * 60000) {
      return {
        ok: true,
        reference: null,
        referenceAgeMinutes: null,
        error: null,
        observationCount: rows.length,
        durationMs: Date.now() - started,
      };
    }
    return {
      ok: true,
      reference: { ltp: best.ltp, oi: best.oi, prevOi: best.prevOi, volume: best.volume },
      referenceAgeMinutes: Math.round((now - new Date(best.receivedAt).getTime()) / 60000),
      error: null,
      observationCount: rows.length,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      reference: null,
      referenceAgeMinutes: null,
      error: sanitizeDbError(err),
      observationCount: 0,
      durationMs: Date.now() - started,
    };
  }
}

export async function countFuturesSnapshots(args: { symbol: string; expiry: string }): Promise<{ ok: boolean; count: number; error: string | null }> {
  try {
    const rows = await db
      .select({ id: futuresSnapshot.id })
      .from(futuresSnapshot)
      .where(and(eq(futuresSnapshot.symbol, args.symbol), eq(futuresSnapshot.expiry, args.expiry)));
    return { ok: true, count: rows.length, error: null };
  } catch (err) {
    return { ok: false, count: 0, error: sanitizeDbError(err) };
  }
}

/* ------------------------------------------------------------------ *
 * Zone score history
 * ------------------------------------------------------------------ */

export async function loadZoneScoreHistory(zoneIds: string[]): Promise<{ ok: boolean; history: Record<string, Array<{ t: number; score: number }>>; error: string | null; recordCount: number }> {
  if (zoneIds.length === 0) return { ok: true, history: {}, error: null, recordCount: 0 };
  const started = Date.now();
  try {
    const rows = await db
      .select()
      .from(zoneScoreHistory)
      .where(gte(zoneScoreHistory.capturedAt, new Date(Date.now() - 3 * 3600000)))
      .orderBy(desc(zoneScoreHistory.capturedAt))
      .limit(3000);
    const out: Record<string, Array<{ t: number; score: number }>> = {};
    let used = 0;
    for (const r of rows) {
      if (!zoneIds.includes(r.zoneId)) continue;
      (out[r.zoneId] ??= []).push({ t: new Date(r.capturedAt).getTime(), score: r.score });
      used += 1;
    }
    for (const id of Object.keys(out)) out[id] = out[id].reverse();
    void started;
    return { ok: true, history: out, error: null, recordCount: used };
  } catch (err) {
    return { ok: false, history: {}, error: sanitizeDbError(err), recordCount: 0 };
  }
}

export function clearPersistenceState(): void {
  writeState.clear();
  persistLog.length = 0;
}
