import { DEFAULT_WEIGHTS } from "@/lib/config";
import { clamp01, clampScore, round2 } from "@/lib/engine/indicators";
import type {
  ContractCandidate,
  DataStatus,
  FuturesIntel,
  MarketStructure,
  OiIntel,
  ScenarioIntel,
  SrLevels,
  TradePlan,
  VolumeProfileResult,
  Zone,
} from "@/lib/engine/types";

export interface MomentumRead {
  lastClose: number | null;
  change5m: number | null;
  change15m: number | null;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  strength: number | null;
}

export interface TradeInputs {
  spot: number | null;
  structure: MarketStructure;
  zones: Zone[];
  levels: SrLevels;
  futures: FuturesIntel;
  oi: OiIntel;
  selection: TradeInputsSelection;
  momentum: MomentumRead;
  atrValue: number | null;
  volumeProfile: VolumeProfileResult;
  chainStatus: DataStatus;
  greeksAvailable: boolean;
  bidAskQtyAvailable: boolean;
  candlesStatus: DataStatus;
  now: number;
}

interface TradeInputsSelection {
  bestCall: ContractCandidate | null;
  bestPut: ContractCandidate | null;
  atmStrike: number | null;
  expiry: string | null;
}

interface DirectionalComponents {
  spotStructure: number | null;
  srBehaviour: number | null;
  futures: number | null;
  oiChange: number | null;
  premiumMomentum: number | null;
  contextVolatility: number | null;
}

function bullishnessOfStructure(structure: MarketStructure, momentum: MomentumRead): number | null {
  if (structure.structureBiasScore === null) return null;
  let v = (structure.structureBiasScore - 50) / 35; // -1..1
  if (structure.trend === "BULLISH") v += 0.35;
  if (structure.trend === "BEARISH") v -= 0.35;
  if (structure.htfTrend === "BULLISH") v += 0.2;
  if (structure.htfTrend === "BEARISH") v -= 0.2;
  if (momentum.bias === "BULLISH") v += 0.15;
  if (momentum.bias === "BEARISH") v -= 0.15;
  return Math.min(1, Math.max(-1, v));
}

function srBehaviourBullishness(levels: SrLevels, spot: number | null): number | null {
  if (spot === null) return null;
  let v = 0;
  let count = 0;
  const sup = levels.immediateSupport?.zone ?? null;
  const res = levels.immediateResistance?.zone ?? null;
  if (res) {
    count += 1;
    if (res.status === "WEAKENING") v += 0.7;
    else if (res.status === "BREAKOUT_RISK") v += 0.9;
    else if (res.status === "STRENGTHENING") v -= 0.7;
    else v += 0.1;
    if (res.status === "BROKEN") v += 0.8;
  }
  if (sup) {
    count += 1;
    if (sup.status === "STRENGTHENING") v += 0.6;
    else if (sup.status === "WEAKENING") v -= 0.8;
    else if (sup.status === "BREAKDOWN_RISK") v -= 0.9;
    else v += 0.1;
    if (sup.status === "BROKEN") v -= 0.8;
  }
  if (count === 0) return null;
  return Math.min(1, Math.max(-1, v / count));
}

function oiBullishness(oi: OiIntel): number | null {
  if (oi.status === "UNAVAILABLE") return null;
  const peChange = oi.pe5mChange ?? oi.peSessionChange ?? null;
  const ceChange = oi.ce5mChange ?? oi.ceSessionChange ?? null;
  if (peChange === null && ceChange === null) return null;
  let v = 0;
  if (ceChange !== null && peChange !== null && ceChange + peChange !== 0) {
    // Rising CE OI with rising PE OI is ambiguous; use relative skew only.
    v = (peChange - ceChange) / Math.max(1, Math.abs(ceChange) + Math.abs(peChange));
    v = Math.min(0.6, Math.max(-0.6, v));
  }
  if (oi.pcr !== null) {
    if (oi.pcr > 1.2) v += 0.25;
    else if (oi.pcr < 0.8) v -= 0.25;
  }
  return Math.min(1, Math.max(-1, v));
}

