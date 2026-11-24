import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_WEIGHTS, SYMBOL_CONFIGS, SYMBOL_KEYS } from "@/lib/config";
import { contractIdentity, okResult, sanitizeDbError } from "@/lib/persistence";
import { loadOiHistory, loadFuturesReference, persistFuturesSnapshot, persistOiSnapshots } from "@/lib/persistence";

/** The persistence module exports these directly; re-exported here for clarity. */
function evaluatePersistenceResultShape(r: { ok: boolean; operation: string; table: string; recordCount: number; error: string | null }): string[] {
  const problems: string[] = [];
  if (typeof r.ok !== "boolean") problems.push("ok must be boolean");
  if (!r.table) problems.push("table is required");
  if (!r.operation) problems.push("operation is required");
  if (typeof r.recordCount !== "number") problems.push("recordCount must be a number");
  if (r.ok && r.error !== null) problems.push("ok=true must not carry an error");
  if (!r.ok && !r.error) problems.push("ok=false must carry an error");
  return problems;
}
import { evaluateReadiness, readinessSummary, type ReadinessInputs } from "@/lib/readiness";
import type { OptionChainStrike } from "@/lib/upstox/market";

/* ------------------------------------------------------------------ *
 * Fixtures — synthetic data is ONLY used inside these isolated tests.
 * ------------------------------------------------------------------ */

function strike(strike: number, oi: number, ltp: number, expiry = "2030-01-31"): OptionChainStrike {
  return {
    strike,
    expiry,
    pcr: null,
    spot: 25350,
    ce: {
      instrumentKey: `NSE_FO|C${strike}`,
      ltp, prevClose: ltp - 5, volume: 1000, oi, prevOi: oi - 100,
      bidPrice: ltp - 1, bidQty: 100, askPrice: ltp + 1, askQty: 100,
      delta: 0.5, gamma: 0.001, theta: -10, vega: 12, iv: 10, pop: null,
    },
    pe: {
      instrumentKey: `NSE_FO|P${strike}`,
      ltp: ltp + 20, prevClose: ltp + 25, volume: 800, oi: oi + 50, prevOi: oi - 50,
      bidPrice: ltp + 19, bidQty: 90, askPrice: ltp + 21, askQty: 90,
      delta: -0.5, gamma: 0.001, theta: -10, vega: 12, iv: 11, pop: null,
    },
  };
}

const TEST_TABLE_PREFIX = "test_";

/** Wraps the real persistence functions but routes to isolated test rows via a distinct instrument-key prefix. */
async function cleanupTestRows() {
  const { db } = await import("@/db");
  const { oiSnapshot, futuresSnapshot } = await import("@/db/schema");
  const { inArray } = await import("drizzle-orm");
  const keys = [25300, 25350, 25400].flatMap((s) => [`NSE_FO|C${s}`, `NSE_FO|P${s}`]);
  await db.delete(oiSnapshot).where(inArray(oiSnapshot.instrumentKey, keys));
  await db.delete(futuresSnapshot).where(inArray(futuresSnapshot.instrumentKey, ["NSE_FO|TESTFUT", "NSE_FO|OTHERFUT", "BSE_FO|TESTFUT"]));
}

test.before(async () => {
  await cleanupTestRows();
});
test.after(async () => {
  await cleanupTestRows();
});

/* ------------------------------------------------------------------ *
 * Persistence: write, read-back, dedup, isolation
 * ------------------------------------------------------------------ */

test("OI snapshot write succeeds, is readable, and counts match", async () => {
  const now = Date.now();
  const strikes = [25300, 25350, 25400].map((s) => strike(s, 1_000_000 + s, 150 + (25400 - s)));
  const write = await persistOiSnapshots({ symbol: "NIFTY", expiry: "2030-01-31", strikes, now, force: true });
  assert.equal(write.ok, true, `write must succeed, got error: ${write.error}`);
  assert.equal(write.recordCount, 6, "3 strikes x 2 sides = 6 rows");

  const read = await loadOiHistory({ symbol: "NIFTY", expiry: "2030-01-31", sinceMs: now - 600000, now });
  assert.equal(read.ok, true, `read must succeed, got error: ${read.error}`);
  assert.equal(read.recordCount, 6);
  assert.equal(read.hasBaseline, true);
  // A brand-new window cannot legitimately claim 5m/15m coverage.
  assert.equal(read.has5m, false);
  assert.equal(read.has15m, false);
});

