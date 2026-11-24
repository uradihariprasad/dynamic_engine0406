import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";

import { assessGreeks, buildGreeksChainContext, DELTA_PREFERENCE, GREEKS_SUITABILITY_WEIGHTS, THETA_CONVENTION, type GreeksRawLeg } from "@/lib/engine/greeks";
import {
  assessBuyerSeller,
  assessParticipation,
  assessQuotePressure,
  EXECUTED_DOMINANCE_STATUS,
  type ParticipationInput,
} from "@/lib/engine/participation";
import { contractIdentityKey } from "@/lib/engine/participation-identity";
import { assessExecutionQuality } from "@/lib/engine/options";

const NOW = 1_700_000_000_000;

function leg(overrides: Partial<GreeksRawLeg> = {}): GreeksRawLeg {
  return {
    ltp: 150,
    delta: 0.52,
    gamma: 0.0011,
    theta: -18,
    vega: 12,
    iv: 10.5,
    pop: 42,
    volume: 50000,
    oi: 1_000_000,
    bidPrice: 149.5,
    askPrice: 150.5,
    bidQty: 2000,
    askQty: 1800,
    ...overrides,
  };
}

function ctx(overrides: Partial<Parameters<typeof buildGreeksChainContext>[0]> = {}) {
  return buildGreeksChainContext({
    symbol: "NIFTY",
    expiry: "2030-01-31",
    spot: 25350,
    daysToExpiry: 7,
    legs: [
      { strike: 25300, optionType: "CE", leg: leg({ delta: 0.6, gamma: 0.0012 }) },
      { strike: 25350, optionType: "CE", leg: leg() },
      { strike: 25400, optionType: "CE", leg: leg({ delta: 0.42, gamma: 0.0010, theta: -20, iv: 11 }) },
      { strike: 25300, optionType: "PE", leg: leg({ delta: -0.4, gamma: 0.0011 }) },
      { strike: 25350, optionType: "PE", leg: leg({ delta: -0.48 }) },
    ],
    ...overrides,
  });
}

/* ================================================================== *
 * Layer A — Greeks intelligence
 * ================================================================== */

test("contract identity is canonical and includes expiry, strike, side and key", () => {
  const a = contractIdentityKey({ symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "NSE_FO|1" });
  const same = contractIdentityKey({ symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "NSE_FO|1" });
  const otherExpiry = contractIdentityKey({ symbol: "NIFTY", expiry: "2030-02-28", strike: 25350, optionType: "CE", instrumentKey: "NSE_FO|1" });
  const otherSide = contractIdentityKey({ symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "PE", instrumentKey: "NSE_FO|1" });
  assert.equal(a, same);
  assert.notEqual(a, otherExpiry, "a different expiry is a different contract");
  assert.notEqual(a, otherSide, "CE and PE are never the same identity");
});

test("delta: absolute, directional and sign validity are computed per side", () => {
  const c = ctx();
  const ce = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg(), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  const pe = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "PE", instrumentKey: "K" }, leg: leg({ delta: -0.52 }), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });

  assert.equal(ce.delta.absolute, 0.52);
  assert.equal(ce.delta.directional, 0.52, "CE directional delta is positive");
  assert.equal(ce.delta.signValid, true);
  assert.equal(pe.delta.directional, 0.52, "PE directional delta flips sign so positive = favourable");
  assert.equal(pe.delta.signValid, true, "PE delta must be negative to be valid");
});

test("delta band is a preference, not a filter — outside-band contracts are still assessed", () => {
  const c = ctx();
  const inside = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg({ delta: 0.52 }), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  const below = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25400, optionType: "CE", instrumentKey: "K" }, leg: leg({ delta: 0.25 }), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  const deep = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25300, optionType: "CE", instrumentKey: "K" }, leg: leg({ delta: 0.95 }), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });

  assert.equal(inside.delta.band, "INSIDE");
  assert.equal(below.delta.band, "BELOW");
  assert.ok(below.delta.suitability! < inside.delta.suitability!, "below-band scores lower but is not discarded");
  assert.ok(below.delta.bandReason.includes("lower premium sensitivity"), "the trade-off must be explained");
  assert.equal(deep.delta.band, "ABOVE");
  assert.ok(deep.delta.bandReason.includes("spot substitute"), "deep ITM must be explained as low-leverage");
});

