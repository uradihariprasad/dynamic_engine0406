import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";

import { buildStrikeIntel, computeOiIntel, buildStrikeSelection, type OiHistoryPoint } from "@/lib/engine/options";
import { buildTradePlan, buildScenarios, type MomentumRead, type TradeInputs } from "@/lib/engine/trade";
import { DEFAULT_WEIGHTS } from "@/lib/config";
import type { ContractCandidate, OiIntel, SrLevels, Zone } from "@/lib/engine/types";

const NOW = 1_700_000_000_000;

function chainRows() {
  // Listed strikes with a 50-point gap around spot 25,800 (ATM = 25,800)
  return [25600, 25650, 25700, 25750, 25800, 25850, 25900, 25950, 26000].map((strike) => ({
    strike,
    expiry: "2026-01-29",
    pcr: null,
    spot: 25800,
    ce: {
      instrumentKey: `NSE_FO|C${strike}`,
      ltp: Math.max(5, 900 - Math.abs(strike - 25800) * 2.2),
      prevClose: Math.max(5, 860 - Math.abs(strike - 25800) * 2.2),
      volume: strike === 25800 ? 800000 : strike === 25850 ? 400000 : strike === 26000 ? 1000 : 120000,
      oi: strike === 25900 ? 4_200_000 : strike === 25800 ? 1_800_000 : 900_000,
      prevOi: strike === 25900 ? 4_100_000 : strike === 25800 ? 1_850_000 : 900_000,
      bidPrice: 1,
      bidQty: 1500,
      askPrice: 2,
      askQty: 1500,
      delta: strike === 25800 ? 0.52 : strike > 25800 ? 0.3 : 0.72,
      gamma: 0.0011,
      theta: -18,
      vega: 12,
      iv: 10.5,
      pop: null,
    },
    pe: {
      instrumentKey: `NSE_FO|P${strike}`,
      ltp: Math.max(5, 700 - Math.abs(strike - 25800) * 2.1),
      prevClose: Math.max(5, 720 - Math.abs(strike - 25800) * 2.1),
      volume: strike === 25800 ? 900000 : 150000,
      oi: strike === 25700 ? 3_900_000 : strike === 25800 ? 1_600_000 : 800_000,
      prevOi: strike === 25700 ? 3_800_000 : strike === 25800 ? 1_620_000 : 800_000,
      bidPrice: 1,
      bidQty: 2000,
      askPrice: 2,
      askQty: 1800,
      delta: strike === 25800 ? -0.48 : strike > 25800 ? -0.7 : -0.28,
      gamma: 0.0011,
      theta: -17,
      vega: 12,
      iv: 11.2,
      pop: null,
    },
  }));
}

function historyPoints(rows: ReturnType<typeof chainRows>, minutesAgo: number, factor: number): OiHistoryPoint[] {
  const points: OiHistoryPoint[] = [];
  for (const r of rows) {
    for (const side of ["ce", "pe"] as const) {
      const leg = r[side];
      points.push({
        strike: r.strike,
        optionType: side === "ce" ? "CE" : "PE",
        oi: leg.oi === null ? null : Math.round(leg.oi * factor),
        volume: leg.volume === null ? null : Math.round(leg.volume * factor),
        ltp: leg.ltp,
        delta: leg.delta,
        gamma: leg.gamma,
        theta: leg.theta,
        vega: leg.vega,
        iv: leg.iv,
        prevOi: null,
        prevClose: null,
        pop: null,
        bidPrice: leg.bidPrice,
        askPrice: leg.askPrice,
        bidQty: leg.bidQty,
        askQty: leg.askQty,
        instrumentKey: leg.instrumentKey ?? `TEST|${r.strike}${side.toUpperCase()}`,
        receivedAt: NOW - minutesAgo * 60000,
      });
    }
  }
  return points;
}

function contractMap() {
  const map = new Map<string, { tradingSymbol: string; lotSize: number | null }>();
  for (const r of chainRows()) {
    map.set(`NSE_FO|C${r.strike}`, { tradingSymbol: `NIFTY-${r.strike}-CE`, lotSize: 75 });
    map.set(`NSE_FO|P${r.strike}`, { tradingSymbol: `NIFTY-${r.strike}-PE`, lotSize: 75 });
  }
  return map;
}

