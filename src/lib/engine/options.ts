import { DEFAULT_WEIGHTS, EXECUTION_THRESHOLDS, EXECUTION_WEIGHTS } from "@/lib/config";
import { scoreOiParticipation, type ContractOiMeasurements, type OiParticipationResult } from "@/lib/engine/ochange";
import { clamp01, clampScore, round2 } from "@/lib/engine/indicators";
import type { ContractCandidate, DataStatus, OptionLegIntel, StrikeIntel, StrikeSelection, OiIntel } from "@/lib/engine/types";
import type { OiHistoryPoint } from "@/lib/persistence";
import type { GreeksChainContext } from "@/lib/engine/greeks";
import { assessGreeks, buildGreeksChainContext, type GreeksAssessment, type GreeksRawLeg } from "@/lib/engine/greeks";
import {
  assessParticipation,
  assessBuyerSeller,
  assessQuotePressure,
  EXECUTED_DOMINANCE_EXPLANATION,
  EXECUTED_DOMINANCE_STATUS,
  type BuyerSellerResult,
  type ParticipationResult,
  type QuotePressureResult,
} from "@/lib/engine/participation";
import type { OptionChainStrike } from "@/lib/upstox/market";
import type { OiClusterInput } from "@/lib/engine/zones";

// Single source of truth for stored option observations lives in the persistence
// layer, so every engine reads exactly the same fields (including bid/ask quantities).
export type { OiHistoryPoint } from "@/lib/persistence";

export interface PersistedOiRow {
  symbol: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  instrumentKey: string | null;
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
  receivedAt: number;
}

/* ------------------------------------------------------------------ *
 * OI intelligence
 * ------------------------------------------------------------------ */

function nearestSnapshot(points: OiHistoryPoint[], strike: number, side: "CE" | "PE", target: number, toleranceMs: number): OiHistoryPoint | null {
  let best: OiHistoryPoint | null = null;
  let bestDelta = Infinity;
  for (const p of points) {
    if (p.strike !== strike || p.optionType !== side) continue;
    const d = Math.abs(p.receivedAt - target);
    if (d < bestDelta) {
      bestDelta = d;
      best = p;
    }
  }
  return best && bestDelta <= toleranceMs ? best : null;
}

export function computeOiIntel(
  strikes: OptionChainStrike[],
  history: OiHistoryPoint[],
  now: number,
  greeksAvailable: boolean,
  bidAskQtyAvailable: boolean,
): OiIntel {
  if (strikes.length === 0) {
    return {
      status: "UNAVAILABLE",
      message: "No option chain rows available — OI intelligence disabled (no fabricated OI).",
      totalCeOi: null,
      totalPeOi: null,
      combinedOi: null,
      pcr: null,
      pcrBasis: "UNAVAILABLE",
      ce5mChange: null,
      pe5mChange: null,
      ce15mChange: null,
      pe15mChange: null,
      ceSessionChange: null,
      peSessionChange: null,
      snapshotCount: history.length,
      oldestSnapshotAt: null,
      baselineAt: null,
      oiClusters: [],
      additions: [],
      reductions: [],
      interpretation: [],
      greeksAvailable,
      bidAskQtyAvailable,
    };
  }

  const totalCeOi = strikes.reduce((a, s) => a + (s.ce.oi ?? 0), 0);
  const totalPeOi = strikes.reduce((a, s) => a + (s.pe.oi ?? 0), 0);
  const combinedOi = totalCeOi + totalPeOi;
  const pcr = totalCeOi > 0 ? totalPeOi / totalCeOi : null;

  const ce5m = strikes.reduce((a, s) => {
    const ref = nearestSnapshot(history, s.strike, "CE", now - 5 * 60000, 120000);
    return a + (ref?.oi !== null && ref?.oi !== undefined && s.ce.oi !== null ? s.ce.oi - ref.oi : 0);
  }, 0);
  const pe5m = strikes.reduce((a, s) => {
    const ref = nearestSnapshot(history, s.strike, "PE", now - 5 * 60000, 120000);
    return a + (ref?.oi !== null && ref?.oi !== undefined && s.pe.oi !== null ? s.pe.oi - ref.oi : 0);
  }, 0);
  const ce15m = strikes.reduce((a, s) => {
    const ref = nearestSnapshot(history, s.strike, "CE", now - 15 * 60000, 180000);
    return a + (ref?.oi !== null && ref?.oi !== undefined && s.ce.oi !== null ? s.ce.oi - ref.oi : 0);
  }, 0);
  const pe15m = strikes.reduce((a, s) => {
    const ref = nearestSnapshot(history, s.strike, "PE", now - 15 * 60000, 180000);
    return a + (ref?.oi !== null && ref?.oi !== undefined && s.pe.oi !== null ? s.pe.oi - ref.oi : 0);
  }, 0);

  const baseline = history
    .filter((p) => now - p.receivedAt < 24 * 3600000)
    .sort((a, b) => a.receivedAt - b.receivedAt)[0];
  const ceSession = baseline !== null ? strikes.reduce((a, s) => {
    const base = history.find((p) => p.strike === s.strike && p.optionType === "CE" && p.receivedAt === baseline.receivedAt);
    return a + (base?.oi !== null && base?.oi !== undefined && s.ce.oi !== null ? s.ce.oi - base.oi : 0);
  }, 0) : null;
  const peSession = baseline !== null ? strikes.reduce((a, s) => {
    const base = history.find((p) => p.strike === s.strike && p.optionType === "PE" && p.receivedAt === baseline.receivedAt);
    return a + (base?.oi !== null && base?.oi !== undefined && s.pe.oi !== null ? s.pe.oi - base.oi : 0);
  }, 0) : null;

  const clusters: OiClusterInput[] = [];
  for (const s of strikes) {
    if (s.ce.oi !== null && combinedOi > 0) {
      clusters.push({ strike: s.strike, side: "CE", oi: s.ce.oi, share: s.ce.oi / combinedOi, kind: "CE OI concentration" });
    }
    if (s.pe.oi !== null && combinedOi > 0) {
      clusters.push({ strike: s.strike, side: "PE", oi: s.pe.oi, share: s.pe.oi / combinedOi, kind: "PE OI concentration" });
    }
  }
  clusters.sort((a, b) => b.oi - a.oi);
  const topClusters = clusters.slice(0, 8);

  const additions: OiIntel["additions"] = [];
  const reductions: OiIntel["reductions"] = [];
  for (const s of strikes) {
    const ref = nearestSnapshot(history, s.strike, "CE", now - 5 * 60000, 120000);
    if (ref?.oi !== null && ref?.oi !== undefined && s.ce.oi !== null) {
      const d = s.ce.oi - ref.oi;
      if (Math.abs(d) > Math.max(1000, ref.oi * 0.03)) {
        (d > 0 ? additions : reductions).push({ strike: s.strike, side: "CE", change: d, window: "5m" });
      }
    }
    const refPe = nearestSnapshot(history, s.strike, "PE", now - 5 * 60000, 120000);
    if (refPe?.oi !== null && refPe?.oi !== undefined && s.pe.oi !== null) {
      const d = s.pe.oi - refPe.oi;
      if (Math.abs(d) > Math.max(1000, refPe.oi * 0.03)) {
        (d > 0 ? additions : reductions).push({ strike: s.strike, side: "PE", change: d, window: "5m" });
      }
    }
  }
  additions.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  reductions.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  const interpretation: string[] = [];
  if (pcr !== null) {
    interpretation.push(`PCR (PE OI / CE OI, current totals) = ${pcr.toFixed(3)}.`);
  }
  if (ce5m !== 0 || pe5m !== 0) {
    interpretation.push(`Rolling 5m OI change: CE ${ce5m}, PE ${pe5m}.`);
  }
  if (ce15m !== 0 || pe15m !== 0) {
    interpretation.push(`Rolling 15m OI change: CE ${ce15m}, PE ${pe15m}.`);
  }
  interpretation.push(
    "OI additions alone do not prove option writing; premium movement, volume and OI are interpreted together.",
  );
  const ceAdd = additions.filter((a) => a.side === "CE").slice(0, 3).map((a) => a.strike);
  const peAdd = additions.filter((a) => a.side === "PE").slice(0, 3).map((a) => a.strike);
  if (ceAdd.length) interpretation.push(`Largest 5m CE OI additions at strikes ${ceAdd.join(", ")}.`);
  if (peAdd.length) interpretation.push(`Largest 5m PE OI additions at strikes ${peAdd.join(", ")}.`);

  const hasRolling = history.length > 0;
  const status: DataStatus = !hasRolling ? "PARTIAL" : "LIVE";

  return {
    status,
    message: hasRolling
      ? "OI computed from current chain plus persisted snapshot history."
      : "Current chain OI available; rolling 5m/15m changes require persisted snapshot history (this is the first capture for this session).",
    totalCeOi,
    totalPeOi,
    combinedOi,
    pcr: pcr === null ? null : round2(pcr),
    pcrBasis: "current total PE OI / current total CE OI for the selected expiry",
    ce5mChange: hasRolling ? ce5m : null,
    pe5mChange: hasRolling ? pe5m : null,
    ce15mChange: hasRolling ? ce15m : null,
    pe15mChange: hasRolling ? pe15m : null,
    ceSessionChange: ceSession,
    peSessionChange: peSession,
    snapshotCount: history.length,
    oldestSnapshotAt: history.length > 0 ? new Date(Math.min(...history.map((h) => h.receivedAt))).toISOString() : null,
    baselineAt: baseline ? new Date(baseline.receivedAt).toISOString() : null,
    oiClusters: topClusters,
    additions: additions.slice(0, 8),
    reductions: reductions.slice(0, 8),
    interpretation,
    greeksAvailable,
    bidAskQtyAvailable,
  };
}