function premiumBullishness(selection: TradeInputsSelection): number | null {
  const call = selection.bestCall;
  const put = selection.bestPut;
  const callMomentum = call?.leg.momentumScore ?? null;
  const putMomentum = put?.leg.momentumScore ?? null;
  const callPct = call?.leg.premiumChangePct ?? null;
  const putPct = put?.leg.premiumChangePct ?? null;
  if (callPct === null && putPct === null) return null;
  let v = 0;
  if (callPct !== null && callPct !== 0) v += clamp01(callPct / 6);
  if (putPct !== null && putPct !== 0) v -= clamp01(Math.abs(putPct) / 6);
  if (callMomentum !== null && putMomentum !== null && callMomentum + putMomentum !== 0) {
    v += (callMomentum - putMomentum) / (callMomentum + putMomentum) * 0.4;
  }
  return Math.min(1, Math.max(-1, v));
}

function futuresBullishness(futures: FuturesIntel): number | null {
  if (futures.classification === "UNAVAILABLE") return null;
  switch (futures.classification) {
    case "LONG_BUILDUP":
      return 0.8;
    case "SHORT_COVERING":
      return 0.5;
    case "SHORT_BUILDUP":
      return -0.8;
    case "LONG_UNWINDING":
      return -0.5;
    default:
      return 0.1;
  }
}

function contextVolatilityScore(atr: number | null, spot: number | null, vp: VolumeProfileResult, structure: MarketStructure): number {
  if (atr === null || spot === null) return 0.3;
  const atrPct = (atr / spot) * 100;
  let v = 0.7;
  if (atrPct < 0.05) v = 0.25; // dead tape
  else if (atrPct > 0.9) v = 0.4; // erratic
  else v = 1;
  if (vp.migration === "STABLE" && structure.trend === "SIDEWAYS") v *= 0.6;
  return clamp01(v);
}

function directionalScore(components: DirectionalComponents): { score: number | null; coverage: number } {
  const w = DEFAULT_WEIGHTS.setup;
  const weights: Record<string, number> = {
    spotStructure: w.spotStructure,
    srBehaviour: w.srBehaviour,
    futures: w.futures,
    oiChange: w.oiChange,
    premiumMomentum: w.premiumMomentum,
    contextVolatility: w.contextVolatility,
  };
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const availableWeight = Object.entries(weights)
    .filter(([k]) => components[k as keyof DirectionalComponents] !== null)
    .reduce((a, [, b]) => a + b, 0);
  const coverage = availableWeight / totalWeight;
  const raw =
    w.spotStructure * (components.spotStructure ?? 0) +
    w.srBehaviour * (components.srBehaviour ?? 0) +
    w.futures * (components.futures ?? 0) +
    w.oiChange * (components.oiChange ?? 0) +
    w.premiumMomentum * (components.premiumMomentum ?? 0) +
    w.contextVolatility * (components.contextVolatility ?? 0);
  // Missing evidence contributes zero, never positive.
  return { score: clampScore(50 + raw / 2), coverage };
}