test("ATM is derived from actually listed strikes and CE/PE mapping is preserved", () => {
  const rows = chainRows();
  const intel = buildStrikeIntel(rows, 25812, [], NOW, contractMap());
  const atm = intel.find((s) => s.isAtm);
  assert.ok(atm, "an ATM strike must be identified");
  assert.equal(atm!.strike, 25800);
  assert.equal(atm!.ce.optionType, "CE");
  assert.equal(atm!.pe.optionType, "PE");
  assert.equal(atm!.ce.tradingSymbol, "NIFTY-25800-CE");
  assert.equal(atm!.ce.lotSize, 75);
  assert.ok(intel.every((s) => Math.abs(s.atmDistance) >= 0));
});

test("rolling 5m / 15m OI changes and session cumulative change are computed from snapshots", () => {
  const rows = chainRows();
  const history = [...historyPoints(rows, 15, 0.9), ...historyPoints(rows, 5, 0.98), ...historyPoints(rows, 60, 0.8)];
  const oi = computeOiIntel(rows, history, NOW, true, true);
  assert.ok(oi.ce5mChange !== null && oi.ce5mChange > 0, "5m CE OI change must be positive");
  assert.ok(oi.ce15mChange !== null && oi.ce15mChange > oi.ce5mChange!, "15m change should exceed the 5m change");
  assert.ok(oi.ceSessionChange !== null && oi.ceSessionChange > oi.ce15mChange!, "session cumulative change should be the largest");
  assert.equal(oi.snapshotCount, history.length);
  assert.ok(oi.totalCeOi !== null && oi.combinedOi !== null);
  assert.ok(oi.pcr !== null);
  // current totals must never be confused with rolling changes
  assert.notEqual(oi.totalCeOi, oi.ce5mChange);
  assert.notEqual(oi.totalCeOi, oi.ceSessionChange);
});

test("OI intelligence is explicit when no snapshot history exists (no fabricated rolling changes)", () => {
  const rows = chainRows();
  const oi = computeOiIntel(rows, [], NOW, true, true);
  assert.equal(oi.status, "PARTIAL");
  assert.equal(oi.ce5mChange, null);
  assert.equal(oi.pe5mChange, null);
  assert.ok(oi.totalCeOi !== null, "current total OI is still reported");
  assert.match(oi.message, /snapshot history/i);
});

test("missing Greeks are reported as unavailable rather than simulated", () => {
  const rows = chainRows().map((r) => ({
    ...r,
    ce: { ...r.ce, delta: null, gamma: null, theta: null, vega: null, iv: null },
    pe: { ...r.pe, delta: null, gamma: null, theta: null, vega: null, iv: null },
  }));
  const intel = buildStrikeIntel(rows, 25800, [], NOW, contractMap());
  assert.equal(intel[0].ce.delta, null);
  assert.equal(intel[0].ce.iv, null);
  const selection = buildStrikeSelection({
    strikeIntel: intel,
    spot: 25800,
    expiry: "2026-01-29",
    daysToExpiry: 3,
    now: NOW,
    contractMap: contractMap(),
  });
  // A contract whose Greeks are unavailable is DISQUALIFIED, not ranked: the spec
  // requires NO TRADE when essential contract suitability cannot be assessed.
  // Liquidity alone is never sufficient to select a contract.
  assert.equal(selection.bestCall, null, "no contract should be ranked without Greeks");
  assert.equal(selection.bestPut, null);
  assert.ok(selection.rationale.some((r) => /NO ELIGIBLE CONTRACT/i.test(r)), "the absence must be explained");
  assert.ok(selection.rationale.join(" ").includes("Greeks unavailable"), "the reason must name the missing evidence");
});

