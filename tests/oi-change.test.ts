import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOiIntelligence,
  changePct,
  classifyOiParticipation,
  identityFor,
  measureContractOi,
  scoreOiParticipation,
  MAX_OBSERVATION_AGE_MS,
  WINDOW_TOLERANCE_MS,
} from "@/lib/engine/ochange";
import type { OiHistoryPoint } from "@/lib/persistence";

const NOW = 1_700_000_000_000;
const EXPIRY = "2030-01-31";
const MIN = 60_000;

/** Builds a stored observation for one contract. */
function obs(strike: number, side: "CE" | "PE", oi: number, minutesAgo: number, extras: Partial<OiHistoryPoint> = {}): OiHistoryPoint {
  return {
    strike,
    optionType: side,
    instrumentKey: `NSE_FO|${side}${strike}`,
    oi,
    prevOi: null,
    volume: 10000,
    ltp: 150,
    prevClose: null,
    delta: 0.52,
    gamma: 0.0011,
    theta: -18,
    vega: 12,
    iv: 10.5,
    pop: null,
    bidPrice: 149.5,
    askPrice: 150.5,
    bidQty: 2000,
    askQty: 1800,
    receivedAt: NOW - minutesAgo * MIN,
    ...extras,
  };
}

function chainRow(strike: number, ceOi: number, peOi: number, cePrevOi: number | null, pePrevOi: number | null) {
  return {
    strike,
    ce: { oi: ceOi, prevOi: cePrevOi, sourceChange: cePrevOi !== null ? ceOi - cePrevOi : null, volume: 50000, ltp: 150, prevClose: 145, premiumChange5m: 4, premiumChange15m: 6, relativeVolume: 2, instrumentKey: `NSE_FO|CE${strike}` },
    pe: { oi: peOi, prevOi: pePrevOi, sourceChange: pePrevOi !== null ? peOi - pePrevOi : null, volume: 40000, ltp: 120, prevClose: 125, premiumChange5m: -3, premiumChange15m: -5, relativeVolume: 1.8, instrumentKey: `NSE_FO|PE${strike}` },
  };
}

/* ------------------------------------------------------------------ *
 * B. OI change calculations
 * ------------------------------------------------------------------ */

test("change in OI = current − previous, and % returns null when the denominator is zero", () => {
  assert.equal(changePct(50000, 1000000), 5);
  assert.equal(changePct(-50000, 1000000), -5);
  assert.equal(changePct(50000, 0), null, "zero denominator must yield unavailable, never a percentage");
  assert.equal(changePct(50000, null), null);
  assert.equal(changePct(null, 1000000), null);
});

test("current OI, previous-session OI and change are computed separately", () => {
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_050_000, prevOi: 1_000_000, sourceChange: 50_000 },
    history: [obs(25350, "CE", 1_000_000, 10)],
    now: NOW,
  });
  assert.equal(m.currentOi, 1_050_000, "current total OI is an absolute level");
  assert.equal(m.previousSessionOi, 1_000_000);
  assert.equal(m.changeInOi, 50_000);
  assert.equal(m.changeInOiPct, 5);
  assert.equal(m.sourceProvidedChange, 50_000);
  assert.equal(m.hasSourceProvidedChange, true);
});

test("missing prev_oi yields an unavailable change, never zero", () => {
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_050_000, prevOi: null, sourceChange: null },
    history: [obs(25350, "CE", 1_000_000, 10)],
    now: NOW,
  });
  assert.equal(m.changeInOi, null);
  assert.equal(m.changeInOiPct, null);
  assert.ok(m.unavailableReasons.some((r) => r.includes("prev_oi")));
});

test("5-minute rolling change uses the observation closest to 5 minutes ago", () => {
  const history = [
    obs(25350, "CE", 1_010_000, 4),
    obs(25350, "CE", 1_000_000, 5), // exactly 5 minutes old — the correct reference
    obs(25350, "CE", 1_020_000, 1),
  ];
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_050_000, prevOi: null, sourceChange: null },
    history, now: NOW,
  });
  assert.equal(m.windows.m5.availability, "AVAILABLE");
  assert.equal(m.windows.m5.change, 50_000, "current 1,050,000 − the exactly-5-minute reference 1,000,000");
  assert.equal(m.windows.m5.referenceOi, 1_000_000);
  assert.equal(m.windows.m5.ageMinutes, 5);
});