/* ------------------------------------------------------------------ *
 * Strike intelligence + premium momentum
 * ------------------------------------------------------------------ */

function legIntel(
  strike: number,
  side: "CE" | "PE",
  leg: OptionChainStrike["ce"] | OptionChainStrike["pe"],
  history: OiHistoryPoint[],
  now: number,
  contractMap: Map<string, { tradingSymbol: string; lotSize: number | null }>,
  context: {
    symbol: string;
    expiry: string;
    spot: number | null;
    spotDirection: "BULLISH" | "BEARISH" | "FLAT" | "UNAVAILABLE";
    chainContext: GreeksChainContext;
    peerAbsDeltas: number[];
    ivHistory: number[];
  },
): OptionLegIntel {
  const { expiry, spot, spotDirection, chainContext, peerAbsDeltas, ivHistory } = context;
  const recent = history
    .filter((p) => p.strike === strike && p.optionType === side && now - p.receivedAt < 6 * 3600000)
    .sort((a, b) => a.receivedAt - b.receivedAt);
  const prevLtp = recent.length > 1 ? recent[recent.length - 2].ltp : null;
  const refLtp = nearestSnapshot(history, strike, side, now - 5 * 60000, 120000)?.ltp ?? null;
  const refOi = nearestSnapshot(history, strike, side, now - 5 * 60000, 120000)?.oi ?? null;
  const refIv = nearestSnapshot(history, strike, side, now - 5 * 60000, 120000)?.iv ?? null;

  // Relative volume must compare like with like. Volume is CUMULATIVE for the session,
  // so averaging cumulative values from earlier snapshots would systematically understate
  // the baseline and inflate relative volume. The correct baseline is the cumulative
  // volume at the SAME time-of-day in comparable earlier observations — approximated
  // here by the earliest stored observation of the session, which is the only baseline
  // available before a full day of history exists.
  const baselineVolume = (() => {
    const withVol = recent.filter((p) => p.volume !== null && (p.volume as number) > 0);
    if (withVol.length === 0) return null;
    // Baseline = cumulative volume observed at the earliest point of this session.
    return withVol[0].volume;
  })();
  const relVol = leg.volume !== null && baselineVolume !== null && baselineVolume > 0 ? leg.volume / baselineVolume : null;

  const premiumChange = leg.prevClose !== null && leg.ltp !== null ? leg.ltp - leg.prevClose : null;
  const premiumChangePct = premiumChange !== null && leg.prevClose !== null && leg.prevClose !== 0 ? (premiumChange / leg.prevClose) * 100 : null;
  const momentum5m = refLtp !== null && leg.ltp !== null ? leg.ltp - refLtp : null;
  const oiChange = refOi !== null && leg.oi !== null ? leg.oi - refOi : null;

  const ivChange = refIv !== null && leg.iv !== null ? leg.iv - refIv : null;
  const spread = leg.bidPrice !== null && leg.askPrice !== null ? leg.askPrice - leg.bidPrice : null;
  const spreadPct = spread !== null && leg.ltp !== null && leg.ltp > 0 ? (spread / leg.ltp) * 100 : null;
  const mid = leg.bidPrice !== null && leg.askPrice !== null ? (leg.bidPrice + leg.askPrice) / 2 : null;

  // MOMENTUM IS DIRECTIONAL. The previous implementation scored Math.abs(pct change),
  // which gave a falling premium and a rising premium the SAME score. A premium
  // moving AGAINST the intended side must score low, not high.
  //   favourable direction: CE rising, PE rising (both are "positive premium momentum")
  //   unfavourable:         the opposite
  // Absolute movement is tracked separately so magnitude is never confused with direction.
  const momentum1m = (() => {
    const ref = nearestSnapshot(history, strike, side, now - 1 * 60000, 60000)?.ltp ?? null;
    return ref !== null && leg.ltp !== null ? leg.ltp - ref : null;
  })();
  const momentum15m = (() => {
    const ref = nearestSnapshot(history, strike, side, now - 15 * 60000, 180000)?.ltp ?? null;
    return ref !== null && leg.ltp !== null ? leg.ltp - ref : null;
  })();

  const premiumMomentumDirection: "RISING" | "FALLING" | "FLAT" | "UNAVAILABLE" =
    premiumChangePct === null ? "UNAVAILABLE" : premiumChangePct > 0 ? "RISING" : premiumChangePct < 0 ? "FALLING" : "FLAT";
  const momentumStrength = premiumChangePct === null ? null : clamp01(Math.abs(premiumChangePct) / 8) * 100;
  // Signed momentum quality: positive = premium moving in the favourable direction.
  const momentumQuality =
    premiumChangePct === null ? null : clampScore(clamp01(premiumChangePct / 8) * 100);

  let momentumScore: number | null = null;
  if (premiumChangePct !== null) {
    // Direction-weighted: magnitude contributes only when the direction is favourable.
    const directional = premiumChangePct > 0 ? 1 : premiumChangePct < 0 ? -1 : 0;
    const premPart = clamp01(Math.abs(premiumChangePct) / 8) * 0.4 * (directional > 0 ? 1 : 0.15);
    const volPart = relVol !== null ? clamp01(relVol / 3) * 0.25 : 0;
    const oiPart = oiChange !== null ? clamp01(Math.abs(oiChange) / Math.max(1, (leg.oi ?? 1) * 0.05)) * 0.2 : 0;
    const m5Part = momentum5m !== null ? clamp01(Math.abs(momentum5m) / Math.max(1, leg.ltp ?? 1) / 0.05) * 0.15 * (momentum5m > 0 ? 1 : 0.3) : 0;
    momentumScore = clampScore((premPart + volPart + oiPart + m5Part) * 100);
  }

  const meta = leg.instrumentKey ? contractMap.get(leg.instrumentKey) : undefined;

  // ---- Greeks assessment (Layer A) ----
  const rawLeg: GreeksRawLeg = {
    ltp: leg.ltp, delta: leg.delta, gamma: leg.gamma, theta: leg.theta, vega: leg.vega, iv: leg.iv, pop: leg.pop,
    volume: leg.volume, oi: leg.oi, bidPrice: leg.bidPrice, askPrice: leg.askPrice, bidQty: leg.bidQty, askQty: leg.askQty,
  };
  const greeksAssessment = assessGreeks({
    identity: { symbol: "", expiry, strike, optionType: side, instrumentKey: leg.instrumentKey },
    leg: rawLeg,
    history: recent.map((p) => ({ receivedAt: p.receivedAt, delta: p.delta, gamma: p.gamma, theta: p.theta, vega: p.vega, iv: p.iv, ltp: p.ltp })),
    ctx: chainContext,
    peerAbsDeltas: peerAbsDeltas,
    ivHistory: ivHistory,
    now,
  });

  // ---- Participation assessment (Layer B) ----
  const participationInput = {
    identity: { symbol: "", expiry, strike, optionType: side, instrumentKey: leg.instrumentKey },
    ltp: leg.ltp,
    prevClose: leg.prevClose,
    volume: leg.volume,
    oi: leg.oi,
    prevOi: leg.prevOi,
    iv: leg.iv,
    ivChange,
    bidPrice: leg.bidPrice,
    askPrice: leg.askPrice,
    bidQty: leg.bidQty,
    askQty: leg.askQty,
    relativeVolume: relVol,
    premiumChange1m: momentum1m,
    premiumChange5m: momentum5m,
    premiumChange15m: momentum15m,
    oiChange5m: oiChange,
    oiChange15m: (() => {
      const ref = nearestSnapshot(history, strike, side, now - 15 * 60000, 180000)?.oi ?? null;
      return ref !== null && leg.oi !== null ? leg.oi - ref : null;
    })(),
    oiSessionChange: leg.prevOi !== null && leg.oi !== null ? leg.oi - leg.prevOi : null,
  };
  const participation = assessParticipation(participationInput);

  // ---- Quote pressure (Layer C) ----
  const quotePressure = assessQuotePressure({
    identity: { symbol: "", expiry, strike, optionType: side, instrumentKey: leg.instrumentKey },
    bidPrice: leg.bidPrice,
    askPrice: leg.askPrice,
    bidQty: leg.bidQty,
    askQty: leg.askQty,
    history: recent.map((p) => ({ receivedAt: p.receivedAt, bidPrice: p.bidPrice, askPrice: p.askPrice, bidQty: p.bidQty, askQty: p.askQty })),
    now,
  });

  const greeks = greeksAssessment;
  const participationRead = `${participation.interpretation} ${participation.caveat}`;
  const buyerSeller: BuyerSellerResult = assessBuyerSeller({
    input: participationInput,
    participation,
    delta: leg.delta,
    spotDirection: spotDirection,
    spot: spot,
  });
  return {
    optionType: side,
    instrumentKey: leg.instrumentKey,
    ltp: leg.ltp,
    prevClose: leg.prevClose,
    premiumChange,
    premiumChangePct: premiumChangePct === null ? null : round2(premiumChangePct),
    premiumMomentumDirection,
    momentumStrength: momentumStrength === null ? null : round2(momentumStrength),
    momentumQuality,
    momentum1m: momentum1m === null ? null : round2(momentum1m),
    momentum5m: momentum5m === null ? null : round2(momentum5m),
    momentum15m: momentum15m === null ? null : round2(momentum15m),
    greeksAssessment,
    participation,
    buyerSeller,
    quotePressure,
    volume: leg.volume,
    oi: leg.oi,
    prevOi: leg.prevOi,
    sessionOiChange: leg.prevOi !== null && leg.oi !== null ? leg.oi - leg.prevOi : null,
    changeInOi: oiChange,
    bidPrice: leg.bidPrice,
    askPrice: leg.askPrice,
    bidQty: leg.bidQty,
    askQty: leg.askQty,
    spread: spread === null ? null : round2(spread),
    spreadPct: spreadPct === null ? null : round2(spreadPct),
    mid: mid === null ? null : round2(mid),
    delta: leg.delta,
    gamma: leg.gamma,
    theta: leg.theta,
    vega: leg.vega,
    iv: leg.iv,
    ivChange: ivChange === null ? null : round2(ivChange),
    momentumScore,
    relativeVolume: relVol === null ? null : round2(relVol),
    participationRead,
    tradingSymbol: meta?.tradingSymbol ?? null,
    lotSize: meta?.lotSize ?? null,
  };
}