test("best CALL and PUT candidates are ranked and alternatives are explained", () => {
  const rows = chainRows();
  const intel = buildStrikeIntel(rows, 25800, historyPoints(rows, 5, 0.95), NOW, contractMap());
  const selection = buildStrikeSelection({
    strikeIntel: intel,
    spot: 25800,
    expiry: "2026-01-29",
    daysToExpiry: 5,
    now: NOW,
    contractMap: contractMap(),
  });
  assert.ok(selection.bestCall, "a CALL candidate should be ranked");
  assert.ok(selection.bestPut, "a PUT candidate should be ranked");
  assert.equal(selection.atmStrike, 25800);
  assert.ok((selection.bestCall!.suitabilityScore ?? 0) > 0);
  assert.ok(selection.bestCall!.rejections.length > 0, "rejected alternatives must be explained");
  // The far OTM strike with tiny volume must never be selected
  assert.notEqual(selection.bestCall!.strike, 26000);
  assert.notEqual(selection.bestPut!.strike, 25600);
});

test("illiquid contracts and excessive spreads are rejected", () => {
  const rows = chainRows();
  const intel = buildStrikeIntel(rows, 25800, [], NOW, contractMap());
  const selection = buildStrikeSelection({
    strikeIntel: intel,
    spot: 25800,
    expiry: "2026-01-29",
    daysToExpiry: 5,
    now: NOW,
    contractMap: contractMap(),
  });
  const all = selection.alternatives;
  assert.ok(all.length > 0);
  for (const c of all) {
    assert.ok(
      (c.leg.volume ?? 0) >= DEFAULT_WEIGHTS.thresholds.minOptionVolume || !c.tradable,
      "low-volume contracts must not be tradable",
    );
  }
  const tinyVolume = all.find((c) => c.strike === 26000 && c.optionType === "CE");
  if (tinyVolume) assert.equal(tinyVolume.tradable, false);
});

function zoneFixture(kind: "support" | "resistance", lower: number, upper: number, overrides: Partial<Zone> = {}): Zone {
  const center = (lower + upper) / 2;
  return {
    id: `NIFTY:${kind}:${center}`,
    symbol: "NIFTY",
    kind,
    lower,
    upper,
    center,
    width: upper - lower,
    widthPct: 0.05,
    score: 72,
    prevScore: 72,
    scoreChange5m: 0,
    scoreChange15m: 0,
    classification: "STRONG",
    status: "ACTIVE",
    statusReason: "test fixture",
    tests: 4,
    createdAt: NOW - 3600000,
    lastTestedAt: NOW - 300000,
    sources: [{ kind: "SWING_LOW", price: center, timeframe: "5m", ts: NOW - 1800000, weight: 0.42, note: "fixture" }],
    evidence: {
      available: ["priceStructure", "reaction"],
      missing: ["oiConfluence", "quotes", "futures", "volumeProfile"],
      contradictory: [],
      coverage: 0.45,
      components: { priceStructure: 0.7, reaction: 0.6, volumeProfile: null, oiConfluence: null, futures: null, quotes: null, liquiditySession: 0.7 },
      sourceReliability: 0.8,
    },
    timeframeConfluence: ["5m"],
    oiOnly: false,
    scoreHistory: [],
    ...overrides,
  };
}

function levelsFixture(opts: {
  support?: Zone | null;
  primarySupport?: Zone | null;
  resistance?: Zone | null;
  primaryResistance?: Zone | null;
}): SrLevels {
  const mk = (zone: Zone | null | undefined, role: SrLevels["immediateSupport"] extends null ? never : string) =>
    zone ? ({ role, zone, distanceFromSpot: 10, reason: "fixture" } as never) : null;
  return {
    immediateSupport: opts.support === undefined ? null : mk(opts.support, "IMMEDIATE_SUPPORT"),
    primarySupport: opts.primarySupport === undefined ? null : mk(opts.primarySupport, "PRIMARY_SUPPORT"),
    immediateResistance: opts.resistance === undefined ? null : mk(opts.resistance, "IMMEDIATE_RESISTANCE"),
    primaryResistance: opts.primaryResistance === undefined ? null : mk(opts.primaryResistance, "PRIMARY_RESISTANCE"),
    unavailable: [],
  };
}