test("15-minute rolling change is computed independently of the 5-minute window", () => {
  const history = [
    obs(25350, "CE", 900_000, 15),
    obs(25350, "CE", 1_000_000, 5),
  ];
  // The 15-minute window references the 15-minute-old observation (900,000), while the
  // 5-minute window references the 5-minute-old one (1,000,000) — two distinct baselines.
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_050_000, prevOi: null, sourceChange: null },
    history, now: NOW,
  });
  assert.equal(m.windows.m15.change, 150_000, "current 1,050,000 − the 15-minute reference 900,000");
  assert.equal(m.windows.m15.referenceOi, 900_000);
  assert.equal(m.windows.m5.change, 50_000);
  assert.notEqual(m.windows.m15.change, m.windows.m5.change, "the two windows are distinct measurements");
});

test("1-minute rolling change is available when an observation exists at that offset", () => {
  const history = [obs(25350, "CE", 1_040_000, 1)];
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_050_000, prevOi: null, sourceChange: null },
    history, now: NOW,
  });
  assert.equal(m.windows.m1.availability, "AVAILABLE");
  assert.equal(m.windows.m1.change, 10_000);
});

test("insufficient history reports WAITING_FOR_HISTORY rather than fabricating a value", () => {
  // Only a 1-minute-old observation exists: no 5m or 15m reference is possible.
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_050_000, prevOi: null, sourceChange: null },
    history: [obs(25350, "CE", 1_000_000, 1)],
    now: NOW,
  });
  assert.equal(m.windows.m1.availability, "AVAILABLE");
  assert.equal(m.windows.m5.availability, "WAITING_FOR_HISTORY");
  assert.equal(m.windows.m15.availability, "WAITING_FOR_HISTORY");
  assert.equal(m.windows.m5.change, null);
  assert.equal(m.windows.m15.change, null);
  assert.ok(m.unavailableReasons.some((r) => r.startsWith("5-minute: waiting for history")));
});

test("an observation outside the window tolerance is rejected, not silently used", () => {
  // 8 minutes old is outside the ±2min tolerance for the 5-minute window.
  const history = [obs(25350, "CE", 900_000, 8)];
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_050_000, prevOi: null, sourceChange: null },
    history, now: NOW,
  });
  assert.equal(m.windows.m5.change, null, "an 8-minute-old reference must not stand in for 5 minutes");
  assert.notEqual(m.windows.m5.availability, "AVAILABLE");
});

test("a stale observation beyond the maximum age is rejected", () => {
  const ancient = obs(25350, "CE", 800_000, Math.ceil(MAX_OBSERVATION_AGE_MS / MIN) + 30);
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_050_000, prevOi: null, sourceChange: null },
    history: [ancient],
    now: NOW,
  });
  assert.equal(m.windows.m5.change, null, "a stale reference must never be used");
  assert.equal(m.stale, true);
});

test("session cumulative change = current − valid session baseline, and combined OI reconstructs", () => {
  const baseline = obs(25350, "CE", 1_000_000, 30);
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_070_000, prevOi: null, sourceChange: null },
    history: [baseline, obs(25350, "CE", 1_040_000, 10)],
    now: NOW,
  });
  assert.equal(m.sessionCumulativeChange, 70_000);
  assert.equal(m.sessionBaselineOi, 1_000_000);
  assert.equal(m.combinedTotalOi, 1_070_000, "baseline + cumulative change reconstructs current OI");
});

test("source-provided change is never confused with a rolling change", () => {
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_050_000, prevOi: 1_000_000, sourceChange: 50_000 },
    history: [obs(25350, "CE", 1_000_000, 30), obs(25350, "CE", 1_020_000, 5)],
    now: NOW,
  });
  assert.equal(m.hasSourceProvidedChange, true);
  assert.equal(m.sourceProvidedChange, 50_000);
  assert.equal(m.windows.m5.change, 30_000, "the rolling value is a different measurement");
  assert.notEqual(m.sourceProvidedChange, m.windows.m5.change);
  assert.equal(m.changeInOi, 50_000);
});