function buildConditions(bullish: boolean, args: TradeInputs, comp: DirectionalComponents): { met: string[]; failed: string[] } {
  const met: string[] = [];
  const failed: string[] = [];
  const spot = args.spot;
  const zone = bullish ? args.levels.immediateResistance?.zone : args.levels.immediateSupport?.zone;
  const support = args.levels.immediateSupport?.zone ?? null;
  const resistance = args.levels.immediateResistance?.zone ?? null;

  if (args.momentum.bias === (bullish ? "BULLISH" : "BEARISH")) {
    met.push(
      `Underlying momentum is ${args.momentum.bias} (5m change ${args.momentum.change5m ?? "n/a"}, 15m change ${args.momentum.change15m ?? "n/a"}).`,
    );
  } else {
    failed.push(`Underlying momentum is ${args.momentum.bias}, not aligned with a ${bullish ? "bullish" : "bearish"} setup.`);
  }

  if (args.structure.trend === (bullish ? "BULLISH" : "BEARISH")) {
    met.push(`Market structure on the primary timeframe is ${args.structure.trend}.`);
  } else {
    failed.push(`Market structure is ${args.structure.trend}${args.structure.htfTrend !== "UNCLEAR" ? ` (HTF ${args.structure.htfTrend})` : ""}, not ${bullish ? "bullish" : "bearish"}.`);
  }

  if (zone && zone.status === (bullish ? "WEAKENING" : "WEAKENING")) {
    met.push(`Immediate ${bullish ? "resistance" : "support"} is weakening (${zone.statusReason}).`);
  } else if (zone && zone.status === (bullish ? "BREAKOUT_RISK" : "BREAKDOWN_RISK")) {
    met.push(`Immediate ${bullish ? "resistance breakout" : "support breakdown"} risk developing (${zone.statusReason}).`);
  } else if (zone) {
    failed.push(`Immediate ${bullish ? "resistance" : "support"} is not weakening: status ${zone.status}.`);
  } else {
    failed.push(`No valid immediate ${bullish ? "resistance" : "support"} zone available.`);
  }

  const holdingZone = bullish ? support : resistance;
  if (holdingZone && holdingZone.status !== "BROKEN" && holdingZone.status !== "INVALIDATED") {
    met.push(`Price is holding above/against the ${bullish ? "support" : "resistance"} zone ${holdingZone.lower}–${holdingZone.upper} (${holdingZone.status}).`);
  } else if (holdingZone) {
    failed.push(`${bullish ? "Support" : "Resistance"} zone ${holdingZone.lower}–${holdingZone.upper} is ${holdingZone.status}.`);
  } else {
    failed.push(`No ${bullish ? "support" : "resistance"} zone available for structural invalidation.`);
  }

  if (comp.futures !== null && Math.abs(comp.futures) >= 0.4) {
    met.push(`Futures positioning (${args.futures.classification}) supports a ${bullish ? "bullish" : "bearish"} read.`);
  } else if (comp.futures === null) {
    failed.push("Futures positioning unavailable — confluence evidence missing.");
  } else {
    failed.push(`Futures positioning (${args.futures.classification}) does not support the direction.`);
  }

  if (comp.oiChange !== null && Math.abs(comp.oiChange) >= 0.15) {
    met.push(`Options OI skew supports ${comp.oiChange > 0 ? "put-side" : "call-side"} positioning (PCR ${args.oi.pcr ?? "n/a"}).`);
  } else if (comp.oiChange === null) {
    failed.push("OI change evidence unavailable.");
  } else {
    failed.push("OI evidence is neutral/conflicting.");
  }

  if (comp.premiumMomentum !== null && Math.abs(comp.premiumMomentum) >= 0.1) {
    met.push(`Premium momentum confirms ${comp.premiumMomentum > 0 ? "CALL" : "PUT"} side participation.`);
  } else {
    failed.push("Option premium momentum does not confirm the direction.");
  }

  if (spot !== null && args.atrValue !== null) {
    const atrPct = (args.atrValue / spot) * 100;
    if (atrPct > 0.04) met.push(`ATR (${atrPct.toFixed(3)}% of spot) supports a tradeable move.`);
    else failed.push(`ATR too low (${atrPct.toFixed(3)}% of spot) — expected move does not justify theta cost.`);
  }

  return { met, failed };
}

function premiumProjection(
  contract: ContractCandidate,
  spot: number,
  underlyingLevel: number,
  bullish: boolean,
): number | null {
  const delta = contract.leg.delta;
  const premium = contract.leg.ltp;
  if (delta === null || premium === null) return null;
  const points = bullish ? underlyingLevel - spot : underlyingLevel - spot;
  const gamma = contract.leg.gamma ?? 0;
  const gammaAdj = gamma * points * Math.abs(points) * 0.5;
  const projected = premium + delta * points + gammaAdj;
  return projected > 0 ? round2(projected) : null;
}