function oiFixture(overrides: Partial<OiIntel> = {}): OiIntel {
  return {
    status: "LIVE",
    message: "",
    totalCeOi: 9_000_000,
    totalPeOi: 11_000_000,
    combinedOi: 20_000_000,
    pcr: 1.22,
    pcrBasis: "test",
    ce5mChange: -120_000,
    pe5mChange: 180_000,
    ce15mChange: -260_000,
    pe15mChange: 320_000,
    ceSessionChange: -900_000,
    peSessionChange: 1_400_000,
    snapshotCount: 40,
    oldestSnapshotAt: new Date(NOW - 3600000).toISOString(),
    baselineAt: new Date(NOW - 3600000).toISOString(),
    oiClusters: [],
    additions: [],
    reductions: [],
    interpretation: [],
    greeksAvailable: true,
    bidAskQtyAvailable: true,
    ...overrides,
  };
}

function candidateFixture(optionType: "CE" | "PE", overrides: Partial<ContractCandidate> = {}): ContractCandidate {
  const strike = optionType === "CE" ? 25800 : 25750;
  return {
    strike,
    optionType,
    classification: "ATM",
    atmDistance: 0,
    leg: {
      optionType,
      instrumentKey: `NSE_FO|${optionType}25800`,
      ltp: 185,
      prevClose: 150,
      premiumChange: 35,
      premiumChangePct: optionType === "CE" ? 23.3 : -23.3,
      volume: 900_000,
      oi: 1_800_000,
      prevOi: 1_700_000,
      sessionOiChange: 100_000,
      changeInOi: 120_000,
      bidPrice: 184.5,
      askPrice: 185.5,
      bidQty: 2000,
      askQty: 1800,
      spread: 1,
      spreadPct: 0.54,
      mid: 185,
      delta: optionType === "CE" ? 0.55 : -0.55,
      gamma: 0.0011,
      theta: -18,
      vega: 12,
      iv: 10.6,
      ivChange: 0.1,
      momentumScore: 82,
      relativeVolume: 2.4,
      participationRead: "Long buildup pattern (aggregate read)",
      tradingSymbol: `NIFTY-${strike}-${optionType}`,
      lotSize: 75,
    },
    suitabilityScore: 78,
    coverage: 1,
    components: {},
    reasons: ["High delta suitability", "Strong liquidity"],
    rejections: [],
    risks: [],
    tradable: true,
    greeksSuitabilityScore: 78,
    greeksSuitabilityClass: "GOOD SUITABILITY",
    greeksCoverage: 1,
    executionQualityScore: 82,
    executionCoverage: 1,
    executionComponents: {},
    compositeScore: 80,
    oiParticipationScore: 75,
    oiParticipationAlignment: "SUPPORTIVE" as const,
    oiParticipationReasons: [],
    compositeWithOiScore: 78,
    disqualifications: [],
    ...overrides,
  };
}