/* ------------------------------------------------------------------ *
 * A/C. Contract identity and expiry isolation
 * ------------------------------------------------------------------ */

test("contract identity includes expiry, strike, side and instrument key", () => {
  const a = identityFor({ underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE", instrumentKey: "NSE_FO|1" });
  const b = identityFor({ underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE", instrumentKey: "NSE_FO|1" });
  const otherExpiry = identityFor({ underlying: "NIFTY", expiry: "2030-02-28", strike: 25350, optionType: "CE", instrumentKey: "NSE_FO|1" });
  const otherSide = identityFor({ underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "PE", instrumentKey: "NSE_FO|1" });
  const otherStrike = identityFor({ underlying: "NIFTY", expiry: EXPIRY, strike: 25400, optionType: "CE", instrumentKey: "NSE_FO|1" });
  const otherKey = identityFor({ underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE", instrumentKey: "NSE_FO|2" });
  assert.equal(a, b, "identical contracts share an identity");
  assert.notEqual(a, otherExpiry, "a different expiry is a different contract");
  assert.notEqual(a, otherSide, "CE and PE are never the same identity");
  assert.notEqual(a, otherStrike);
  assert.notEqual(a, otherKey);
});

test("NIFTY and SENSEX are isolated because each chain uses its own rows and history", () => {
  // The contract-scoped identity deliberately excludes the underlying: a single ΔOI
  // computation is always for ONE underlying, and the caller supplies that underlying's
  // own chain rows and observation history. Isolation is asserted end-to-end below.
  const nifty = buildOiIntelligence({
    underlying: "NIFTY", expiry: EXPIRY, spot: 25350, atmStrike: 25350,
    strikes: [chainRow(25350, 1_000_000, 1_200_000, 1_000_000, 1_200_000)],
    history: [obs(25350, "CE", 1_000_000, 5), obs(25350, "PE", 1_200_000, 5)],
    now: NOW,
  });
  const sensex = buildOiIntelligence({
    underlying: "SENSEX", expiry: EXPIRY, spot: 81000, atmStrike: 81000,
    strikes: [chainRow(81000, 500_000, 700_000, 500_000, 700_000)],
    history: [obs(81000, "CE", 500_000, 5), obs(81000, "PE", 700_000, 5)],
    now: NOW,
  });
  assert.notEqual(nifty.totalCeOi, sensex.totalCeOi, "no cross-underlying data leakage");
  assert.notEqual(nifty.pcr, sensex.pcr, `${nifty.pcr} vs ${sensex.pcr}`);
  assert.ok(nifty.rows.every((r) => r.ce.underlying === "NIFTY"));
  assert.ok(sensex.rows.every((r) => r.ce.underlying === "SENSEX"));
  // A SENSEX strike must never see a NIFTY observation.
  assert.equal(sensex.rows[0].ce.observationCount, 1);
});

test("observations from a different strike never feed a rolling comparison", () => {
  const history = [
    obs(25350, "CE", 1_000_000, 5), // correct contract
    obs(25400, "CE", 2_000_000, 5), // different strike, same side and time
    obs(25350, "PE", 3_000_000, 5), // same strike, different side
  ];
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_050_000, prevOi: null, sourceChange: null },
    history, now: NOW,
  });
  assert.equal(m.windows.m5.referenceOi, 1_000_000, "only the matching contract's observation may be used");
  assert.equal(m.windows.m5.change, 50_000);
  assert.equal(m.observationCount, 1, "the identity gate excludes other contracts");
});

test("NIFTY and SENSEX chains produce fully independent intelligence", () => {
  const nifty = buildOiIntelligence({
    underlying: "NIFTY", expiry: EXPIRY, spot: 25350, atmStrike: 25350,
    strikes: [chainRow(25350, 1_000_000, 1_200_000, 1_000_000, 1_200_000)],
    history: [obs(25350, "CE", 1_000_000, 5), obs(25350, "PE", 1_200_000, 5)],
    now: NOW,
  });
  const sensex = buildOiIntelligence({
    underlying: "SENSEX", expiry: EXPIRY, spot: 81000, atmStrike: 81000,
    strikes: [chainRow(81000, 500_000, 700_000, 500_000, 700_000)],
    history: [obs(81000, "CE", 500_000, 5), obs(81000, "PE", 700_000, 5)],
    now: NOW,
  });
  assert.notEqual(nifty.totalCeOi, sensex.totalCeOi);
  assert.notEqual(nifty.pcr, sensex.pcr);
  assert.ok(nifty.rows.every((r) => r.ce.underlying === "NIFTY"));
  assert.ok(sensex.rows.every((r) => r.ce.underlying === "SENSEX"));
});

/* ------------------------------------------------------------------ *
 * C. Duplicate prevention and persistence behaviour
 * ------------------------------------------------------------------ */

test("duplicate observations at the same timestamp do not double the observation count", () => {
  const history = [obs(25350, "CE", 1_000_000, 5), obs(25350, "CE", 1_000_000, 5)];
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_050_000, prevOi: null, sourceChange: null },
    history, now: NOW,
  });
  assert.equal(m.windows.m5.change, 50_000, "a duplicate reference must not double the delta");
});