test("gamma classification is NORMALIZED to comparable contracts, not a hardcoded threshold", () => {
  // The same absolute gamma must classify differently when the peer set differs.
  const lowPeerCtx = buildGreeksChainContext({ symbol: "NIFTY", expiry: "2030-01-31", spot: 25350, daysToExpiry: 7, legs: [{ strike: 25350, optionType: "CE", leg: leg({ gamma: 0.0004 }) }] });
  const highPeerCtx = buildGreeksChainContext({ symbol: "NIFTY", expiry: "2030-01-31", spot: 25350, daysToExpiry: 7, legs: [{ strike: 25350, optionType: "CE", leg: leg({ gamma: 0.004 }) }] });
  const subject = leg({ gamma: 0.0011 });

  const vsLow = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: subject, history: [], ctx: lowPeerCtx, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  const vsHigh = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: subject, history: [], ctx: highPeerCtx, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });

  assert.equal(vsLow.gamma.classification, "EXTREME", "2.75× a low peer median is extreme");
  assert.equal(vsHigh.gamma.classification, "LOW", "0.275× a high peer median is low");
  assert.notEqual(vsLow.gamma.classification, vsHigh.gamma.classification, "classification must be relative, never absolute");
});

test("gamma delta-acceleration is expressed per 1% underlying move", () => {
  const c = ctx();
  const g = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg({ gamma: 0.0011 }), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  assert.equal(g.gamma.deltaAccelerationPerPct, 0.28, "0.0011 × 1% of 25350, rounded to 2dp");
});

test("gamma expiry-adjusted risk escalates near expiry", () => {
  const near = ctx({ daysToExpiry: 1 });
  const far = ctx({ daysToExpiry: 30 });
  const l = leg({ gamma: 0.0035 });
  const nearG = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: l, history: [], ctx: near, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  const farG = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: l, history: [], ctx: far, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  assert.equal(nearG.gamma.expiryAdjustedRisk, "SEVERE");
  assert.notEqual(farG.gamma.expiryAdjustedRisk, "SEVERE");
});

test("theta is compared as a ratio to LTP so contracts are comparable", () => {
  const c = ctx();
  const cheap = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg({ theta: -5, ltp: 200 }), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  const severe = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg({ theta: -60, ltp: 100 }), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });

  assert.ok(cheap.theta.ratioToLtp! < 0.05);
  assert.equal(cheap.theta.classification, "CHEAP");
  assert.equal(severe.theta.classification, "SEVERE");
  assert.ok(severe.theta.ratioToLtp! > 0.2);
});

test("theta convention is documented and never assumed silently", () => {
  assert.ok(THETA_CONVENTION.length > 40);
  assert.ok(THETA_CONVENTION.includes("Upstox"));
});

test("theta projected decay scales with the holding horizon", () => {
  const c = ctx();
  const l = leg({ theta: -24 });
  const oneHour = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: l, history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW, expectedHoldMinutes: 60 });
  const fourHours = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: l, history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW, expectedHoldMinutes: 240 });
  assert.equal(oneHour.theta.projectedDecayOverHold, 1);
  assert.equal(fourHours.theta.projectedDecayOverHold, 4);
});

test("high theta is explained as a trade-off, not an automatic rejection", () => {
  const c = ctx();
  const g = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg({ theta: -60, ltp: 100 }), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  assert.ok(g.theta.reason.includes("not an automatic rejection"), "the explanation must acknowledge the trade-off");
});

test("vega/IV: expansion and contraction risks are reported separately", () => {
  const c = ctx();
  const g = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg({ vega: 12, iv: 12 }), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  assert.ok(g.vega.expansionRisk!.includes("add"));
  assert.ok(g.vega.contractionRisk!.includes("remove"));
});