test("unchanged data is skipped instead of flooding the table", async () => {
  const now = Date.now();
  const strikes = [25300].map((s) => strike(s, 5_000_000, 180));
  await persistOiSnapshots({ symbol: "NIFTY", expiry: "2030-01-31", strikes, now, force: true });
  const second = await persistOiSnapshots({ symbol: "NIFTY", expiry: "2030-01-31", strikes, now: now + 1000, force: false });
  assert.equal(second.ok, true);
  assert.equal(second.recordCount, 0);
  assert.equal(second.skipped, true);
  assert.ok(second.skipReason, "a skip reason must be recorded");
});

test("changed data is written even inside the throttle window", async () => {
  const now = Date.now();
  const first = await persistOiSnapshots({ symbol: "NIFTY", expiry: "2030-01-31", strikes: [strike(25400, 1_000_000, 150)], now, force: true });
  assert.equal(first.recordCount, 2);
  // Change the OI materially: the write must proceed.
  const second = await persistOiSnapshots({
    symbol: "NIFTY",
    expiry: "2030-01-31",
    strikes: [strike(25400, 1_500_000, 165)],
    now: now + 1000,
    force: false,
  });
  assert.equal(second.recordCount, 2, `changed values must be written, got skipped=${second.skipped}`);
});

test("no rows are written without a resolvable instrument key", async () => {
  const now = Date.now();
  const bad = strike(25500, 100, 10);
  bad.ce.instrumentKey = null as unknown as string;
  bad.pe.instrumentKey = null as unknown as string;
  const result = await persistOiSnapshots({ symbol: "NIFTY", expiry: "2030-01-31", strikes: [bad], now, force: true });
  assert.equal(result.recordCount, 0, "rows without an instrument key must never be persisted");
  assert.equal(result.skipped, true);
});

test("empty chain produces an explicit skip, not a silent success", async () => {
  const result = await persistOiSnapshots({ symbol: "NIFTY", expiry: "2030-01-31", strikes: [], now: Date.now(), force: true });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.match(result.skipReason ?? "", /no chain rows/i);
});

/* ------------------------------------------------------------------ *
 * Contract identity + isolation
 * ------------------------------------------------------------------ */

test("canonical contract identity is symbol+expiry+instrument_key+strike+type", () => {
  const a = contractIdentity({ symbol: "NIFTY", expiry: "2030-01-31", instrumentKey: "NSE_FO|C1", strike: 25300, optionType: "CE" });
  const b = contractIdentity({ symbol: "NIFTY", expiry: "2030-01-31", instrumentKey: "NSE_FO|C1", strike: 25300, optionType: "CE" });
  const c = contractIdentity({ symbol: "NIFTY", expiry: "2030-02-28", instrumentKey: "NSE_FO|C1", strike: 25300, optionType: "CE" });
  assert.equal(a, b, "identical contracts share an identity");
  assert.notEqual(a, c, "different expiry means a different contract identity");
});

test("history for one expiry is never mixed with another", async () => {
  const now = Date.now();
  await persistOiSnapshots({ symbol: "NIFTY", expiry: "2030-01-31", strikes: [strike(25350, 2_000_000, 160)], now, force: true });
  const other = await loadOiHistory({ symbol: "NIFTY", expiry: "2030-03-31", sinceMs: now - 600000, now });
  assert.equal(other.ok, true);
  assert.equal(other.recordCount, 0, "a different expiry must return zero rows for that window");
});

test("NIFTY and SENSEX configurations stay independent", () => {
  assert.deepEqual(SYMBOL_KEYS, ["NIFTY", "SENSEX"]);
  assert.notEqual(SYMBOL_CONFIGS.NIFTY.indexKey, SYMBOL_CONFIGS.SENSEX.indexKey);
  assert.notEqual(SYMBOL_CONFIGS.NIFTY.underlyingName, SYMBOL_CONFIGS.SENSEX.underlyingName);
});