test("observations with null OI are excluded from rolling comparisons", () => {
  const history = [obs(25350, "CE", null as unknown as number, 5)];
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_050_000, prevOi: null, sourceChange: null },
    history, now: NOW,
  });
  assert.equal(m.windows.m5.change, null, "a null OI reference cannot produce a change");
});

/* ------------------------------------------------------------------ *
 * D. Participation classification
 * ------------------------------------------------------------------ */

function partInput(overrides: Partial<Parameters<typeof classifyOiParticipation>[0]> = {}) {
  return {
    optionType: "CE" as const,
    strike: 25350,
    ltp: 150,
    prevClose: 145,
    oi: 1_050_000,
    oiChange: 50_000,
    oiChangePct: 5,
    oiWindow: "5m",
    oiSource: "persisted OI observations",
    volume: 50000,
    relativeVolume: 2,
    premiumChange5m: 4,
    premiumChange15m: 6,
    now: NOW,
    ...overrides,
  };
}

test("premium rising + OI rising = long buildup pattern", () => {
  const r = classifyOiParticipation(partInput());
  assert.equal(r.pattern, "LONG_BUILDUP_PATTERN");
  assert.equal(r.oiDirection, "RISING");
  assert.equal(r.confidence, "HIGH");
});

test("premium falling + OI rising = short buildup pattern", () => {
  const r = classifyOiParticipation(partInput({ premiumChange5m: -4, prevClose: 155 }));
  assert.equal(r.pattern, "SHORT_BUILDUP_PATTERN");
  assert.ok(r.interpretation.length > 10);
});

test("premium rising + OI falling = short covering pattern", () => {
  const r = classifyOiParticipation(partInput({ oiChange: -50_000, oiChangePct: -5 }));
  assert.equal(r.pattern, "SHORT_COVERING_PATTERN");
});

test("premium falling + OI falling = long unwinding pattern", () => {
  const r = classifyOiParticipation(partInput({ premiumChange5m: -4, prevClose: 155, oiChange: -50_000, oiChangePct: -5 }));
  assert.equal(r.pattern, "LONG_UNWINDING_PATTERN");
});

test("OI alone is never classified — premium is required", () => {
  const r = classifyOiParticipation(partInput({ premiumChange5m: null, premiumChange15m: null, prevClose: null }));
  assert.equal(r.pattern, "INCONCLUSIVE");
  assert.equal(r.confidence, "INSUFFICIENT");
  assert.ok(r.missing.includes("premium change"));
});

test("OI magnitude is derived from the percentage, not the absolute change", () => {
  const large = classifyOiParticipation(partInput({ oiChange: 100_000, oiChangePct: 10 }));
  const small = classifyOiParticipation(partInput({ oiChange: 10_000, oiChangePct: 0.5 }));
  assert.equal(large.oiMagnitude, "LARGE");
  assert.equal(small.oiMagnitude, "SMALL");
});

test("the OI basis names its window and source", () => {
  const r = classifyOiParticipation(partInput());
  assert.equal(r.oiBasis.window, "5m");
  assert.equal(r.oiBasis.source, "persisted OI observations");
});

test("every result carries the aggregate-pattern caveat", () => {
  const r = classifyOiParticipation(partInput());
  assert.ok(r.caveat.includes("does not identify which participant type initiated"));
});