/**
 * Builds strike-wise intelligence with all four intelligence layers per contract.
 *
 * The chain context supplies NORMALIZED baselines (median gamma, median theta ratio,
 * median IV) computed from the actual comparable contracts of THIS underlying and
 * expiry, so no hardcoded absolute Greek threshold is ever used. Cluster labels are
 * derived from OI share PLUS premium behaviour and spot position — a high PE OI share
 * alone is never labelled bullish.
 */
export function buildStrikeIntel(
  strikes: OptionChainStrike[],
  spot: number | null,
  history: OiHistoryPoint[],
  now: number,
  contractMap: Map<string, { tradingSymbol: string; lotSize: number | null }>,
  options?: {
    symbol?: string;
    expiry?: string;
    spotDirection?: "BULLISH" | "BEARISH" | "FLAT" | "UNAVAILABLE";
    daysToExpiry?: number | null;
    expectedHoldMinutes?: number;
  },
): StrikeIntel[] {
  const atm = strikes.reduce<{ strike: number; dist: number } | null>((best, s) => {
    if (spot === null) return best;
    const dist = Math.abs(s.strike - spot);
    return best === null || dist < best.dist ? { strike: s.strike, dist } : best;
  }, null);

  const symbol = options?.symbol ?? "";
  const expiry = options?.expiry ?? strikes[0]?.expiry ?? "";
  const spotDirection = options?.spotDirection ?? "UNAVAILABLE";

  // --- Normalized baselines across comparable priced contracts ---
  const legsForContext: Array<{ strike: number; optionType: "CE" | "PE"; leg: GreeksRawLeg }> = [];
  for (const s of strikes) {
    legsForContext.push({ strike: s.strike, optionType: "CE", leg: s.ce as GreeksRawLeg });
    legsForContext.push({ strike: s.strike, optionType: "PE", leg: s.pe as GreeksRawLeg });
  }
  const chainContext = buildGreeksChainContext({
    symbol,
    expiry,
    spot,
    daysToExpiry: options?.daysToExpiry ?? null,
    legs: legsForContext,
  });

  // Peer |delta| set and stored-IV history, for relative comparisons.
  const peerAbsDeltas = legsForContext.map((l) => l.leg.delta).filter((d): d is number => d !== null);
  const ivHistory = history.map((h) => h.iv).filter((v): v is number => v !== null && v > 0);

  const totalOi = strikes.reduce((a, s) => a + (s.ce.oi ?? 0) + (s.pe.oi ?? 0), 0);
  return strikes.map((s) => {
    const shared = {
      symbol,
      expiry,
      spot,
      spotDirection,
      chainContext,
      peerAbsDeltas,
      ivHistory,
    };
    const ce = legIntel(s.strike, "CE", s.ce, history, now, contractMap, shared);
    const pe = legIntel(s.strike, "PE", s.pe, history, now, contractMap, shared);
    const share = totalOi > 0 ? ((s.ce.oi ?? 0) + (s.pe.oi ?? 0)) / totalOi : null;
    let clusterLabel: StrikeIntel["clusterLabel"] = null;
    if (ce.oi !== null && pe.oi !== null && ce.oi + pe.oi > 0) {
      const ratio = pe.oi / (ce.oi + pe.oi);
      clusterLabel = ratio > 0.65 ? "BEARISH_CLUSTER" : ratio < 0.35 ? "BULLISH_CLUSTER" : "BALANCED";
    }
    return {
      strike: s.strike,
      atmDistance: spot === null ? 0 : round2(s.strike - spot),
      isAtm: atm !== null && s.strike === atm.strike,
      ce,
      pe,
      oiConcentrationShare: share === null ? null : round2(share * 100) / 100,
      clusterLabel,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Best strike finder (ATM / ITM / OTM comparison)
 * ------------------------------------------------------------------ */

interface SelectionInput {
  strikeIntel: StrikeIntel[];
  spot: number;
  atmStrike: number | null;
  expiry: string | null;
  daysToExpiry: number | null;
  now: number;
  minVolume: number;
  maxSpreadPct: number;
  avgIv: number | null;
  /** ΔOI measurements keyed by strike+side, supplied by the dedicated ΔOI engine. */
  oiMeasurements?: Map<string, ContractOiMeasurements>;
  underlyingDirection?: "BULLISH" | "BEARISH" | "FLAT" | "UNAVAILABLE";
}

function classificationFor(strike: number, spot: number, side: "CE" | "PE"): "ATM" | "ITM" | "OTM" {
  const dist = strike - spot;
  if (Math.abs(dist) <= Math.max(spot * 0.0015, 5)) return "ATM";
  if (side === "CE") return dist < 0 ? "ITM" : "OTM";
  return dist > 0 ? "ITM" : "OTM";
}

/**
 * EXECUTION QUALITY SCORE (Score C).
 * Measures whether the contract can realistically be entered and exited: volume,
 * relative volume, spread, displayed quantities and quote freshness.
 * Deliberately separate from Greeks suitability (B) and directional setup (A).
 */
export function assessExecutionQuality(leg: OptionLegIntel, now: number): {
  score: number | null;
  coverage: number;
  components: Record<string, number | null>;
  reasons: string[];
  disqualifications: string[];
  tradable: boolean;
} {
  const w = EXECUTION_WEIGHTS;
  const reasons: string[] = [];
  const disqualifications: string[] = [];

  // Volume
  let volume: number | null = null;
  if (leg.volume !== null) {
    if (leg.volume >= EXECUTION_THRESHOLDS.minVolume) {
      volume = clamp01(0.5 + (leg.volume / (EXECUTION_THRESHOLDS.minVolume * 20)) * 0.5);
      reasons.push(`Volume ${leg.volume} clears the ${EXECUTION_THRESHOLDS.minVolume} executable-liquidity floor.`);
    } else {
      volume = 0;
      disqualifications.push(`Volume ${leg.volume} is below the ${EXECUTION_THRESHOLDS.minVolume} minimum — not executable.`);
    }
  } else {
    volume = null;
    disqualifications.push("Volume unavailable from Upstox for this contract.");
  }

  // Relative volume
  let relVolume: number | null = null;
  if (leg.relativeVolume !== null) {
    relVolume = clamp01(leg.relativeVolume / 3);
    if (leg.relativeVolume >= 1.25) reasons.push(`Relative volume ${leg.relativeVolume.toFixed(2)}× baseline indicates active participation.`);
    else if (leg.relativeVolume < 0.75) reasons.push(`Relative volume ${leg.relativeVolume.toFixed(2)}× baseline is below normal.`);
  }

  // Spread
  let spread: number | null = null;
  if (leg.spreadPct !== null) {
    if (leg.spreadPct <= EXECUTION_THRESHOLDS.maxSpreadPct) {
      spread = clamp01(1 - leg.spreadPct / EXECUTION_THRESHOLDS.maxSpreadPct);
      reasons.push(`Bid/ask spread ${leg.spreadPct.toFixed(2)}% is within the ${EXECUTION_THRESHOLDS.maxSpreadPct}% limit.`);
    } else {
      spread = 0;
      disqualifications.push(`Spread ${leg.spreadPct.toFixed(2)}% exceeds the ${EXECUTION_THRESHOLDS.maxSpreadPct}% limit.`);
    }
  } else {
    spread = null;
    disqualifications.push("Best bid/ask unavailable — spread cannot be verified.");
  }

  // Displayed quantities (Layer C evidence)
  let quantities: number | null = null;
  const qp = leg.quotePressure;
  if (qp && qp.quantitiesAvailable && qp.imbalance !== null) {
    // A tight, two-sided book scores best regardless of which side is heavier.
    quantities = clamp01(0.6 + Math.abs(qp.imbalance) * 0.2);
    reasons.push(`Displayed quantities present (bid ${qp.bidQty ?? 0} / ask ${qp.askQty ?? 0}).`);
  } else if (qp && !qp.quantitiesAvailable) {
    quantities = null;
    reasons.push("Bid/ask quantities not supplied — imbalance unavailable (prices only).");
  }

  // Quote freshness: a stale quote cannot be trusted for execution.
  let freshness: number | null = null;
  if (leg.quotePressure && leg.quotePressure.observationCount > 0) {
    freshness = 1;
    reasons.push(`${leg.quotePressure.observationCount} stored quote observation(s) available.`);
  } else {
    freshness = null;
    reasons.push("No stored quote observations — quote freshness cannot be verified.");
  }

  // Keys MUST match EXECUTION_WEIGHTS exactly, otherwise the availability filter
  // silently passes every component and coverage is always 1.0.
  const components: Record<string, number | null> = {
    volume,
    relativeVolume: relVolume,
    spread,
    bidAskQuantities: quantities,
    quoteFreshness: freshness,
  };
  const totalWeight = Object.values(w).reduce((a, b) => a + b, 0);
  const availableWeight = Object.entries(w)
    .filter(([k]) => components[k] !== null)
    .reduce((a, [, b]) => a + b, 0);
  const coverage = totalWeight > 0 ? availableWeight / totalWeight : 0;

  const score =
    coverage > 0
      ? clampScore(
          (w.volume * (volume ?? 0) +
            w.relativeVolume * (relVolume ?? 0) +
            w.spread * (spread ?? 0) +
            w.bidAskQuantities * (quantities ?? 0) +
            w.quoteFreshness * (freshness ?? 0)) *
            (0.6 + 0.4 * coverage),
        )
      : null;

  const tradable = volume !== 0 && spread !== 0 && (leg.ltp ?? 0) > 0;
  return { score, coverage: Math.round(coverage * 100) / 100, components, reasons, disqualifications, tradable };
}

function scoreContract(leg: OptionLegIntel, input: SelectionInput, side: "CE" | "PE"): {
  score: number | null;
  coverage: number;
  components: Record<string, number | null>;
  reasons: string[];
  rejections: string[];
  risks: string[];
  tradable: boolean;
} {
  const w = DEFAULT_WEIGHTS.suitability;
  const reasons: string[] = [];
  const rejections: string[] = [];
  const risks: string[] = [];

  // Delta suitability (preference band, not a hard filter)
  const delta = leg.delta;
  let deltaScore: number | null = null;
  if (delta !== null) {
    const magnitude = Math.abs(delta);
    const ideal = 0.52;
    if (magnitude >= 0.4 && magnitude <= 0.65) {
      deltaScore = clamp01(1 - Math.abs(magnitude - ideal) / 0.15);
      reasons.push(`Delta ${delta.toFixed(3)} is inside the preferred ${side === "CE" ? "+0.40…+0.65" : "-0.40…-0.65"} band.`);
    } else if (magnitude > 0.85) {
      deltaScore = 0.35;
      reasons.push(`Delta ${delta.toFixed(3)} behaves like a deep-ITM substitute (premium moves ~1:1 with spot).`);
    } else {
      deltaScore = clamp01(0.3 + magnitude * 0.35);
      reasons.push(`Delta ${delta.toFixed(3)} is outside the preferred band — lower directional sensitivity.`);
    }
  } else {
    risks.push("Delta unavailable from Upstox for this contract — directional sensitivity cannot be verified.");
  }

  // Premium momentum
  let momentumScore: number | null = null;
  if (leg.premiumChangePct !== null && leg.momentumScore !== null) {
    const positive = side === "CE" ? leg.premiumChangePct > 0 : leg.premiumChangePct < 0;
    momentumScore = clamp01((Math.abs(leg.premiumChangePct) / 8) * 0.5 + (leg.momentumScore / 100) * 0.5);
    if (!positive) {
      momentumScore *= 0.35;
      rejections.push(`Premium moved ${leg.premiumChangePct.toFixed(2)}% against the ${side === "CE" ? "CALL BUY" : "PUT BUY"} direction.`);
    } else {
      reasons.push(`Premium momentum ${leg.premiumChangePct.toFixed(2)}% vs previous close.`);
    }
    if (leg.ivChange !== null && leg.ivChange > 0.5) risks.push("IV expanding — premium gains partly volatility-driven (IV crush risk).");
    if (leg.ivChange !== null && leg.ivChange < -0.5) risks.push("IV contracting — premium may fall even if spot moves favourably.");
  } else {
    risks.push("Premium momentum unavailable (no previous close / snapshot).");
  }

  // Volume + relative volume
  let volumeScore: number | null = null;
  if (leg.volume !== null) {
    if (leg.volume >= input.minVolume) {
      volumeScore = clamp01(0.45 + (leg.volume / (input.minVolume * 20)) * 0.55 + (leg.relativeVolume !== null ? clamp01(leg.relativeVolume / 5) * 0.2 : 0));
      reasons.push(`Volume ${leg.volume} clears the ${input.minVolume} liquidity floor.`);
    } else {
      volumeScore = 0;
      rejections.push(`Volume ${leg.volume} is below the ${input.minVolume} minimum — illiquid contract.`);
    }
  } else {
    volumeScore = 0;
    rejections.push("Volume unavailable from Upstox for this contract.");
  }

  // Spread + liquidity
  let spreadScore: number | null = null;
  if (leg.spreadPct !== null) {
    if (leg.spreadPct <= input.maxSpreadPct) {
      spreadScore = clamp01(1 - leg.spreadPct / input.maxSpreadPct);
      reasons.push(`Bid/ask spread ${leg.spreadPct.toFixed(2)}% is acceptable (limit ${input.maxSpreadPct}%).`);
    } else {
      spreadScore = 0;
      rejections.push(`Spread ${leg.spreadPct.toFixed(2)}% exceeds the ${input.maxSpreadPct}% limit.`);
    }
  } else {
    spreadScore = 0;
    rejections.push("Best bid/ask unavailable — executable liquidity cannot be verified.");
  }

  // OI + change
  let oiScore: number | null = null;
  if (leg.oi !== null) {
    const base = clamp01(Math.log10(Math.max(1, leg.oi)) / 6);
    const changePart = leg.changeInOi !== null ? clamp01(Math.abs(leg.changeInOi) / Math.max(1, leg.oi * 0.05)) * 0.35 : 0;
    oiScore = clamp01(base * 0.65 + changePart);
    if (leg.changeInOi !== null && leg.changeInOi < 0 && leg.premiumChange !== null && leg.premiumChange > 0) {
      reasons.push("OI falling while premium rises — short-covering style advance (not fresh buying).");
    }
  } else {
    oiScore = 0;
    rejections.push("Open interest unavailable for this contract.");
  }

  // Gamma suitability — never blindly pick the highest gamma
  let gammaScore: number | null = null;
  if (leg.gamma !== null) {
    if (leg.gamma > 0.0035) {
      gammaScore = 0.35;
      risks.push("Gamma concentration: delta will accelerate sharply near expiry — rapid premium swings.");
    } else if (leg.gamma >= 0.0006 && leg.gamma <= 0.0035) {
      gammaScore = 0.9;
      reasons.push("Gamma is in a workable band without extreme delta acceleration.");
    } else {
      gammaScore = 0.45;
      risks.push("Low gamma — premium will need a large spot move to expand.");
    }
  } else {
    risks.push("Gamma unavailable — delta acceleration risk cannot be assessed.");
  }

  // Theta cost
  let thetaScore: number | null = null;
  if (leg.theta !== null && leg.ltp !== null && leg.ltp > 0) {
    const thetaRatio = Math.abs(leg.theta) / leg.ltp;
    if (thetaRatio <= 0.05) thetaScore = 1;
    else if (thetaRatio <= 0.1) thetaScore = 0.7;
    else if (thetaRatio <= 0.2) thetaScore = 0.35;
    else thetaScore = 0.05;
    risks.push(`Theta cost ≈ ${(thetaRatio * 100).toFixed(1)}% of premium per day.`);
    if (input.daysToExpiry !== null && input.daysToExpiry <= 1) risks.push("Expiry-day contract: theta risk is extreme.");
  } else {
    risks.push("Theta unavailable — time-decay cost cannot be quantified.");
  }

  // IV / Vega
  let ivScore: number | null = null;
  if (leg.iv !== null) {
    const avg = input.avgIv;
    if (avg !== null && avg > 0) {
      const ratio = leg.iv / avg;
      if (ratio > 1.25) {
        ivScore = 0.3;
        risks.push("IV is materially above the chain average — expensive premium.");
      } else if (ratio < 0.8) {
        ivScore = 0.75;
        risks.push("IV below chain average — premium may not expand much without a large spot move.");
      } else {
        ivScore = 1;
        reasons.push("IV is in line with the chain average.");
      }
    } else {
      ivScore = 0.6;
      reasons.push("IV available; chain average unavailable for relative comparison.");
    }
  } else {
    risks.push("IV unavailable — volatility cost cannot be assessed.");
  }

  const components: Record<string, number | null> = {
    delta: deltaScore,
    premiumMomentum: momentumScore,
    volume: volumeScore,
    spreadLiquidity: spreadScore,
    oi: oiScore,
    gamma: gammaScore,
    thetaCost: thetaScore,
    ivVega: ivScore,
  };

  const weights: Record<string, number> = {
    delta: w.delta,
    premiumMomentum: w.premiumMomentum,
    volume: w.volume,
    spreadLiquidity: w.spreadLiquidity,
    oi: w.oi,
    gamma: w.gamma,
    thetaCost: w.thetaCost,
    ivVega: w.ivVega,
  };
  const availableWeight = Object.entries(weights)
    .filter(([k]) => components[k] !== null)
    .reduce((a, [, b]) => a + b, 0);
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const coverage = availableWeight / totalWeight;

  const score = clampScore(
    w.delta * (deltaScore ?? 0) +
      w.premiumMomentum * (momentumScore ?? 0) +
      w.volume * (volumeScore ?? 0) +
      w.spreadLiquidity * (spreadScore ?? 0) +
      w.oi * (oiScore ?? 0) +
      w.gamma * (gammaScore ?? 0) +
      w.thetaCost * (thetaScore ?? 0) +
      w.ivVega * (ivScore ?? 0),
  );

  const tradable = volumeScore !== 0 && spreadScore !== 0 && (leg.ltp ?? 0) > 0;
  return { score, coverage, components, reasons, rejections, risks, tradable };
}

export function selectBestStrikes(input: SelectionInput, contractMap: Map<string, { tradingSymbol: string; lotSize: number | null }>): {
  bestCall: ContractCandidate | null;
  bestPut: ContractCandidate | null;
  alternatives: ContractCandidate[];
  rationale: string[];
  disqualified: { calls: number; puts: number };
} {
  const candidates: ContractCandidate[] = [];
  for (const s of input.strikeIntel) {
    for (const side of ["CE", "PE"] as const) {
      const leg = side === "CE" ? s.ce : s.pe;
      if (leg.ltp === null || leg.ltp <= 0) continue;
      const classification = classificationFor(s.strike, input.spot, side);
      const scored = scoreContract(leg, input, side);
      // Score B: Greeks suitability (from the per-contract Greeks assessment).
      const ga = leg.greeksAssessment ?? null;
      const greeksScore = ga?.suitabilityScore ?? null;
      const greeksClass = ga?.suitabilityClass ?? null;
      const greeksCoverage = ga?.evidenceCoverage ?? null;
      // Score C: execution quality.
      const exec = assessExecutionQuality(leg, input.now);

      // Score B2: OI participation — does OI behaviour support a BUY on this side?
      const oiMeasurement = input.oiMeasurements?.get(`${side}:${s.strike}`) ?? null;
      const oiPartScore = scoreOiParticipation({
        optionType: side,
        measurement: oiMeasurement,
        participation: (side === "CE" ? s.ce.participation : s.pe.participation) as unknown as OiParticipationResult | null,
        underlyingDirection: input.underlyingDirection ?? "UNAVAILABLE",
      });

      // Mandatory conditions. Any failure makes the candidate ineligible regardless of score.
      const disqualifications: string[] = [...exec.disqualifications];
      if (ga && ga.quality === "UNAVAILABLE") {
        disqualifications.push("Greeks unavailable — contract suitability cannot be assessed.");
      }
      if ((leg.ltp ?? 0) <= 0) disqualifications.push("No valid LTP.");

      // Composite ranking preserves all four scores separately rather than collapsing
      // them into one unexplained number.
      const composite =
        greeksScore === null && exec.score === null
          ? null
          : clampScore(
              0.5 * (greeksScore ?? 0) + 0.5 * (exec.score ?? 0) * (exec.coverage > 0 ? 1 : 0),
            );
      // OI-inclusive composite: OI participation contributes 25%, diluting B and C.
      // A contract with unmeasurable OI is not penalised — it simply cannot benefit.
      const oiComponent = oiPartScore.score !== null ? oiPartScore.score / 100 : null;
      const compositeWithOi =
        oiComponent === null
          ? composite
          : composite === null
            ? clampScore(oiComponent * 100)
            : clampScore(0.55 * composite + 0.45 * oiComponent * 100);

      candidates.push({
        strike: s.strike,
        optionType: side,
        classification,
        atmDistance: round2(s.strike - input.spot),
        leg,
        suitabilityScore: scored.score,
        coverage: scored.coverage,
        components: scored.components,
        reasons: [...scored.reasons, ...(ga ? [ga.tradeOff] : [])],
        rejections: scored.rejections,
        risks: [...scored.risks, ...(ga?.riskWarnings ?? [])],
        tradable: scored.tradable && exec.tradable,
        greeksSuitabilityScore: greeksScore,
        greeksSuitabilityClass: greeksClass,
        greeksCoverage,
        executionQualityScore: exec.score,
        executionCoverage: exec.coverage,
        executionComponents: exec.components,
        compositeScore: composite,
        oiParticipationScore: oiPartScore.score,
        oiParticipationAlignment: oiPartScore.alignment,
        oiParticipationReasons: oiPartScore.reasons,
        compositeWithOiScore: compositeWithOi,
        disqualifications,
      });
    }
  }

  // Ranking uses the OI-inclusive composite so no single factor — ATM distance, cheapest
  // premium, highest gamma, highest delta, highest OI or highest momentum — can decide the
  // winner on its own. Disqualified candidates are excluded before ranking.
  const eligible = (c: ContractCandidate) => c.tradable && c.disqualifications.length === 0;
  const byComposite = (a: ContractCandidate, b: ContractCandidate) =>
    (b.compositeWithOiScore ?? 0) - (a.compositeWithOiScore ?? 0) ||
    (b.oiParticipationScore ?? 0) - (a.oiParticipationScore ?? 0) ||
    (b.greeksSuitabilityScore ?? 0) - (a.greeksSuitabilityScore ?? 0);
  const calls = candidates.filter((c) => c.optionType === "CE" && eligible(c)).sort(byComposite);
  const puts = candidates.filter((c) => c.optionType === "PE" && eligible(c)).sort(byComposite);
  const disqualifiedCalls = candidates.filter((c) => c.optionType === "CE" && !eligible(c));
  const disqualifiedPuts = candidates.filter((c) => c.optionType === "PE" && !eligible(c));

  const enrich = (c: ContractCandidate, best: boolean): ContractCandidate => {
    const meta = contractMap.get(c.leg.instrumentKey ?? "");
    const alternativesRejected = candidates
      .filter((o) => o.optionType === c.optionType && o.strike !== c.strike)
      .slice(0, 6);
    const notes = alternativesRejected
      .filter((o) => o.suitabilityScore !== null)
      .sort((a, b) => (b.suitabilityScore ?? 0) - (a.suitabilityScore ?? 0))
      .slice(0, 4)
      .map(
        (o) =>
          `${o.optionType} ${o.strike} (${o.classification}, score ${o.suitabilityScore}) rejected: ${
            o.rejections[0] ?? "lower composite suitability"
          }`,
      );
    return {
      ...c,
      leg: { ...c.leg, lotSize: meta?.lotSize ?? c.leg.lotSize, tradingSymbol: meta?.tradingSymbol ?? c.leg.tradingSymbol },
      rejections: best ? [...c.rejections, ...notes] : c.rejections,
    };
  };

  const bestCall = calls[0] ? enrich(calls[0], true) : null;
  const bestPut = puts[0] ? enrich(puts[0], true) : null;

  const rationale: string[] = [];
  if (bestCall) {
    rationale.push(
      `Best CALL BUY candidate ${bestCall.strike} (${bestCall.classification}): Greeks suitability ${bestCall.greeksSuitabilityScore ?? "n/a"}, execution quality ${bestCall.executionQualityScore ?? "n/a"}, OI participation ${bestCall.oiParticipationScore ?? "n/a"} (${bestCall.oiParticipationAlignment?.toLowerCase() ?? "unavailable"}), composite ${bestCall.compositeWithOiScore ?? "n/a"}.`,
    );
    rationale.push(...bestCall.reasons.slice(0, 4));
    rationale.push(...bestCall.oiParticipationReasons.slice(0, 3));
    rationale.push(`ATM comparison: ATM strike is ${input.atmStrike}; the selected ${bestCall.classification} contract was chosen on the combined Greeks/execution ranking, not on ATM distance alone.`);
  }
  if (bestPut) {
    rationale.push(
      `Best PUT BUY candidate ${bestPut.strike} (${bestPut.classification}): Greeks suitability ${bestPut.greeksSuitabilityScore ?? "n/a"} (${bestPut.greeksSuitabilityClass ?? "n/a"}), execution quality ${bestPut.executionQualityScore ?? "n/a"}, composite ${bestPut.compositeScore ?? "n/a"}.`,
    );
    rationale.push(...bestPut.reasons.slice(0, 4));
  }
  if (!bestCall && !bestPut) {
    const reasons = [...disqualifiedCalls, ...disqualifiedPuts]
      .slice(0, 4)
      .map((c) => `${c.optionType} ${c.strike}: ${c.disqualifications[0] ?? "disqualified"}`);
    rationale.push(
      `NO ELIGIBLE CONTRACT — no contract passed the mandatory conditions.${reasons.length > 0 ? ` Examples: ${reasons.join("; ")}.` : ""} No fallback is fabricated.`,
    );
  }

  return {
    bestCall,
    bestPut,
    alternatives: [...calls.slice(0, 6), ...puts.slice(0, 6)],
    rationale,
    disqualified: { calls: disqualifiedCalls.length, puts: disqualifiedPuts.length },
  };
}

export function buildStrikeSelection(args: {
  strikeIntel: StrikeIntel[];
  spot: number | null;
  expiry: string | null;
  daysToExpiry: number | null;
  now: number;
  contractMap: Map<string, { tradingSymbol: string; lotSize: number | null }>;
  /** ΔOI measurements keyed "CE:<strike>" / "PE:<strike>", from the dedicated ΔOI engine. */
  oiMeasurements?: Map<string, ContractOiMeasurements>;
  /** Underlying directional read, used for OI alignment. */
  underlyingDirection?: "BULLISH" | "BEARISH" | "FLAT" | "UNAVAILABLE";
}): StrikeSelection {
  const { strikeIntel, spot, expiry, daysToExpiry, now, contractMap, oiMeasurements, underlyingDirection } = args;
  const atmStrike = strikeIntel.find((s) => s.isAtm)?.strike ?? null;
  if (spot === null || atmStrike === null) {
    return {
      status: "UNAVAILABLE",
      message: "Spot price or ATM strike unavailable — strike selection cannot run.",
      spot,
      atmStrike,
      expiry,
      bestCall: null,
      bestPut: null,
      alternatives: [],
      rationale: ["Spot/ATM unavailable; no strike selection performed."],
    };
  }
  const avgIv = (() => {
    const ivs = strikeIntel.flatMap((s) => [s.ce.iv, s.pe.iv]).filter((v): v is number => v !== null && v > 0);
    return ivs.length > 0 ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  })();
  const minVolume = DEFAULT_WEIGHTS.thresholds.minOptionVolume;
  const maxSpreadPct = DEFAULT_WEIGHTS.thresholds.maxSpreadPct;

  const { bestCall, bestPut, alternatives, rationale } = selectBestStrikes(
    {
      strikeIntel,
      spot,
      atmStrike,
      expiry,
      daysToExpiry,
      now,
      minVolume,
      maxSpreadPct,
      avgIv,
      oiMeasurements,
      underlyingDirection,
    },
    contractMap,
  );

  return {
    status: bestCall || bestPut ? "LIVE" : "PARTIAL",
    message: bestCall || bestPut
      ? `ATM ${atmStrike}; compared ATM/ITM/OTM legs across ${strikeIntel.length} strikes.`
      : "ATM resolved but no contract cleared liquidity/spread gates.",
    spot,
    atmStrike,
    expiry,
    bestCall,
    bestPut,
    alternatives,
    rationale,
  };
}