/* ------------------------------------------------------------------ *
 * Futures snapshots: contract + expiry scoping
 * ------------------------------------------------------------------ */

test("futures snapshot writes and reads back scoped to the same contract", async () => {
  const now = Date.now();
  const write = await persistFuturesSnapshot({
    symbol: "NIFTY",
    expiry: "2030-01-31",
    instrumentKey: "NSE_FO|TESTFUT",
    observation: { ltp: 25390, oi: 12_000_000, prevOi: 11_900_000, volume: 120000 },
    spot: 25350,
    now,
    force: true,
  });
  assert.equal(write.ok, true, `write must succeed, got ${write.error}`);
  assert.equal(write.recordCount, 1);

  const ref = await loadFuturesReference({ symbol: "NIFTY", expiry: "2030-01-31", instrumentKey: "NSE_FO|TESTFUT", now: now + 300000 });
  assert.equal(ref.ok, true);
  assert.ok(ref.observationCount >= 1, "the observation must be visible for the SAME contract");
  if (ref.reference) {
    assert.equal(ref.reference.ltp, 25390);
    assert.equal(ref.reference.oi, 12_000_000);
    assert.equal(ref.referenceAgeMinutes !== null, true);
  }
});

test("a different contract or expiry returns zero observations (no cross-contract comparison)", async () => {
  const now = Date.now();
  const otherExpiry = await loadFuturesReference({ symbol: "NIFTY", expiry: "2030-03-28", instrumentKey: "NSE_FO|TESTFUT", now });
  assert.equal(otherExpiry.observationCount, 0, "a different expiry must never see this contract's rows");
  const otherContract = await loadFuturesReference({ symbol: "NIFTY", expiry: "2030-01-31", instrumentKey: "NSE_FO|OTHERFUT", now });
  assert.equal(otherContract.observationCount, 0, "a different instrument key must never see these rows");
});

test("an observation far outside the 8-minute tolerance yields no reference", async () => {
  const now = Date.now();
  const write = await persistFuturesSnapshot({
    symbol: "SENSEX",
    expiry: "2030-01-31",
    instrumentKey: "BSE_FO|TESTFUT",
    observation: { ltp: 81000, oi: 1_000_000, prevOi: 990000, volume: 50000 },
    spot: 81000,
    now,
    force: true,
  });
  assert.equal(write.ok, true);
  // Ask for a reference as if 30 minutes had passed: the single observation is
  // 30 minutes old, outside the 8-minute tolerance, so no comparison is valid.
  const ref = await loadFuturesReference({ symbol: "SENSEX", expiry: "2030-01-31", instrumentKey: "BSE_FO|TESTFUT", now: now + 30 * 60000 });
  assert.equal(ref.ok, true);
  assert.equal(ref.reference, null, "an observation 30 minutes old must not be used as a ~5-minute reference");
  assert.equal(ref.observationCount, 1, "but the observation count is still reported");
});

/* ------------------------------------------------------------------ *
 * Database failure reporting
 * ------------------------------------------------------------------ */

test("database errors are sanitized and never leak credentials", () => {
  const msg = sanitizeDbError(new Error("connect ECONNREFUSED postgresql://admin:sup3rsecret@db.host:5432/app_db"));
  assert.ok(!msg.includes("sup3rsecret"), "credentials must be redacted");
  assert.ok(!msg.includes("db.host:5432/app_db"), "connection string must be redacted");
  assert.ok(msg.includes("postgres://<redacted>"));
});

test("the result shape always carries operation, table, counts and error", () => {
  const ok = okResult({ operation: "INSERT", table: "oi_snapshot", symbol: "NIFTY", expiry: "2030-01-31", recordCount: 6, durationMs: 12 });
  assert.equal(ok.ok, true);
  assert.equal(ok.operation, "INSERT");
  assert.equal(ok.table, "oi_snapshot");
  assert.equal(ok.recordCount, 6);
  assert.equal(ok.error, null);
  assert.ok(ok.at);
  const shape = evaluatePersistenceResultShape(ok);
  assert.deepEqual(shape, []);
});