/* ------------------------------------------------------------------ *
 * E. Strike-wise intelligence and clusters
 * ------------------------------------------------------------------ */

function buildChain(rows: Array<ReturnType<typeof chainRow>>, history: OiHistoryPoint[], atm: number, spot = 25350) {
  return buildOiIntelligence({
    underlying: "NIFTY", expiry: EXPIRY, spot, atmStrike: atm,
    strikes: rows, history, now: NOW,
  });
}

test("strike-wise rows expose CE and PE OI, change, %, 5m, 15m and session values", () => {
  const history = [obs(25350, "CE", 1_000_000, 5), obs(25350, "PE", 1_200_000, 5)];
  const oi = buildChain([chainRow(25350, 1_050_000, 1_180_000, 1_000_000, 1_200_000)], history, 25350);
  assert.equal(oi.rows.length, 1);
  const r = oi.rows[0];
  assert.equal(r.ce.currentOi, 1_050_000);
  assert.equal(r.ce.changeInOi, 50_000);
  assert.equal(r.ce.changeInOiPct, 5);
  assert.equal(r.ce.windows.m5.change, 50_000);
  assert.equal(r.pe.currentOi, 1_180_000);
  assert.equal(r.pe.changeInOi, -20_000);
  assert.equal(r.pe.changeInOiPct, -1.67, "PE ΔOI % = −20,000 / 1,200,000 × 100, rounded");
  assert.equal(r.isAtm, true);
  assert.ok(r.strikePcr !== null, "strike PCR is computable from the current OI levels");
});

test("PCR is computed from current OI levels and a PCR change is measured against the baseline", () => {
  const history = [obs(25350, "CE", 1_000_000, 30), obs(25350, "PE", 1_000_000, 30), obs(25350, "CE", 1_000_000, 5), obs(25350, "PE", 1_500_000, 5)];
  const oi = buildChain([chainRow(25350, 1_000_000, 1_500_000, 1_000_000, 1_000_000)], history, 25350);
  assert.equal(oi.pcr, 1.5);
  assert.notEqual(oi.pcrChange, null, "a positioning shift vs the session baseline is measurable");
});

test("highest OI strikes are ranked across both sides", () => {
  const history = [obs(25300, "CE", 500_000, 5), obs(25400, "PE", 2_000_000, 5)];
  const oi = buildChain([chainRow(25300, 500_000, 900_000, 500_000, 900_000), chainRow(25400, 700_000, 2_000_000, 700_000, 2_000_000)], history, 25350);
  assert.equal(oi.highestOiStrikes[0].side, "PE");
  assert.equal(oi.highestOiStrikes[0].strike, 25400);
  assert.ok(oi.highestOiStrikes.length >= 2);
});

test("CE-only buildup is labelled a CE cluster with an explicit non-confirmation caveat", () => {
  const history = [
    obs(25350, "CE", 1_000_000, 5), obs(25350, "PE", 1_000_000, 5),
    obs(25400, "CE", 500_000, 5), obs(25400, "PE", 500_000, 5),
  ];
  // CE 25400 gains 20% while PE 25400 is flat.
  const oi = buildChain([chainRow(25300, 1_000_000, 1_000_000, 1_000_000, 1_000_000), chainRow(25400, 600_000, 500_000, 500_000, 500_000)], history, 25300);
  const row = oi.rows.find((r) => r.strike === 25400)!;
  assert.equal(row.cluster, "CE_BUILDUP_CLUSTER");
  assert.ok(row.clusterReason.includes("Not confirmed resistance without price action"));
});

test("PE-only buildup is labelled a PE cluster and is never called confirmed support", () => {
  const history = [obs(25350, "CE", 1_000_000, 5), obs(25350, "PE", 1_000_000, 5)];
  const oi = buildChain([chainRow(25350, 1_000_000, 1_300_000, 1_000_000, 1_000_000)], history, 25350);
  assert.equal(oi.rows[0].cluster, "PE_BUILDUP_CLUSTER");
  assert.ok(oi.rows[0].clusterReason.includes("Not confirmed support without price action"));
});