test("IV percentile is unavailable without at least 10 stored observations", () => {
  const c = ctx();
  const few = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg(), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [10, 11], now: NOW });
  const enough = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg(), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: Array.from({ length: 20 }, (_, i) => 8 + i * 0.2), now: NOW });
  assert.equal(few.vega.ivPercentile, null, "percentile must not be fabricated from 2 points");
  assert.notEqual(enough.vega.ivPercentile, null);
});

test("missing Greeks are reported, never replaced by zero", () => {
  const c = ctx();
  const g = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg({ delta: null, gamma: null, theta: null, vega: null, iv: null }), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  assert.equal(g.quality, "UNAVAILABLE");
  assert.equal(g.suitabilityScore, null);
  assert.equal(g.suitabilityClass, "INSUFFICIENT DATA");
  assert.deepEqual(g.missing.sort(), ["delta", "gamma", "iv", "theta", "vega"]);
  assert.equal(g.delta.absolute, null);
});

test("partial Greeks keep the available ones and score INSUFFICIENT DATA below 40% coverage", () => {
  const c = ctx();
  const g = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg({ gamma: null, theta: null, vega: null, iv: null }), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  assert.equal(g.quality, "PARTIAL");
  assert.ok(g.present.includes("delta"));
  assert.equal(g.suitabilityClass, "INSUFFICIENT DATA");
  assert.ok(g.suitabilityScore === null || g.suitabilityScore < 60, "a partially-scored contract must not outrank a fully-scored one");
});