export function buildTradePlan(args: TradeInputs): TradePlan {
  const spot = args.spot;
  const now = args.now;
  const base: TradePlan = {
    action: "NO_TRADE",
    direction: "neutral",
    status: "UNAVAILABLE",
    headline: "NO TRADE",
    setupScore: null,
    setupCoverage: 0,
    setupComponents: {},
    entryTrigger: "Not applicable",
    entryLow: null,
    entryHigh: null,
    entryState: "NOT_APPLICABLE",
    stopLoss: null,
    stopBasis: "Not applicable",
    target1: null,
    target2: null,
    targetBasis: "Not applicable",
    riskReward: null,
    invalidation: [],
    conditionsMet: [],
    conditionsFailed: [],
    spotAtSignal: spot,
    premium: null,
    contract: null,
    noTradeReasons: [],
    updatedAt: new Date(now).toISOString(),
  };

  if (spot === null || args.candlesStatus === "UNAVAILABLE") {
    return {
      ...base,
      status: "UNAVAILABLE",
      headline: "NO TRADE — data unavailable",
      noTradeReasons: [
        spot === null ? "Spot price unavailable." : "",
        args.candlesStatus === "UNAVAILABLE" ? "Candles unavailable — structure and zones cannot be validated." : "",
      ].filter(Boolean),
      updatedAt: new Date(now).toISOString(),
    };
  }

  const bullishComponents: DirectionalComponents = {
    spotStructure: bullishnessOfStructure(args.structure, args.momentum),
    srBehaviour: srBehaviourBullishness(args.levels, spot),
    futures: futuresBullishness(args.futures),
    oiChange: oiBullishness(args.oi),
    premiumMomentum: premiumBullishness(args.selection),
    contextVolatility: contextVolatilityScore(args.atrValue, spot, args.volumeProfile, args.structure),
  };
  const bearishComponents: DirectionalComponents = {
    ...bullishComponents,
    // Same inputs, opposite sign where the component is directional.
    spotStructure: bullishComponents.spotStructure === null ? null : -bullishComponents.spotStructure,
    srBehaviour: bullishComponents.srBehaviour === null ? null : -bullishComponents.srBehaviour,
    futures: bullishComponents.futures === null ? null : -bullishComponents.futures,
    oiChange: bullishComponents.oiChange === null ? null : -bullishComponents.oiChange,
    premiumMomentum: bullishComponents.premiumMomentum === null ? null : -bullishComponents.premiumMomentum,
    contextVolatility: bullishComponents.contextVolatility,
  };

  const bull = directionalScore(bullishComponents);
  const bear = directionalScore(bearishComponents);
  const threshold = DEFAULT_WEIGHTS.thresholds.minSetupScore;
  const noTradeReasons: string[] = [];

  const bullish = bull.score !== null && bear.score !== null ? bull.score >= bear.score : bull.score !== null;
  const chosen = bullish ? bull : bear;
  const comp = bullish ? bullishComponents : bearishComponents;
  const contract = bullish ? args.selection.bestCall : args.selection.bestPut;
  const opposite = bullish ? args.selection.bestPut : args.selection.bestCall;

  if (chosen.score === null) {
    noTradeReasons.push("No directional evidence available (structure, S/R behaviour and option data are all unavailable).");
  } else if (chosen.score < threshold) {
    noTradeReasons.push(`Directional setup score ${chosen.score} is below the ${threshold} threshold — evidence insufficient.`);
  }
  if (Math.abs((bull.score ?? 0) - (bear.score ?? 0)) < 8 && chosen.score !== null) {
    noTradeReasons.push(`Bullish (${bull.score}) and bearish (${bear.score}) evidence are too close — direction unclear.`);
  }

  // A single indicator must never determine direction.
  const directionalKeys = ["spotStructure", "srBehaviour", "futures", "oiChange", "premiumMomentum"] as const;
  const availableDir = directionalKeys.filter((k) => comp[k] !== null);
  if (availableDir.length < 2) {
    noTradeReasons.push(
      `Only ${availableDir.length} independent directional evidence source(s) available (${availableDir.join(", ") || "none"}) — a single indicator cannot determine direction.`,
    );
  }
  const underlyingEvidence = [comp.spotStructure, comp.srBehaviour].filter((v): v is number => v !== null);
  if (underlyingEvidence.length === 0) {
    noTradeReasons.push("Underlying spot evidence (structure / S/R behaviour) is unavailable — options data alone cannot establish bias.");
  } else if (Math.max(...underlyingEvidence) < 0.15) {
    // Component values are already aligned with the chosen direction (positive = agrees).
    noTradeReasons.push(
      `Underlying structure / S-R behaviour (${underlyingEvidence.map((v) => v.toFixed(2)).join(", ")}) does not support a ${bullish ? "bullish" : "bearish"} bias.`,
    );
  }
  if (contract === null) {
    noTradeReasons.push(`No ${bullish ? "CALL" : "PUT"} contract passed liquidity/spread gates — cannot recommend ${bullish ? "CALL BUY" : "PUT BUY"}.`);
  } else {
    if ((contract.suitabilityScore ?? 0) < DEFAULT_WEIGHTS.thresholds.minSuitabilityScore) {
      noTradeReasons.push(`Contract suitability score ${contract.suitabilityScore} is below ${DEFAULT_WEIGHTS.thresholds.minSuitabilityScore}.`);
    }
    if (contract.coverage < DEFAULT_WEIGHTS.thresholds.minEvidenceCoverage) {
      noTradeReasons.push(`Contract evidence coverage ${(contract.coverage * 100).toFixed(0)}% is below ${(DEFAULT_WEIGHTS.thresholds.minEvidenceCoverage * 100).toFixed(0)}%.`);
    }
    if (chosen.coverage < DEFAULT_WEIGHTS.thresholds.minEvidenceCoverage) {
      noTradeReasons.push(`Setup evidence coverage ${(chosen.coverage * 100).toFixed(0)}% is below ${(DEFAULT_WEIGHTS.thresholds.minEvidenceCoverage * 100).toFixed(0)}%.`);
    }
    if (contract.leg.delta === null) {
      noTradeReasons.push("Greeks (delta) unavailable for the selected contract — contract suitability cannot be assessed, so the trade is not recommended.");
    }
    // Greeks Suitability Score is a separate, mandatory check: a liquid contract with
    // poor or unassessable Greeks must not be recommended just because direction is clear.
    if (contract.greeksSuitabilityScore === null) {
      noTradeReasons.push("Greeks Suitability Score unavailable — no Greeks were returned for this contract, so risk cannot be assessed.");
    } else if (contract.greeksSuitabilityScore < 50) {
      noTradeReasons.push(
        `Greeks suitability ${contract.greeksSuitabilityScore} (${contract.greeksSuitabilityClass ?? "unclassified"}) is below the 50 minimum — delta/gamma/theta/IV profile is unfavourable for a BUY.`,
      );
    }
    if (contract.executionQualityScore !== null && contract.executionQualityScore < 40) {
      noTradeReasons.push(`Execution quality ${contract.executionQualityScore} is below 40 — the contract cannot realistically be entered and exited.`);
    }
    if (contract.disqualifications.length > 0) {
      noTradeReasons.push(`Contract disqualified: ${contract.disqualifications.join("; ")}.`);
    }
    if (contract.leg.spreadPct !== null && contract.leg.spreadPct > DEFAULT_WEIGHTS.thresholds.maxSpreadPct) {
      noTradeReasons.push(`Bid/ask spread ${contract.leg.spreadPct}% exceeds the ${DEFAULT_WEIGHTS.thresholds.maxSpreadPct}% limit.`);
    }
    if (opposite?.leg.premiumChangePct !== null && opposite?.leg.premiumChangePct !== undefined && contract.leg.premiumChangePct !== null) {
      const oppositeBetter = bullish
        ? opposite.leg.premiumChangePct > contract.leg.premiumChangePct
        : opposite.leg.premiumChangePct < contract.leg.premiumChangePct;
      if (oppositeBetter) noTradeReasons.push("Premium momentum contradicts the underlying direction (opposite side premium is leading).");
    }
  }
  if (args.chainStatus === "UNAVAILABLE" || args.chainStatus === "INVALID") {
    noTradeReasons.push("Option chain data is unavailable or invalid — recommendations are not generated from incomplete inputs.");
  }

  const { met, failed } = buildConditions(bullish, args, comp);
  const canRecommend =
    noTradeReasons.length === 0 && chosen.score !== null && chosen.score >= threshold && contract !== null;

  if (!canRecommend) {
    return {
      ...base,
      status: chosen.score === null ? "UNAVAILABLE" : "PARTIAL",
      headline: "NO TRADE",
      direction: bullish ? "bullish" : "bearish",
      setupScore: chosen.score,
      setupCoverage: chosen.coverage,
      setupComponents: Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, v === null ? null : round2(((v + 1) / 2) * 100)])),
      conditionsMet: met,
      conditionsFailed: failed,
      noTradeReasons: noTradeReasons.length > 0 ? noTradeReasons : ["Evidence is inconclusive — NO TRADE."],
      contract,
      premium: contract?.leg.ltp ?? null,
      updatedAt: new Date(now).toISOString(),
    };
  }

  // ----- Entry / stop / target from actual structure -----
  const a = args.atrValue;
  const atrRef = a ?? spot * 0.001;
  const oppositeZone = bullish ? args.levels.immediateResistance?.zone : args.levels.immediateSupport?.zone;
  const holdingZone = bullish ? args.levels.immediateSupport?.zone : args.levels.immediateResistance?.zone;
  const nextZone = bullish ? args.levels.primaryResistance?.zone : args.levels.primarySupport?.zone;

  let triggerLevel: number | null = null;
  let triggerText = "";
  if (oppositeZone && (oppositeZone.status === "BREAKOUT_RISK" || oppositeZone.status === "BREAKDOWN_RISK" || oppositeZone.status === "WEAKENING")) {
    triggerLevel = bullish ? oppositeZone.upper : oppositeZone.lower;
    triggerText = `${bullish ? "Break and accept above" : "Break and accept below"} the immediate ${bullish ? "resistance" : "support"} zone boundary ${triggerLevel}.`;
  } else if (holdingZone) {
    triggerLevel = bullish ? holdingZone.upper : holdingZone.lower;
    triggerText = `Retest of the ${bullish ? "support" : "resistance"} zone boundary ${triggerLevel} with rejection in the ${bullish ? "up" : "down"} direction.`;
  }

  const entryLow = triggerLevel !== null ? round2(triggerLevel - atrRef * 0.1) : null;
  const entryHigh = triggerLevel !== null ? round2(triggerLevel + atrRef * 0.1) : null;
  let entryState: TradePlan["entryState"] = "READY";
  if (triggerLevel !== null) {
    const overshoot = Math.abs(spot - triggerLevel);
    if (overshoot > atrRef * 0.8) entryState = "MISSED_ENTRY";
    else if (overshoot > atrRef * 0.35) entryState = "WAIT_FOR_RETEST";
  }

  const invalidationLevel = holdingZone
    ? bullish
      ? round2(holdingZone.lower - atrRef * 0.15)
      : round2(holdingZone.upper + atrRef * 0.15)
    : bullish
      ? round2(Math.min(...args.zones.filter((z) => z.kind === "support").map((z) => z.lower)) - atrRef * 0.15)
      : round2(Math.max(...args.zones.filter((z) => z.kind === "resistance").map((z) => z.upper)) + atrRef * 0.15);

  const premium = contract.leg.ltp;
  const premiumStop = premium !== null ? round2(premiumProjection(contract, spot, invalidationLevel, bullish) ?? premium * 0.7) : null;
  const t1Level = nextZone ? (bullish ? nextZone.lower : nextZone.upper) : round2(bullish ? spot + atrRef * 2 : spot - atrRef * 2);
  const t2Level = nextZone
    ? bullish
      ? round2(nextZone.upper + atrRef * 0.25)
      : round2(nextZone.lower - atrRef * 0.25)
    : round2(bullish ? spot + atrRef * 3.2 : spot - atrRef * 3.2);
  const premiumT1 = premiumProjection(contract, spot, t1Level, bullish);
  const premiumT2 = premiumProjection(contract, spot, t2Level, bullish);

  const risk = premium !== null && premiumStop !== null ? premium - premiumStop : null;
  const reward = premiumT1 !== null && premium !== null ? premiumT1 - premium : null;
  const riskReward = risk !== null && reward !== null && risk > 0 ? round2(reward / risk) : null;

  return {
    action: bullish ? "CALL_BUY" : "PUT_BUY",
    direction: bullish ? "bullish" : "bearish",
    status: "LIVE",
    headline: `${bullish ? "CALL BUY" : "PUT BUY"} ${contract.strike} (${contract.classification})`,
    setupScore: chosen.score,
    setupCoverage: chosen.coverage,
    setupComponents: Object.fromEntries(
      Object.entries(comp).map(([k, v]) => [k, v === null ? null : round2(((v + 1) / 2) * 100)]),
    ),
    entryTrigger: `${triggerText} ${entryState === "WAIT_FOR_RETEST" ? "Price has already moved away from the trigger — WAIT FOR RETEST." : entryState === "MISSED_ENTRY" ? "Price has moved too far from the trigger — MISSED ENTRY (do not chase)." : ""}`.trim(),
    entryLow,
    entryHigh,
    entryState,
    stopLoss: invalidationLevel,
    stopBasis: `Underlying invalidation below/above the ${bullish ? "support" : "resistance"} zone boundary. Estimated option premium stop ${premiumStop ?? "unavailable"} (ESTIMATED via delta/gamma projection — not a broker order).`,
    target1: t1Level,
    target2: t2Level,
    targetBasis: `T1/T2 derived from the next structural ${bullish ? "resistance" : "support"} zones. Estimated premium at T1 ${premiumT1 ?? "unavailable"}, at T2 ${premiumT2 ?? "unavailable"} (ESTIMATED).`,
    riskReward,
    invalidation: [
      `${bullish ? "Underlying" : "Underlying"} invalidation: a close ${bullish ? "below" : "above"} ${invalidationLevel} negates the setup.`,
      `${bullish ? "Immediate resistance" : "Immediate support"} strengthening again would re-evaluate the trade.`,
      "IV collapse after the move (IV crush) reduces premium gains even if spot follows through.",
      "Data-quality degradation (stale candles, missing Greeks) invalidates the recommendation.",
    ],
    conditionsMet: met,
    conditionsFailed: failed,
    spotAtSignal: spot,
    premium,
    contract: {
      ...contract,
      reasons: [...contract.reasons, "Selected after comparing ATM/ITM/OTM legs on delta, liquidity, Greeks, premium momentum and risk."],
    },
    noTradeReasons: [],
    updatedAt: new Date(now).toISOString(),
  };
}