test("both sides rising is BALANCED, not a one-sided claim", () => {
  const history = [obs(25350, "CE", 1_000_000, 5), obs(25350, "PE", 1_000_000, 5)];
  const oi = buildChain([chainRow(25350, 1_200_000, 1_300_000, 1_000_000, 1_000_000)], history, 25350);
  assert.equal(oi.rows[0].cluster, "BALANCED");
  assert.ok(oi.rows[0].clusterReason.includes("two-sided participation"));
});

test("a strike below the magnitude threshold produces NO_SIGNAL, not a cluster", () => {
  const history = [obs(25350, "CE", 1_000_000, 5), obs(25350, "PE", 1_000_000, 5)];
  const oi = buildChain([chainRow(25350, 1_005_000, 1_000_000, 1_000_000, 1_000_000)], history, 25350);
  assert.equal(oi.rows[0].cluster, "NO_SIGNAL");
});

test("largest additions and reductions are ranked from the finest available window", () => {
  const history = [obs(25300, "CE", 500_000, 5), obs(25400, "PE", 2_000_000, 5), obs(25450, "CE", 400_000, 5)];
  const oi = buildChain(
    [chainRow(25300, 800_000, 900_000, 500_000, 900_000), chainRow(25400, 700_000, 1_500_000, 700_000, 2_000_000), chainRow(25450, 350_000, 400_000, 400_000, 400_000)],
    history,
    25350,
  );
  assert.equal(oi.largestAdditions[0].window, "m5", "rankings use the finest window with data");
  assert.ok(oi.largestAdditions.some((a) => a.change > 0));
  assert.ok(oi.largestReductions.some((a) => a.change < 0));
});

test("the chain summary states its own availability rather than claiming LIVE prematurely", () => {
  const fresh = buildChain([chainRow(25350, 1_050_000, 1_180_000, 1_000_000, 1_200_000)], [obs(25350, "CE", 1_000_000, 1), obs(25350, "PE", 1_200_000, 1)], 25350);
  assert.equal(fresh.status, "WAITING_FOR_HISTORY", "no 5m reference exists after only 1 minute of data");
  assert.ok(fresh.unavailableReasons.length > 0, `expected pending windows, got ${JSON.stringify(fresh.unavailableReasons)}`);
  assert.equal(fresh.windows.m5, "WAITING_FOR_HISTORY");

  // 30m + 5m observations make the 5m and session windows AVAILABLE, while the 1m and
  // 15m windows remain pending because no observation sits within their tolerances.
  const ready = buildChain([chainRow(25350, 1_050_000, 1_180_000, 1_000_000, 1_200_000)], [obs(25350, "CE", 1_000_000, 30), obs(25350, "PE", 1_200_000, 30), obs(25350, "CE", 1_020_000, 5), obs(25350, "PE", 1_190_000, 5)], 25350);
  assert.equal(ready.status, "LIVE", `got ${ready.status}: ${JSON.stringify(ready.unavailableReasons)}`);
  assert.equal(ready.windows.m5, "AVAILABLE");
  assert.equal(ready.windows.session, "AVAILABLE");
  assert.equal(ready.windows.m1, "INSUFFICIENT_DATA", "no observation sits within ±45s of 1 minute ago");
  assert.equal(ready.windows.m15, "INSUFFICIENT_DATA", "no observation sits within ±4min of 15 minutes ago");
  assert.ok(ready.unavailableReasons.length > 0, "pending windows are still disclosed");
});

test("the price-confirmation note is always present", () => {
  const oi = buildChain([chainRow(25350, 1_050_000, 1_180_000, 1_000_000, 1_200_000)], [], 25350);
  assert.ok(oi.priceConfirmationNote.includes("NOT confirmed support"));
  assert.ok(oi.priceConfirmationNote.includes("NOT confirmed resistance"));
});

/* ------------------------------------------------------------------ *
 * F/H. OI participation score for the Best Strike Finder
 * ------------------------------------------------------------------ */

test("OI participation score is null when no measurement exists", () => {
  const r = scoreOiParticipation({ optionType: "CE", measurement: null, participation: null, underlyingDirection: "BULLISH" });
  assert.equal(r.score, null);
  assert.equal(r.alignment, "UNAVAILABLE");
  assert.ok(r.reasons[0].includes("not measurable"));
});