function tradeInputs(overrides: {
  trend?: "BULLISH" | "BEARISH" | "SIDEWAYS" | "UNCLEAR";
  biasScore?: number;
  futuresClass?: string;
  oi?: OiIntel;
  bestCall?: ContractCandidate | null;
  bestPut?: ContractCandidate | null;
  levels?: SrLevels;
  momentum?: MomentumRead;
  chainStatus?: "LIVE" | "PARTIAL" | "UNAVAILABLE";
  spot?: number | null;
}): TradeInputs {
  const spot = overrides.spot !== undefined ? overrides.spot : 25812;
  const support = zoneFixture("support", 25766, 25774);
  const resistance = zoneFixture("resistance", 25838, 25848);
  const trend = overrides.trend ?? "BULLISH";
  return {
    spot,
    structure: {
      status: "LIVE",
      message: "",
      trend,
      htfTrend: trend === "UNCLEAR" ? "UNCLEAR" : trend,
      ltfTrend: trend,
      swingHighs: [{ ts: NOW - 900000, price: 25842, type: "HIGH", index: 5, confirmedBy: NOW - 600000 }],
      swingLows: [{ ts: NOW - 1800000, price: 25770, type: "LOW", index: 1, confirmedBy: NOW - 1500000 }],
      highs: { rising: trend === "BULLISH" ? true : trend === "BEARISH" ? false : null, label: trend === "BULLISH" ? "HH" : trend === "BEARISH" ? "LH" : "EQH" },
      lows: { rising: trend === "BULLISH" ? true : trend === "BEARISH" ? false : null, label: trend === "BULLISH" ? "HL" : trend === "BEARISH" ? "LL" : "EQL" },
      events: [],
      lastHigh: 25842,
      lastLow: 25770,
      rangeHigh: 25848,
      rangeLow: 25766,
      structureBiasScore: overrides.biasScore ?? (trend === "BULLISH" ? 72 : trend === "BEARISH" ? 28 : 50),
      explanation: [],
    },
    zones: [support, resistance],
    levels: overrides.levels ?? levelsFixture({ support, resistance }),
    futures: {
      status: overrides.futuresClass ? "LIVE" : "UNAVAILABLE",
      message: "",
      instrumentKey: "NSE_FO|NIFTYFUT",
      tradingSymbol: "NIFTY-JAN-FUT",
      expiry: "2026-01-29",
      lotSize: 75,
      ltp: spot === null ? null : spot + 12,
      spot,
      basis: 12,
      basisPct: 0.05,
      volume: 120000,
      oi: 12_000_000,
      changeInOi: overrides.futuresClass ? 150_000 : null,
      changeInOiPct: 1.3,
      priceChange: overrides.futuresClass ? 24 : null,
      volumeChange: null,
      classification: (overrides.futuresClass ?? "UNAVAILABLE") as never,
      interpretation: [],
      participation: "NOT_INFERRED",
    },
    oi: overrides.oi ?? oiFixture(),
    selection: {
      atmStrike: 25800,
      expiry: "2026-01-29",
      bestCall: overrides.bestCall === undefined ? candidateFixture("CE") : overrides.bestCall,
      bestPut: overrides.bestPut === undefined ? candidateFixture("PE") : overrides.bestPut,
    },
    momentum: overrides.momentum ?? { lastClose: spot, change5m: 22, change15m: 41, bias: "BULLISH", strength: 78 },
    atrValue: 14,
    volumeProfile: {
      status: "PARTIAL",
      message: "ESTIMATED",
      estimated: true,
      poc: 25790,
      vah: 25840,
      val: 25760,
      developingPoc: 25795,
      hvn: [25790],
      lvn: [],
      valueAreaVolumePct: 70,
      concentration: 8,
      migration: "UP",
    },
    chainStatus: overrides.chainStatus ?? "LIVE",
    greeksAvailable: true,
    bidAskQtyAvailable: true,
    candlesStatus: "LIVE",
    now: NOW,
  };
}

test("CALL BUY is recommended only when all conditions align", () => {
  const inputs = tradeInputs({});
  const plan = buildTradePlan(inputs);
  assert.equal(plan.action, "CALL_BUY");
  assert.ok((plan.setupScore ?? 0) >= DEFAULT_WEIGHTS.thresholds.minSetupScore);
  assert.ok(plan.contract !== null);
  assert.ok(plan.entryLow !== null && plan.entryHigh !== null, "entry range must be structural");
  assert.ok(plan.stopLoss !== null, "underlying stop must be provided");
  assert.ok(plan.target1 !== null && plan.target2 !== null, "targets must be provided");
  assert.ok(plan.riskReward !== null && plan.riskReward > 0);
  assert.ok(plan.entryTrigger.length > 10);
  assert.ok(plan.invalidation.length >= 3);
  assert.ok(plan.conditionsMet.length > 0);
  assert.ok(plan.stopBasis.includes("ESTIMATED") || plan.stopBasis.length > 0);
  const scenarios = buildScenarios(inputs, plan);
  assert.equal(scenarios.length, 3);
  assert.ok(scenarios.every((s) => s.coverage >= 0));
});