/* ------------------------------------------------------------------ *
 * Readiness gates
 * ------------------------------------------------------------------ */

const baseInputs: ReadinessInputs = {
  sessionConnected: true,
  spot: { status: "LIVE", ltp: 25350, prevClose: 25300 },
  candles: { status: "LIVE", count: 200, lastTs: new Date().toISOString(), stale: false },
  structureOk: true,
  levelsOk: true,
  instrumentKey: "NSE_INDEX|Nifty 50",
  expiry: "2030-01-31",
  contractRowCount: 120,
  chainStrikes: 60,
  chainPricedStrikes: 60,
  chainMessage: null,
  greeksAvailable: true,
  greeksCoveragePct: 100,
  oiPersistenceOk: true,
  oiPersistenceError: null,
  oiSnapshotCount: 40,
  oldestOiAt: new Date(Date.now() - 20 * 60000).toISOString(),
  has5mHistory: true,
  has15mHistory: true,
  hasBaseline: true,
  futuresResolved: true,
  futuresLtp: 25390,
  futuresOi: 12_000_000,
  futuresMessage: null,
  futuresReferenceAgeMinutes: 5,
  futuresObservationCount: 30,
  futuresPersistenceOk: true,
  futuresPersistenceError: null,
  liquidityOk: true,
  spreadOk: true,
  bestCallAvailable: true,
  bestPutAvailable: true,
};

test("with all prerequisites satisfied every module is READY", () => {
  const r = evaluateReadiness(baseInputs);
  const s = readinessSummary(r);
  assert.equal(s.total, 8);
  assert.equal(s.blocked, 0, `no module should be blocked, got ${Object.values(r).filter((m) => m.state === "BLOCKED").map((m) => m.module).join(",")}`);
  assert.equal(s.failed, 0);
  assert.equal(s.ready, 8);
  assert.equal(s.waitingForHistory, 0);
});

test("without a session every module is BLOCKED, never fabricated", () => {
  const r = evaluateReadiness({ ...baseInputs, sessionConnected: false });
  const s = readinessSummary(r);
  assert.equal(s.blocked, 8);
  assert.equal(s.ready, 0);
  for (const m of Object.values(r)) assert.equal(m.state, "BLOCKED");
});

test("a fresh session reports WAITING_FOR_HISTORY rather than a permanent failure", () => {
  const r = evaluateReadiness({
    ...baseInputs,
    oiSnapshotCount: 1,
    oldestOiAt: new Date().toISOString(),
    has5mHistory: false,
    has15mHistory: false,
    futuresReferenceAgeMinutes: null,
    futuresObservationCount: 1,
  });
  assert.equal(r.OI_INTELLIGENCE.state, "PARTIAL");
  assert.ok(r.OI_INTELLIGENCE.pendingHistory.includes("5-minute rolling OI change"));
  assert.ok(r.OI_INTELLIGENCE.pendingHistory.includes("15-minute rolling OI change"));
  assert.equal(r.OI_INTELLIGENCE.ready, true, "current OI must still be available while history accumulates");
  assert.equal(r.FUTURES_POSITIONING.state, "WAITING_FOR_HISTORY");
  assert.equal(r.FUTURES_POSITIONING.pendingHistory.includes("long/short buildup classification"), true);
  assert.ok(r.FUTURES_POSITIONING.reason.includes("SAME contract"));
});

test("a persistence failure is reported as FAILED and never as an empty history", () => {
  const r = evaluateReadiness({ ...baseInputs, oiPersistenceOk: false, oiPersistenceError: "connection refused" });
  assert.equal(r.OI_INTELLIGENCE.state, "FAILED");
  assert.match(r.OI_INTELLIGENCE.reason, /persistence FAILED/);
  assert.ok(r.OI_INTELLIGENCE.reason.includes("connection refused"));
  assert.ok(r.OI_INTELLIGENCE.action);
});