test("rising OI on the aligned side scores highest and is SUPPORTIVE", () => {
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_100_000, prevOi: null, sourceChange: null },
    history: [obs(25350, "CE", 1_000_000, 5)],
    now: NOW,
  });
  const p = classifyOiParticipation(partInput());
  const r = scoreOiParticipation({ optionType: "CE", measurement: m, participation: p, underlyingDirection: "BULLISH" });
  assert.notEqual(r.score, null);
  assert.equal(r.alignment, "SUPPORTIVE");
  assert.ok(r.score! >= 65);
  assert.ok(r.reasons.some((x) => x.includes("fresh participation")));
});

test("falling OI with falling premium scores low and is CONTRADICTORY for a BUY", () => {
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 900_000, prevOi: null, sourceChange: null },
    history: [obs(25350, "CE", 1_000_000, 5)],
    now: NOW,
  });
  const p = classifyOiParticipation(partInput({ oiChange: -100_000, oiChangePct: -10, premiumChange5m: -4, premiumChange15m: -6, prevClose: 155 }));
  const r = scoreOiParticipation({ optionType: "CE", measurement: m, participation: p, underlyingDirection: "BULLISH" });
  assert.equal(p.pattern, "LONG_UNWINDING_PATTERN", `pattern must be unwinding, got ${p.pattern}`);
  assert.equal(r.alignment, "CONTRADICTORY", `got ${r.alignment} score ${r.score}`);
  assert.ok(r.score! < 40, `score must be below 40, got ${r.score}`);
});

test("rising OI with falling premium (writing pattern) is never SUPPORTIVE for a BUY", () => {
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_200_000, prevOi: null, sourceChange: null },
    history: [obs(25350, "CE", 1_000_000, 5)],
    now: NOW,
  });
  const p = classifyOiParticipation(partInput({ premiumChange5m: -4, premiumChange15m: -6, prevClose: 155 }));
  const r = scoreOiParticipation({ optionType: "CE", measurement: m, participation: p, underlyingDirection: "BULLISH" });
  assert.equal(p.pattern, "SHORT_BUILDUP_PATTERN");
  const alignedBaseline = 100;
  // A writing pattern must NOT read as SUPPORTIVE for a BUY: rising OI alone can never
  // compensate for a collapsing premium.
  assert.notEqual(r.alignment, "SUPPORTIVE", `got ${r.alignment} score ${r.score}`);
  assert.ok(r.score! < 65, `score must be below the 65 SUPPORTIVE threshold, got ${r.score}`);
  assert.ok(r.score! < alignedBaseline, "the writing pattern must score below the aligned long-buildup baseline");
});

test("unaligned underlying direction heavily penalises the OI score", () => {
  const m = measureContractOi({
    underlying: "NIFTY", expiry: EXPIRY, strike: 25350, optionType: "CE",
    current: { oi: 1_100_000, prevOi: null, sourceChange: null },
    history: [obs(25350, "CE", 1_000_000, 5)],
    now: NOW,
  });
  const p = classifyOiParticipation(partInput());
  const aligned = scoreOiParticipation({ optionType: "CE", measurement: m, participation: p, underlyingDirection: "BULLISH" });
  const unaligned = scoreOiParticipation({ optionType: "CE", measurement: m, participation: p, underlyingDirection: "BEARISH" });
  assert.ok(unaligned.score! < aligned.score!, "an unaligned direction must score lower for a CE BUY");
  assert.ok(unaligned.reasons.some((x) => x.includes("not aligned")));
});

test("window tolerances are explicit and the staleness ceiling exceeds the widest window", () => {
  assert.equal(WINDOW_TOLERANCE_MS.m1, 45_000);
  assert.equal(WINDOW_TOLERANCE_MS.m5, 120_000);
  assert.equal(WINDOW_TOLERANCE_MS.m15, 240_000);
  // The staleness ceiling must be at least the 15-minute window plus its tolerance,
  // otherwise a legitimate 15-minute reference would be discarded as stale.
  assert.ok(
    MAX_OBSERVATION_AGE_MS >= 15 * 60_000 + WINDOW_TOLERANCE_MS.m15,
    `MAX_OBSERVATION_AGE_MS ${MAX_OBSERVATION_AGE_MS} must cover the 15m window + tolerance`,
  );
});