test("PUT BUY is recommended for a bearish, aligned setup", () => {
  const supportWeakening = zoneFixture("support", 25766, 25774, { status: "WEAKENING", statusReason: "fixture" });
  const inputs = tradeInputs({
    trend: "BEARISH",
    biasScore: 26,
    futuresClass: "SHORT_BUILDUP",
    levels: levelsFixture({ support: supportWeakening, resistance: zoneFixture("resistance", 25838, 25848) }),
    oi: oiFixture({ ce5mChange: 180_000, pe5mChange: -140_000, pcr: 0.78, ceSessionChange: 900_000, peSessionChange: -1_100_000, ce15mChange: 260_000, pe15mChange: -300_000 }),
    bestCall: candidateFixture("CE", { leg: { ...candidateFixture("CE").leg, premiumChangePct: -12, momentumScore: 25 } }),
    bestPut: candidateFixture("PE"),
    momentum: { lastClose: 25812, change5m: -26, change15m: -48, bias: "BEARISH", strength: 74 },
  });
  const plan = buildTradePlan(inputs);
  assert.equal(plan.action, "PUT_BUY");
  assert.ok((plan.setupScore ?? 0) >= DEFAULT_WEIGHTS.thresholds.minSetupScore);
});

test("NO TRADE is produced when evidence is missing or conflicting", () => {
  const noContract = tradeInputs({ bestCall: null, bestPut: null });
  assert.equal(buildTradePlan(noContract).action, "NO_TRADE");

  const missingData = tradeInputs({
    trend: "SIDEWAYS",
    biasScore: 50,
    futuresClass: undefined,
    oi: oiFixture({ status: "PARTIAL", ce5mChange: null, pe5mChange: null, ce15mChange: null, pe15mChange: null, ceSessionChange: null, peSessionChange: null, pcr: null }),
    momentum: { lastClose: 25812, change5m: 1, change15m: -1, bias: "NEUTRAL", strength: 50 },
  });
  const plan = buildTradePlan(missingData);
  assert.equal(plan.action, "NO_TRADE");
  assert.ok(plan.noTradeReasons.length > 0);

  const unavailableChain = tradeInputs({ chainStatus: "UNAVAILABLE" });
  assert.equal(buildTradePlan(unavailableChain).action, "NO_TRADE");

  const noSpot = tradeInputs({ spot: null });
  const noSpotPlan = buildTradePlan(noSpot);
  assert.equal(noSpotPlan.action, "NO_TRADE");
  assert.ok(noSpotPlan.noTradeReasons[0].length > 0);
});

test("late entries are flagged instead of recommended", () => {
  const inputs = tradeInputs({});
  const farSpot = { ...inputs, spot: 25880 };
  const plan = buildTradePlan(farSpot);
  if (plan.action !== "NO_TRADE") {
    assert.ok(["WAIT_FOR_RETEST", "MISSED_ENTRY"].includes(plan.entryState), `entry state should flag a late entry, got ${plan.entryState}`);
    assert.match(plan.entryTrigger, /RETEST|MISSED ENTRY/);
  }
});

test("excessive spread blocks the recommendation", () => {
  const wide = candidateFixture("CE", { leg: { ...candidateFixture("CE").leg, spreadPct: 4.2, bidPrice: 180, askPrice: 187 } });
  const inputs = tradeInputs({ bestCall: wide });
  const plan = buildTradePlan(inputs);
  assert.equal(plan.action, "NO_TRADE");
  assert.ok(plan.noTradeReasons.some((r) => /spread/i.test(r)));
});

test("data-quality thresholds and scoring weights are internally consistent", () => {
  const zoneWeights = Object.values(DEFAULT_WEIGHTS.zone).reduce((a, b) => a + b, 0);
  const setupWeights = Object.values(DEFAULT_WEIGHTS.setup).reduce((a, b) => a + b, 0);
  const suitWeights = Object.values(DEFAULT_WEIGHTS.suitability).reduce((a, b) => a + b, 0);
  assert.equal(zoneWeights, 100);
  assert.equal(setupWeights, 100);
  assert.equal(suitWeights, 100);
  assert.ok(DEFAULT_WEIGHTS.thresholds.minSetupScore >= 50);
  assert.ok(DEFAULT_WEIGHTS.thresholds.minSuitabilityScore >= 50);
});