export function buildScenarios(args: TradeInputs, plan: TradePlan): ScenarioIntel[] {
  const spot = args.spot;
  const a = args.atrValue;
  const sup = args.levels.immediateSupport?.zone ?? null;
  const priSup = args.levels.primarySupport?.zone ?? null;
  const res = args.levels.immediateResistance?.zone ?? null;
  const priRes = args.levels.primaryResistance?.zone ?? null;

  const zoneLabels = (zones: Array<Zone | null>) =>
    zones.filter((z): z is Zone => z !== null).map((z) => `${z.kind === "support" ? "Support" : "Resistance"} ${z.lower}–${z.upper} (score ${z.score}, ${z.status})`);

  const bullish: ScenarioIntel = {
    name: "BULLISH",
    likelihoodScore: null,
    coverage: 0,
    conditions: [
      "Support defended with repeated rejection.",
      "Immediate resistance weakening or breakout risk.",
      "Bullish market structure (HH/HL) on the primary timeframe.",
      "Option premium momentum on the CALL side.",
      "Futures positioning not contradicting the bullish read.",
    ],
    supporting: [
      ...(sup && ["STRENGTHENING", "ACTIVE", "VALIDATED"].includes(sup.status) ? [`Support ${sup.lower}–${sup.upper}: ${sup.status}.`] : []),
      ...(res && ["WEAKENING", "BREAKOUT_RISK", "BROKEN"].includes(res.status) ? [`Resistance ${res.lower}–${res.upper}: ${res.status}.`] : []),
      ...(args.structure.trend === "BULLISH" ? ["Primary-timeframe structure is bullish."] : []),
      ...(args.futures.classification === "LONG_BUILDUP" || args.futures.classification === "SHORT_COVERING"
        ? [`Futures ${args.futures.classification}.`]
        : []),
      ...(args.selection.bestCall?.leg.momentumScore !== null && args.selection.bestCall?.leg.momentumScore !== undefined
        ? [`Best CALL momentum score ${args.selection.bestCall?.leg.momentumScore}.`]
        : []),
    ],
    contradictory: [
      ...(args.structure.trend === "BEARISH" ? ["Primary-timeframe structure is bearish."] : []),
      ...(sup?.status === "WEAKENING" || sup?.status === "BREAKDOWN_RISK" ? ["Immediate support is deteriorating."] : []),
      ...(res?.status === "STRENGTHENING" ? ["Immediate resistance is strengthening."] : []),
    ],
    trigger:
      res && spot !== null
        ? `Acceptance above ${res.upper}${a !== null ? ` (≈${round2(res.upper + a * 0.1)} with 0.1 ATR buffer)` : ""} followed by a hold above on the retest.`
        : "No resistance zone available to define a breakout trigger.",
    invalidation: sup ? `Close below ${sup.lower} invalidates the bullish scenario.` : "No support zone available to define invalidation.",
    zones: zoneLabels([sup, priSup, res, priRes]),
  };

  const bearish: ScenarioIntel = {
    name: "BEARISH",
    likelihoodScore: null,
    coverage: 0,
    conditions: [
      "Resistance rejection with upper-wick/body rejection.",
      "Immediate support weakening or breakdown risk.",
      "Bearish market structure (LH/LL) on the primary timeframe.",
      "Option premium momentum on the PUT side.",
      "Futures positioning not contradicting the bearish read.",
    ],
    supporting: [
      ...(res && ["STRENGTHENING", "ACTIVE", "VALIDATED"].includes(res.status) ? [`Resistance ${res.lower}–${res.upper}: ${res.status}.`] : []),
      ...(sup && ["WEAKENING", "BREAKDOWN_RISK", "BROKEN"].includes(sup.status) ? [`Support ${sup.lower}–${sup.upper}: ${sup.status}.`] : []),
      ...(args.structure.trend === "BEARISH" ? ["Primary-timeframe structure is bearish."] : []),
      ...(args.futures.classification === "SHORT_BUILDUP" || args.futures.classification === "LONG_UNWINDING"
        ? [`Futures ${args.futures.classification}.`]
        : []),
      ...(args.selection.bestPut?.leg.momentumScore !== null && args.selection.bestPut?.leg.momentumScore !== undefined
        ? [`Best PUT momentum score ${args.selection.bestPut?.leg.momentumScore}.`]
        : []),
    ],
    contradictory: [
      ...(args.structure.trend === "BULLISH" ? ["Primary-timeframe structure is bullish."] : []),
      ...(res?.status === "WEAKENING" || res?.status === "BREAKOUT_RISK" ? ["Immediate resistance is deteriorating."] : []),
      ...(sup?.status === "STRENGTHENING" ? ["Immediate support is strengthening."] : []),
    ],
    trigger:
      sup && spot !== null
        ? `Acceptance below ${sup.lower}${a !== null ? ` (≈${round2(sup.lower - a * 0.1)} with 0.1 ATR buffer)` : ""} followed by a failed retest.`
        : "No support zone available to define a breakdown trigger.",
    invalidation: res ? `Close above ${res.upper} invalidates the bearish scenario.` : "No resistance zone available to define invalidation.",
    zones: zoneLabels([sup, priSup, res, priRes]),
  };

  const consolidation: ScenarioIntel = {
    name: "CONSOLIDATION",
    likelihoodScore: null,
    coverage: 0,
    conditions: [
      "Price accepting inside the range defined by the immediate zones.",
      "No confirmed directional structure (equal highs / equal lows).",
      "Range boundaries active and strengthening.",
      "Premium momentum muted on both sides.",
    ],
    supporting: [
      ...(args.structure.trend === "SIDEWAYS" || args.structure.trend === "UNCLEAR" ? ["Structure is sideways/unclear."] : []),
      ...(sup?.status === "STRENGTHENING" && res?.status === "STRENGTHENING" ? ["Both range boundaries are strengthening."] : []),
      ...(args.volumeProfile.migration === "STABLE" ? ["Volume profile migration is stable (ESTIMATED)."] : []),
    ],
    contradictory: [
      ...(args.structure.trend === "BULLISH" || args.structure.trend === "BEARISH" ? ["Structure is directional, not sideways."] : []),
      ...(plan.action !== "NO_TRADE" ? ["Trade engine produced a directional recommendation."] : []),
    ],
    trigger: "Trade only on a confirmed break and acceptance outside the range boundaries — not before.",
    invalidation: `Sustained acceptance outside ${sup?.lower ?? "n/a"}–${res?.upper ?? "n/a"} ends the consolidation read.`,
    zones: zoneLabels([sup, priSup, res, priRes]),
  };

  const assign = (s: ScenarioIntel, bullishness: number | null) => {
    s.coverage = Math.min(
      1,
      (args.structure.status === "LIVE" ? 0.3 : 0) +
        (sup !== null ? 0.15 : 0) +
        (res !== null ? 0.15 : 0) +
        (args.oi.status === "LIVE" ? 0.15 : 0) +
        (args.futures.status === "LIVE" ? 0.1 : 0) +
        (args.selection.bestCall !== null || args.selection.bestPut !== null ? 0.15 : 0),
    );
    s.likelihoodScore = bullishness === null ? null : clampScore(50 + bullishness * 45);
    return s;
  };

  const bullValue = (plan.setupComponents.spotStructure ?? null);
  const bearValue = bullValue === null ? null : 100 - bullValue;
  return [
    assign(bullish, bullValue === null ? null : bullValue),
    assign(bearish, bearValue),
    assign(consolidation, 50),
  ];
}