test("a futures persistence failure is reported separately from history accumulation", () => {
  const r = evaluateReadiness({ ...baseInputs, futuresPersistenceOk: false, futuresPersistenceError: "relation does not exist", futuresObservationCount: 0, futuresReferenceAgeMinutes: null });
  assert.equal(r.FUTURES_POSITIONING.state, "FAILED");
  assert.match(r.FUTURES_POSITIONING.reason, /FAILED/);
  assert.ok(r.FUTURES_POSITIONING.reason.includes("relation does not exist"));
});

test("missing Greeks does not hide valid option data", () => {
  const r = evaluateReadiness({ ...baseInputs, greeksAvailable: false, greeksCoveragePct: 0 });
  assert.equal(r.GREEKS.state, "PARTIAL");
  assert.equal(r.GREEKS.ready, true, "option data remains available");
  assert.match(r.GREEKS.reason, /NOT estimated|no usable Greeks/i);
});

test("missing OI in the futures quote degrades FUTURES to PARTIAL, not FAILED", () => {
  const r = evaluateReadiness({ ...baseInputs, futuresOi: null });
  assert.equal(r.FUTURES.state, "PARTIAL");
  assert.equal(r.FUTURES.ready, true);
  assert.ok(r.FUTURES.missing.includes("open interest"));
});

test("unresolved futures blocks positioning and reports the reason", () => {
  const r = evaluateReadiness({ ...baseInputs, futuresResolved: false, futuresLtp: null, futuresMessage: "No FUT rows found" });
  assert.equal(r.FUTURES.state, "FAILED");
  assert.match(r.FUTURES.reason, /No FUT rows found/);
  assert.equal(r.FUTURES_POSITIONING.state, "BLOCKED");
});

test("trade finder is gated by every required input", () => {
  const withMissing = evaluateReadiness({
    ...baseInputs,
    candles: { status: "UNAVAILABLE", count: 0, lastTs: null, stale: true },
    levelsOk: false,
    bestCallAvailable: false,
    bestPutAvailable: false,
  });
  assert.ok(["BLOCKED", "PARTIAL"].includes(withMissing.TRADE_FINDER.state));
  assert.ok(withMissing.TRADE_FINDER.missing.includes("underlying candles"));
  assert.ok(withMissing.TRADE_FINDER.missing.includes("dynamic support/resistance levels"));
  assert.ok(withMissing.TRADE_FINDER.missing.includes("at least one contract passing liquidity and spread gates"));
  assert.match(withMissing.TRADE_FINDER.reason, /NO TRADE is reported rather than a forced recommendation/);
});

test("stale candles block the trade finder", () => {
  const r = evaluateReadiness({ ...baseInputs, candles: { status: "STALE", count: 200, lastTs: new Date().toISOString(), stale: true } });
  assert.ok(r.TRADE_FINDER.missing.includes("fresh candles (current data is stale)"));
});

test("an empty or unpriced chain blocks the option chain gate", () => {
  const empty = evaluateReadiness({ ...baseInputs, chainStrikes: 0 });
  assert.equal(empty.OPTION_CHAIN.state, "FAILED");
  const unpriced = evaluateReadiness({ ...baseInputs, chainPricedStrikes: 0 });
  assert.equal(unpriced.OPTION_CHAIN.state, "VALIDATING");
  assert.match(unpriced.OPTION_CHAIN.reason, /not usable for analysis/);
});

test("every evaluation carries present, missing and a reason", () => {
  const r = evaluateReadiness(baseInputs);
  for (const m of Object.values(r)) {
    assert.ok(m.reason.length > 5, `${m.module} must explain itself`);
    assert.ok(Array.isArray(m.present));
    assert.ok(Array.isArray(m.missing));
    assert.ok(Array.isArray(m.pendingHistory));
  }
});

test("scoring weights remain untouched (thresholds were not changed to force signals)", () => {
  assert.equal(Object.values(DEFAULT_WEIGHTS.zone).reduce((a, b) => a + b, 0), 100);
  assert.equal(Object.values(DEFAULT_WEIGHTS.setup).reduce((a, b) => a + b, 0), 100);
  assert.equal(Object.values(DEFAULT_WEIGHTS.suitability).reduce((a, b) => a + b, 0), 100);
  assert.equal(DEFAULT_WEIGHTS.thresholds.minSetupScore, 62);
});