test("Greeks suitability weights sum to 100 and are separate from other scores", () => {
  assert.equal(Object.values(GREEKS_SUITABILITY_WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test("extreme gamma reduces the suitability score rather than increasing it", () => {
  const c = ctx();
  const moderate = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg({ gamma: 0.0011 }), history: [], ctx: c, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  // Force an EXTREME classification by using peers with much lower gamma.
  const lowPeerCtx = buildGreeksChainContext({ symbol: "NIFTY", expiry: "2030-01-31", spot: 25350, daysToExpiry: 1, legs: [{ strike: 25350, optionType: "CE", leg: leg({ gamma: 0.0003 }) }] });
  const extreme = assessGreeks({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, leg: leg({ gamma: 0.0011 }), history: [], ctx: lowPeerCtx, peerAbsDeltas: [0.52], ivHistory: [], now: NOW });
  assert.equal(extreme.gamma.classification, "EXTREME");
  assert.ok(extreme.suitabilityScore! < moderate.suitabilityScore!, "never select the highest gamma automatically");
});

/* ================================================================== *
 * Layer B — participation patterns
 * ================================================================== */

function participationInput(overrides: Partial<ParticipationInput> = {}): ParticipationInput {
  return {
    identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" },
    ltp: 150,
    prevClose: 145,
    volume: 50000,
    oi: 1_000_000,
    prevOi: 950_000,
    iv: 10.5,
    ivChange: null,
    bidPrice: 149.5,
    askPrice: 150.5,
    bidQty: 2000,
    askQty: 1800,
    relativeVolume: 2,
    premiumChange1m: 1,
    premiumChange5m: 4,
    premiumChange15m: 6,
    oiChange5m: 20000,
    oiChange15m: 40000,
    oiSessionChange: 50000,
    ...overrides,
  };
}

test("premium up + OI up = long buildup pattern, with source named", () => {
  const r = assessParticipation(participationInput());
  assert.equal(r.pattern, "LONG_BUILDUP_PATTERN");
  assert.equal(r.premiumDirection, "RISING");
  assert.equal(r.oiDirection, "RISING");
  assert.equal(r.premiumBasis.window, "5m", "the rolling window must be stated");
  assert.ok(r.premiumBasis.source.includes("persisted premium observations"), "the evidence source must be named");
  assert.equal(r.volumeConfirms, true);
  assert.equal(r.confidence, "HIGH");
});

test("premium down + OI up = short buildup pattern (writing pattern, not proven writing)", () => {
  const r = assessParticipation(participationInput({ premiumChange5m: -4, prevClose: 155 }));
  assert.equal(r.pattern, "SHORT_BUILDUP_PATTERN");
  assert.ok(r.interpretation.includes("does not prove writing"));
});

test("premium up + OI down = short covering pattern", () => {
  const r = assessParticipation(participationInput({ oiChange5m: -20000, oiSessionChange: -50000 }));
  assert.equal(r.pattern, "SHORT_COVERING_PATTERN");
});

test("premium down + OI down = long unwinding pattern", () => {
  const r = assessParticipation(participationInput({ premiumChange5m: -4, prevClose: 155, oiChange5m: -20000, oiSessionChange: -50000 }));
  assert.equal(r.pattern, "LONG_UNWINDING_PATTERN");
});

test("a single observation is never classified", () => {
  const r = assessParticipation(
    participationInput({
      premiumChange1m: null, premiumChange5m: null, premiumChange15m: null,
      oiChange5m: null, oiChange15m: null, oiSessionChange: null,
      prevClose: null, prevOi: null,
    }),
  );
  assert.equal(r.pattern, "INCONCLUSIVE", "one snapshot alone can never be classified");
  assert.equal(r.confidence, "INSUFFICIENT");
  assert.ok(r.missing.includes("premium change"));
});

test("flat premium or flat OI yields LOW confidence, not a pattern claim", () => {
  const r = assessParticipation(participationInput({ premiumChange5m: 0, prevClose: 150 }));
  assert.equal(r.confidence, "LOW");
});

test("unconfirmed volume degrades confidence", () => {
  const confirmed = assessParticipation(participationInput());
  const unconfirmed = assessParticipation(participationInput({ relativeVolume: 0.5 }));
  assert.ok(unconfirmed.confidence !== "HIGH" || confirmed.confidence !== "HIGH");
  assert.ok(unconfirmed.interpretation.includes("not confirmed"));
});

test("every participation result carries the aggregate-only caveat", () => {
  const r = assessParticipation(participationInput());
  assert.ok(r.caveat.includes("does not identify which participant type initiated"));
  assert.ok(r.caveat.includes("not proof of option writing"));
});

/* ================================================================== *
 * Layer B2 — buyer/seller participation labels
 * ================================================================== */

test("CE long buildup + bullish underlying + positive delta = CALL_BUYER_PARTICIPATION", () => {
  const p = assessParticipation(participationInput());
  const r = assessBuyerSeller({ input: participationInput(), participation: p, delta: 0.52, spotDirection: "BULLISH", spot: 25350 });
  assert.equal(r.label, "CALL_BUYER_PARTICIPATION");
  assert.equal(r.deltaAlignment, true);
  assert.equal(r.confidence, "HIGH");
});

test("PE long buildup + bearish underlying + negative delta = PUT_BUYER_PARTICIPATION", () => {
  const input = participationInput({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25300, optionType: "PE", instrumentKey: "K" } });
  const p = assessParticipation(input);
  const r = assessBuyerSeller({ input, participation: p, delta: -0.52, spotDirection: "BEARISH", spot: 25350 });
  assert.equal(r.label, "PUT_BUYER_PARTICIPATION");
});

test("CE long buildup against a bearish underlying is MIXED, not a buyer label", () => {
  const input = participationInput();
  const p = assessParticipation(input);
  const r = assessBuyerSeller({ input, participation: p, delta: 0.52, spotDirection: "BEARISH", spot: 25350 });
  assert.equal(r.label, "MIXED_PARTICIPATION");
  assert.equal(r.deltaAlignment, false);
});

test("CE short buildup is labelled a writer pattern, never proven buyer dominance", () => {
  const input = participationInput({ premiumChange5m: -4, prevClose: 155 });
  const p = assessParticipation(input);
  const r = assessBuyerSeller({ input, participation: p, delta: 0.52, spotDirection: "BULLISH", spot: 25350 });
  assert.equal(r.label, "CALL_WRITER_SHORT_BUILDUP_PATTERN");
});

test("strike location is classified relative to spot", () => {
  const p = assessParticipation(participationInput());
  const itm = assessBuyerSeller({ input: participationInput({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25200, optionType: "CE", instrumentKey: "K" } }), participation: p, delta: 0.7, spotDirection: "BULLISH", spot: 25350 });
  const otm = assessBuyerSeller({ input: participationInput({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25500, optionType: "CE", instrumentKey: "K" } }), participation: p, delta: 0.3, spotDirection: "BULLISH", spot: 25350 });
  assert.equal(itm.strikeLocation, "ITM");
  assert.equal(otm.strikeLocation, "OTM");
});

test("no pattern at all yields INSUFFICIENT_EVIDENCE", () => {
  const input = participationInput({
    premiumChange1m: null, premiumChange5m: null, premiumChange15m: null,
    oiChange5m: null, oiChange15m: null, oiSessionChange: null,
    prevClose: null, prevOi: null,
  });
  const p = assessParticipation(input);
  const r = assessBuyerSeller({ input, participation: p, delta: null, spotDirection: "UNAVAILABLE", spot: null });
  assert.equal(r.label, "INSUFFICIENT_EVIDENCE");
  assert.equal(r.confidence, "INSUFFICIENT");
});

test("a pattern without delta cannot be labelled a buyer or a seller", () => {
  const input = participationInput();
  const p = assessParticipation(input);
  const r = assessBuyerSeller({ input, participation: p, delta: null, spotDirection: "BULLISH", spot: 25350 });
  assert.equal(r.label, "MIXED_PARTICIPATION", "delta alignment is mandatory for a buyer-side claim");
  assert.ok(r.missing.includes("delta"));
});

/* ================================================================== *
 * Layer C — displayed quote pressure
 * ================================================================== */

test("bid-heavy displayed quantities produce BID_SIDE_HEAVY with ratios", () => {
  const r = assessQuotePressure({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, bidPrice: 149.5, askPrice: 150.5, bidQty: 8000, askQty: 2000, history: [], now: NOW });
  assert.equal(r.label, "BID_SIDE_HEAVY");
  assert.equal(r.bidSideRatio! > 0.5, true);
  assert.equal(r.askSideRatio! < 0.5, true);
  assert.ok(r.interpretation.includes("bid side"));
  assert.ok(r.caveat.includes("not executed trades"));
});

test("ask-heavy quantities produce ASK_SIDE_HEAVY", () => {
  const r = assessQuotePressure({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, bidPrice: 149.5, askPrice: 150.5, bidQty: 1000, askQty: 9000, history: [], now: NOW });
  assert.equal(r.label, "ASK_SIDE_HEAVY");
});

test("near-equal quantities are BALANCED, not one-sided", () => {
  const r = assessQuotePressure({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, bidPrice: 149.5, askPrice: 150.5, bidQty: 1900, askQty: 2100, history: [], now: NOW });
  assert.equal(r.label, "BALANCED");
});

test("prices without quantities produce spread/mid but never an imbalance", () => {
  const r = assessQuotePressure({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, bidPrice: 149.5, askPrice: 150.5, bidQty: null, askQty: null, history: [], now: NOW });
  assert.equal(r.spread, 1);
  assert.equal(r.mid, 150);
  assert.equal(r.imbalance, null, "an imbalance must never be manufactured from prices alone");
  assert.equal(r.quantitiesAvailable, false);
  assert.ok(r.interpretation.includes("cannot be computed"));
});

test("imbalance change and quote stability require stored observations", () => {
  const history = Array.from({ length: 6 }, (_, i) => ({
    receivedAt: NOW - (6 - i) * 60000,
    bidPrice: 149.5,
    askPrice: 150.5,
    bidQty: 8000,
    askQty: 2000,
  }));
  const r = assessQuotePressure({ identity: { symbol: "NIFTY", expiry: "2030-01-31", strike: 25350, optionType: "CE", instrumentKey: "K" }, bidPrice: 149.5, askPrice: 150.5, bidQty: 8000, askQty: 2000, history, now: NOW });
  assert.equal(r.observationCount, 6);
  assert.notEqual(r.quoteStability, null, "stability is computable from stable history");
  assert.equal(r.quoteStability, 1, "identical quotes are perfectly stable");
});

/* ================================================================== *
 * Layer D — executed dominance is never fabricated
 * ================================================================== */

test("executed buyer/seller dominance is explicitly NOT AVAILABLE", () => {
  assert.equal(EXECUTED_DOMINANCE_STATUS, "NOT AVAILABLE FROM CURRENT DATA SOURCE");
});

/* ================================================================== *
 * Score C — execution quality
 * ================================================================== */

function execLeg(overrides: Partial<Parameters<typeof assessExecutionQuality>[0]> = {}): Parameters<typeof assessExecutionQuality>[0] {
  return {
    optionType: "CE",
    instrumentKey: "K",
    ltp: 150,
    prevClose: 145,
    premiumChange: 5,
    premiumChangePct: 3.4,
    volume: 50000,
    oi: 1_000_000,
    prevOi: 950_000,
    sessionOiChange: 50000,
    changeInOi: 20000,
    bidPrice: 149.5,
    askPrice: 150.5,
    bidQty: 2000,
    askQty: 1800,
    spread: 1,
    spreadPct: 0.67,
    mid: 150,
    delta: 0.52,
    gamma: 0.0011,
    theta: -18,
    vega: 12,
    iv: 10.5,
    relativeVolume: 2,
    momentumScore: 70,
    participationRead: "x",
    tradingSymbol: "NIFTY-CE",
    lotSize: 75,
    quotePressure: { label: "BALANCED", bidPrice: 149.5, askPrice: 150.5, bidQty: 2000, askQty: 1800, spread: 1, spreadPct: 0.67, mid: 150, imbalance: 0.05, bidSideRatio: 0.53, askSideRatio: 0.47, quantitiesAvailable: true, changeFromHistory: null, quoteStability: 1, observationCount: 4, interpretation: "x", caveat: "x" },
    ...overrides,
  } as Parameters<typeof assessExecutionQuality>[0];
}

test("execution quality rewards liquidity and penalises wide spreads", () => {
  const good = assessExecutionQuality(execLeg(), NOW);
  const wide = assessExecutionQuality(execLeg({ spreadPct: 4 }), NOW);
  const thin = assessExecutionQuality(execLeg({ volume: 100 }), NOW);
  assert.ok(good.score! > 60);
  assert.ok(wide.score! < good.score!, "wide spread must score lower");
  assert.ok(thin.disqualifications.some((d) => d.includes("below the")));
});

test("illiquid or wide-spread contracts are disqualified outright", () => {
  const thin = assessExecutionQuality(execLeg({ volume: 100 }), NOW);
  const wide = assessExecutionQuality(execLeg({ spreadPct: 4 }), NOW);
  assert.ok(thin.disqualifications.length > 0);
  assert.ok(wide.disqualifications.length > 0);
  assert.equal(thin.tradable, false);
  assert.equal(wide.tradable, false);
});

test("missing volume is reported rather than treated as zero liquidity", () => {
  const r = assessExecutionQuality(execLeg({ volume: null }), NOW);
  assert.ok(r.disqualifications.some((d) => d.includes("Volume unavailable")));
});

test("execution coverage degrades when quantities are absent", () => {
  const withQty = assessExecutionQuality(execLeg(), NOW);
  // Removing quote pressure also removes the freshness input, so two of five
  // weighted components become unavailable.
  const noQty = assessExecutionQuality(execLeg({ quotePressure: undefined }), NOW);
  assert.ok(noQty.coverage! < withQty.coverage!, `missing quantity evidence must reduce coverage (with=${withQty.coverage}, without=${noQty.coverage})`);
});

test("DELTA_PREFERENCE band matches the specification", () => {
  assert.deepEqual(DELTA_PREFERENCE, { minAbs: 0.4, maxAbs: 0.65, ideal: 0.52 });
});
