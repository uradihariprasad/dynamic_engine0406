import { clamp01, clampScore, round2 } from "@/lib/engine/indicators";

/**
 * CENTRALIZED GREEKS INTELLIGENCE ENGINE.
 *
 * SCOPE (and deliberately not more): Greeks describe option-PRICE SENSITIVITIES.
 * They do NOT identify whether buyers or sellers are dominating. This module
 * therefore computes per-contract sensitivity and risk only. Participation and
 * quote-pressure inference live in src/lib/engine/participation.ts, and executed
 * buyer/seller dominance is explicitly NOT AVAILABLE (no trade-level aggressor
 * data exists in the Upstox market-data API).
 *
 * Every contract is processed independently under the canonical identity
 *   symbol + expiry + strike + CE/PE + instrument_key
 * so Greeks can never be mixed across contracts, expiries or sides.
 */

export type GreeksQuality = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

export type SuitabilityClass =
  | "EXCELLENT SUITABILITY"
  | "GOOD SUITABILITY"
  | "MODERATE SUITABILITY"
  | "POOR SUITABILITY"
  | "INSUFFICIENT DATA";

export interface GreeksContractIdentity {
  symbol: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  instrumentKey: string | null;
}

export interface GreeksRawLeg {
  ltp: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  pop: number | null;
  volume: number | null;
  oi: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  bidQty: number | null;
  askQty: number | null;
}

export interface GreeksHistoryPoint {
  receivedAt: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  ltp: number | null;
}

/** Delta preference band for a directional BUY candidate. Configurable, not a filter. */
export interface DeltaPreference {
  minAbs: number;
  maxAbs: number;
  ideal: number;
}

export const DELTA_PREFERENCE: DeltaPreference = { minAbs: 0.4, maxAbs: 0.65, ideal: 0.52 };

/** Weights for the Greeks Suitability Score. Sum = 100. Engineering weights only. */
export const GREEKS_SUITABILITY_WEIGHTS = {
  delta: 30,
  gamma: 15,
  thetaCost: 25,
  ivVega: 20,
  expiryRisk: 10,
} as const;

export const GREEKS_SUITABILITY_THRESHOLDS = {
  /** Minimum days to expiry before expiry-day decay is treated as extreme risk. */
  minDaysForComfort: 2,
  /** Theta/LTP above this per day is considered expensive. */
  thetaPctWarning: 0.1,
  thetaPctSevere: 0.2,
} as const;

/** Upstox theta convention, verified against the /v2/option/chain documentation. */
export const THETA_CONVENTION =
  "Upstox option_greeks.theta is supplied as premium change PER ANNUM-equivalent daily decay for the contract (negative for long option holders). Values are used as-is and compared RATIO TO LTP, so the absolute time-base cancels out of every ranking decision.";

/** Context shared by all contracts of one underlying + expiry, used for normalized comparisons. */
export interface GreeksChainContext {
  symbol: string;
  expiry: string;
  spot: number | null;
  /** Median absolute gamma across comparable priced strikes (normalization baseline). */
  medianAbsGamma: number | null;
  /** Median |theta| / LTP ratio across comparable priced strikes. */
  medianThetaRatio: number | null;
  /** Median IV across comparable priced strikes. */
  medianIv: number | null;
  /** Days to expiry, floored at 0. */
  daysToExpiry: number | null;
  /** Number of contracts contributing to the baselines. */
  comparableCount: number;
}

export interface DeltaIntel {
  value: number | null;
  absolute: number | null;
  directional: number | null;
  /** Sign correctness for this side: CE must be >= 0, PE must be <= 0. */
  signValid: boolean | null;
  /** Position inside/outside the preference band with a plain-language reason. */
  band: "INSIDE" | "BELOW" | "ABOVE";
  bandReason: string;
  /** 0..1 suitability of this delta for a BUY candidate. */
  suitability: number | null;
  changeFromHistory: number | null;
  /** |delta| relative to the median |delta| of comparable strikes. */
  relativeToPeers: number | null;
}

export interface GammaIntel {
  value: number | null;
  absolute: number | null;
  changeFromHistory: number | null;
  /** Absolute gamma / median comparable gamma. 1.0 = typical. */
  relativeToPeers: number | null;
  classification: "EXTREME" | "HIGH" | "MODERATE" | "LOW" | "UNAVAILABLE";
  /** Extra delta per 1% underlying move implied by gamma (contract units). */
  deltaAccelerationPerPct: number | null;
  expiryAdjustedRisk: "LOW" | "ELEVATED" | "SEVERE" | "UNAVAILABLE";
  reason: string;
}

export interface ThetaIntel {
  value: number | null;
  /** |theta| / LTP — the comparable, unit-independent decay cost. */
  ratioToLtp: number | null;
  relativeToPeers: number | null;
  classification: "CHEAP" | "REASONABLE" | "EXPENSIVE" | "SEVERE" | "UNAVAILABLE";
  /** Projected decay over the expected holding horizon, in premium units. */
  projectedDecayOverHold: number | null;
  expiryDayRisk: boolean;
  convention: string;
  reason: string;
}

export interface VegaIntel {
  value: number | null;
  iv: number | null;
  ivChange: number | null;
  /** IV / median comparable IV. 1.0 = typical. */
  ivRelativeToPeers: number | null;
  ivPercentile: number | null;
  classification: "ELEVATED" | "NORMAL" | "BELOW_NORMAL" | "UNAVAILABLE";
  expansionRisk: string | null;
  contractionRisk: string | null;
  reason: string;
}

export interface GreeksAssessment {
  identity: GreeksContractIdentity;
  quality: GreeksQuality;
  /** Which Greek fields were actually present. */
  present: string[];
  missing: string[];
  delta: DeltaIntel;
  gamma: GammaIntel;
  theta: ThetaIntel;
  vega: VegaIntel;
  /** 0..100 Greeks Suitability Score for a BUY candidate on this side. */
  suitabilityScore: number | null;
  suitabilityClass: SuitabilityClass;
  /** Weighted coverage of available Greek inputs (0..1). */
  evidenceCoverage: number;
  riskWarnings: string[];
  /** Plain-language trade-off explanation (sensitivity vs cost vs risk). */
  tradeOff: string;
}

/* ------------------------------------------------------------------ *
 * Chain-wide context (normalization baselines)
 * ------------------------------------------------------------------ */

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Builds normalized baselines across comparable contracts of the SAME underlying and
 * expiry. No hardcoded absolute gamma/theta/IV thresholds are used: a gamma of 0.0011
 * is normal for NIFTY and meaningless for SENSEX, so every classification is relative
 * to the actual comparable set.
 */
export function buildGreeksChainContext(args: {
  symbol: string;
  expiry: string;
  spot: number | null;
  daysToExpiry: number | null;
  legs: Array<{ strike: number; optionType: "CE" | "PE"; leg: GreeksRawLeg }>;
}): GreeksChainContext {
  const priced = args.legs.filter((l) => l.leg.ltp !== null && l.leg.ltp > 0);
  const absGammas = priced.map((l) => (l.leg.gamma !== null ? Math.abs(l.leg.gamma) : -1)).filter((g) => g >= 0);
  const thetaRatios = priced
    .map((l) => (l.leg.theta !== null && l.leg.ltp !== null && l.leg.ltp > 0 ? Math.abs(l.leg.theta) / l.leg.ltp : -1))
    .filter((t) => t >= 0);
  const ivs = priced.map((l) => l.leg.iv).filter((v): v is number => v !== null && v > 0);

  return {
    symbol: args.symbol,
    expiry: args.expiry,
    spot: args.spot,
    medianAbsGamma: median(absGammas),
    medianThetaRatio: median(thetaRatios),
    medianIv: median(ivs),
    daysToExpiry: args.daysToExpiry,
    comparableCount: priced.length,
  };
}

/* ------------------------------------------------------------------ *
 * Per-contract assessments
 * ------------------------------------------------------------------ */

function nearestPoint(history: GreeksHistoryPoint[], target: number, toleranceMs: number): GreeksHistoryPoint | null {
  let best: GreeksHistoryPoint | null = null;
  let bestDelta = Infinity;
  for (const p of history) {
    const d = Math.abs(p.receivedAt - target);
    if (d < bestDelta) {
      bestDelta = d;
      best = p;
    }
  }
  return best && bestDelta <= toleranceMs ? best : null;
}

function assessDelta(args: {
  leg: GreeksRawLeg;
  side: "CE" | "PE";
  history: GreeksHistoryPoint[];
  now: number;
  peerAbsDeltas: number[];
}): DeltaIntel {
  const { leg, side, history, now, peerAbsDeltas } = args;
  const value = leg.delta;
  if (value === null) {
    return {
      value: null,
      absolute: null,
      directional: null,
      signValid: null,
      band: "INSIDE",
      bandReason: "Delta unavailable from Upstox for this contract.",
      suitability: null,
      changeFromHistory: null,
      relativeToPeers: null,
    };
  }
  const absolute = Math.abs(value);
  // Directional delta: signed so that "more positive = more favourable for a BUY on this side".
  const directional = side === "CE" ? value : -value;
  const signValid = side === "CE" ? value >= 0 : value <= 0;

  const ref = nearestPoint(history, now - 5 * 60000, 120000);
  const changeFromHistory = ref?.delta !== null && ref?.delta !== undefined ? value - ref.delta : null;

  const peerMedian = median(peerAbsDeltas.map((d) => Math.abs(d)));
  const relativeToPeers = peerMedian && peerMedian > 0 ? absolute / peerMedian : null;

  // Preference band: a preference, never a hard filter. Outside-band contracts are
  // scored lower, not discarded, and the trade-off is always explained.
  let band: DeltaIntel["band"] = "INSIDE";
  let bandReason = "";
  let suitability: number;
  if (absolute < DELTA_PREFERENCE.minAbs) {
    band = "BELOW";
    suitability = clamp01(0.25 + (absolute / DELTA_PREFERENCE.minAbs) * 0.45);
    bandReason = `|Delta| ${absolute.toFixed(3)} is below the preferred ${DELTA_PREFERENCE.minAbs}–${DELTA_PREFERENCE.maxAbs} band: lower premium sensitivity, so a larger underlying move is needed for the same premium gain. Cheaper premium is the offsetting benefit.`;
  } else if (absolute > DELTA_PREFERENCE.maxAbs) {
    band = "ABOVE";
    // Deep ITM behaves like a spot substitute: high sensitivity but little leverage.
    suitability = absolute > 0.9 ? 0.45 : clamp01(0.75 - (absolute - DELTA_PREFERENCE.maxAbs) * 0.8);
    bandReason =
      absolute > 0.9
        ? `|Delta| ${absolute.toFixed(3)} behaves like a deep-ITM spot substitute: premium moves ~1:1 with the underlying, so leverage and gamma benefit are largely lost despite high sensitivity.`
        : `|Delta| ${absolute.toFixed(3)} is above the preferred ${DELTA_PREFERENCE.minAbs}–${DELTA_PREFERENCE.maxAbs} band: higher premium sensitivity but a more expensive contract and less percentage leverage.`;
  } else {
    suitability = clamp01(1 - Math.abs(absolute - DELTA_PREFERENCE.ideal) / 0.15);
    bandReason = `|Delta| ${absolute.toFixed(3)} is inside the preferred ${DELTA_PREFERENCE.minAbs}–${DELTA_PREFERENCE.maxAbs} band: a workable balance of premium sensitivity and cost.`;
  }
  if (!signValid) {
    suitability = clamp01((suitability ?? 0) * 0.4);
    bandReason += ` Sign is unexpected for a ${side} contract (documented convention: CE positive, PE negative) — treated as a data-quality concern.`;
  }

  return {
    value,
    absolute: round2(absolute),
    directional: round2(directional),
    signValid,
    band,
    bandReason,
    suitability: suitability === null ? null : round2(suitability),
    changeFromHistory: changeFromHistory === null ? null : round2(changeFromHistory),
    relativeToPeers: relativeToPeers === null ? null : round2(relativeToPeers),
  };
}

function assessGamma(args: {
  leg: GreeksRawLeg;
  spot: number | null;
  daysToExpiry: number | null;
  history: GreeksHistoryPoint[];
  now: number;
  ctx: GreeksChainContext;
}): GammaIntel {
  const { leg, spot, daysToExpiry, history, now, ctx } = args;
  const value = leg.gamma;
  if (value === null) {
    return {
      value: null,
      absolute: null,
      changeFromHistory: null,
      relativeToPeers: null,
      classification: "UNAVAILABLE",
      deltaAccelerationPerPct: null,
      expiryAdjustedRisk: "UNAVAILABLE",
      reason: "Gamma unavailable from Upstox for this contract.",
    };
  }
  const absolute = Math.abs(value);
  const ref = nearestPoint(history, now - 5 * 60000, 120000);
  const changeFromHistory = ref?.gamma !== null && ref?.gamma !== undefined ? value - ref.gamma : null;

  // Normalized comparison: no hardcoded absolute threshold.
  const medianGamma = ctx.medianAbsGamma;
  const rel = medianGamma && medianGamma > 0 ? absolute / medianGamma : null;
  const classification: GammaIntel["classification"] =
    rel === null ? "UNAVAILABLE" : rel >= 2 ? "EXTREME" : rel >= 1.4 ? "HIGH" : rel >= 0.6 ? "MODERATE" : "LOW";

  // Delta acceleration: gamma * price move. Expressed per 1% underlying move so units
  // are comparable across underlyings.
  const deltaAccelerationPerPct = spot !== null && spot > 0 ? round2(absolute * (spot * 0.01)) : null;

  // Expiry-adjusted risk: gamma is largest close to expiry for near-the-money strikes.
  const expiryAdjustedRisk: GammaIntel["expiryAdjustedRisk"] =
    daysToExpiry === null ? "UNAVAILABLE" : daysToExpiry <= 1 ? (classification === "EXTREME" || classification === "HIGH" ? "SEVERE" : "ELEVATED") : daysToExpiry <= 3 && (classification === "EXTREME" || classification === "HIGH") ? "ELEVATED" : "LOW";

  const parts: string[] = [];
  if (rel !== null) {
    parts.push(
      classification === "EXTREME"
        ? `Gamma is ${rel.toFixed(2)}× the median of ${ctx.comparableCount} comparable contracts — delta will accelerate sharply.`
        : classification === "HIGH"
          ? `Gamma is ${rel.toFixed(2)}× the comparable median — above-typical delta acceleration.`
          : classification === "LOW"
            ? `Gamma is ${rel.toFixed(2)}× the comparable median — premium needs a large underlying move to expand.`
            : `Gamma is ${rel.toFixed(2)}× the comparable median — typical for this strike set.`,
    );
  }
  if (expiryAdjustedRisk === "SEVERE") parts.push(`Only ${daysToExpiry} day(s) to expiry with ${classification.toLowerCase()} gamma: premium instability risk is severe.`);
  else if (expiryAdjustedRisk === "ELEVATED") parts.push(`Expiry proximity (${daysToExpiry} day(s)) amplifies gamma-driven premium swings.`);

  return {
    value,
    absolute,
    changeFromHistory: changeFromHistory === null ? null : round2(changeFromHistory),
    relativeToPeers: rel === null ? null : round2(rel),
    classification,
    deltaAccelerationPerPct,
    expiryAdjustedRisk,
    reason: parts.join(" ") || "Gamma present.",
  };
}

function assessTheta(args: {
  leg: GreeksRawLeg;
  daysToExpiry: number | null;
  expectedHoldMinutes: number;
  history: GreeksHistoryPoint[];
  now: number;
  ctx: GreeksChainContext;
}): ThetaIntel {
  const { leg, daysToExpiry, expectedHoldMinutes, history, now, ctx } = args;
  const value = leg.theta;
  const convention = THETA_CONVENTION;
  if (value === null || leg.ltp === null || leg.ltp <= 0) {
    return {
      value,
      ratioToLtp: null,
      relativeToPeers: null,
      classification: "UNAVAILABLE",
      projectedDecayOverHold: null,
      expiryDayRisk: false,
      convention,
      reason:
        value === null
          ? "Theta unavailable from Upstox for this contract."
          : "Theta present but LTP unavailable, so relative decay cost cannot be computed.",
    };
  }
  const ratioToLtp = Math.abs(value) / leg.ltp;
  const peerMedian = ctx.medianThetaRatio;
  const rel = peerMedian && peerMedian > 0 ? ratioToLtp / peerMedian : null;

  // Because the ratio is unit-independent, the same thresholds apply across underlyings.
  const classification: ThetaIntel["classification"] =
    ratioToLtp <= GREEKS_SUITABILITY_THRESHOLDS.thetaPctWarning * 0.5
      ? "CHEAP"
      : ratioToLtp <= GREEKS_SUITABILITY_THRESHOLDS.thetaPctWarning
        ? "REASONABLE"
        : ratioToLtp <= GREEKS_SUITABILITY_THRESHOLDS.thetaPctSevere
          ? "EXPENSIVE"
          : "SEVERE";

  // Projected decay across the intended holding horizon (linear approximation).
  const projectedDecayOverHold = round2(Math.abs(value) * (expectedHoldMinutes / (60 * 24)));

  const expiryDayRisk = daysToExpiry !== null && daysToExpiry <= 1;

  const parts: string[] = [];
  parts.push(`Decay cost is ${(ratioToLtp * 100).toFixed(2)}% of premium — ${classification.toLowerCase()} relative to the ${GREEKS_SUITABILITY_THRESHOLDS.thetaPctWarning * 100}%/day warning level.`);
  if (rel !== null) parts.push(`${rel.toFixed(2)}× the comparable-contract median decay cost.`);
  parts.push(`Projected decay over a ${expectedHoldMinutes}-minute hold ≈ ${projectedDecayOverHold} premium points.`);
  if (expiryDayRisk) parts.push(`Expiry-day contract: decay risk is extreme and requires immediate directional confirmation.`);
  if (classification === "SEVERE" || classification === "EXPENSIVE") {
    parts.push("High decay cost is not an automatic rejection: a fast, confirmed move can still justify it — the expected move must exceed the decay.");
  }

  return {
    value,
    ratioToLtp: round2(ratioToLtp),
    relativeToPeers: rel === null ? null : round2(rel),
    classification,
    projectedDecayOverHold,
    expiryDayRisk,
    convention,
    reason: parts.join(" "),
  };
}

function assessVega(args: {
  leg: GreeksRawLeg;
  history: GreeksHistoryPoint[];
  now: number;
  ctx: GreeksChainContext;
  ivHistory: number[];
}): VegaIntel {
  const { leg, history, now, ctx, ivHistory } = args;
  const value = leg.vega;
  const iv = leg.iv;
  if (value === null && iv === null) {
    return {
      value: null,
      iv: null,
      ivChange: null,
      ivRelativeToPeers: null,
      ivPercentile: null,
      classification: "UNAVAILABLE",
      expansionRisk: null,
      contractionRisk: null,
      reason: "Vega and IV both unavailable from Upstox for this contract.",
    };
  }

  const ref = nearestPoint(history, now - 5 * 60000, 120000);
  const ivChange = iv !== null && ref?.iv !== null && ref?.iv !== undefined ? iv - ref.iv : null;

  const ivRel = ctx.medianIv && ctx.medianIv > 0 && iv !== null ? iv / ctx.medianIv : null;
  // IV percentile requires genuine historical IV observations — not fabricated from one point.
  const ivPercentile =
    ivHistory.length >= 10 && iv !== null
      ? round2((ivHistory.filter((v) => v <= iv).length / ivHistory.length) * 100)
      : null;

  const classification: VegaIntel["classification"] =
    iv === null ? "UNAVAILABLE" : ivRel === null ? "NORMAL" : ivRel >= 1.25 ? "ELEVATED" : ivRel <= 0.8 ? "BELOW_NORMAL" : "NORMAL";

  const parts: string[] = [];
  let expansionRisk: string | null = null;
  let contractionRisk: string | null = null;
  if (value !== null && iv !== null) {
    expansionRisk = `A 1-point IV rise would add ≈${round2(value)} to premium (vega ${value}).`;
    contractionRisk = `A 1-point IV fall would remove ≈${round2(value)} from premium.`;
  }
  if (iv !== null && ivChange !== null) {
    if (ivChange > 0) parts.push(`IV is expanding (${ivChange > 0 ? "+" : ""}${round2(ivChange)} vs ~5m ago) — favourable for a long option, but confirms premium gains are partly volatility-driven.`);
    else if (ivChange < 0) parts.push(`IV is contracting (${round2(ivChange)} vs ~5m ago) — premium can fall even if the underlying moves favourably (IV crush risk).`);
  }
  if (classification === "ELEVATED") parts.push(`IV ${iv} is ${ivRel?.toFixed(2)}× the comparable median — the option is expensive relative to this strike set.`);
  else if (classification === "BELOW_NORMAL") parts.push(`IV ${iv} is ${ivRel?.toFixed(2)}× the comparable median — cheaper, but premium may not expand much without a large move.`);
  if (ivPercentile !== null) parts.push(`IV percentile ${ivPercentile} computed from ${ivHistory.length} stored observations.`);

  return {
    value,
    iv,
    ivChange: ivChange === null ? null : round2(ivChange),
    ivRelativeToPeers: ivRel === null ? null : round2(ivRel),
    ivPercentile,
    classification,
    expansionRisk,
    contractionRisk,
    reason: parts.join(" ") || "Vega/IV present.",
  };
}

/**
 * Full per-contract Greeks assessment. Each contract is evaluated independently and
 * the identity is carried through so no cross-contract contamination is possible.
 */
export function assessGreeks(args: {
  identity: GreeksContractIdentity;
  leg: GreeksRawLeg;
  history: GreeksHistoryPoint[];
  ctx: GreeksChainContext;
  peerAbsDeltas: number[];
  ivHistory: number[];
  now: number;
  expectedHoldMinutes?: number;
}): GreeksAssessment {
  const { identity, leg, history, ctx, peerAbsDeltas, ivHistory, now } = args;
  const expectedHoldMinutes = args.expectedHoldMinutes ?? 60;

  const present: string[] = [];
  const missing: string[] = [];
  for (const [key, value] of Object.entries({
    delta: leg.delta,
    gamma: leg.gamma,
    theta: leg.theta,
    vega: leg.vega,
    iv: leg.iv,
  })) {
    if (value === null) missing.push(key);
    else present.push(key);
  }
  const quality: GreeksQuality = missing.length === 0 ? "COMPLETE" : present.length === 0 ? "UNAVAILABLE" : "PARTIAL";

  const delta = assessDelta({ leg, side: identity.optionType, history, now, peerAbsDeltas });
  const gamma = assessGamma({ leg, spot: ctx.spot, daysToExpiry: ctx.daysToExpiry, history, now, ctx });
  const theta = assessTheta({ leg, daysToExpiry: ctx.daysToExpiry, expectedHoldMinutes, history, now, ctx });
  const vega = assessVega({ leg, history, now, ctx, ivHistory });

  // ---- Greeks Suitability Score (separate from directional setup and execution) ----
  const components: Record<string, number | null> = {
    delta: delta.suitability,
    gamma: gamma.classification === "UNAVAILABLE" ? null : gamma.classification === "EXTREME" ? 0.35 : gamma.classification === "HIGH" ? (ctx.daysToExpiry !== null && ctx.daysToExpiry <= 1 ? 0.4 : 0.85) : gamma.classification === "MODERATE" ? 1 : 0.6,
    thetaCost: theta.classification === "UNAVAILABLE" ? null : theta.classification === "CHEAP" ? 1 : theta.classification === "REASONABLE" ? 0.8 : theta.classification === "EXPENSIVE" ? 0.4 : 0.15,
    ivVega: vega.classification === "UNAVAILABLE" ? null : vega.classification === "NORMAL" ? 1 : vega.classification === "BELOW_NORMAL" ? 0.7 : 0.4,
    expiryRisk: ctx.daysToExpiry === null ? null : ctx.daysToExpiry <= 1 ? 0.25 : ctx.daysToExpiry <= 3 ? 0.6 : 1,
  };

  const totalWeight = Object.values(GREEKS_SUITABILITY_WEIGHTS).reduce((a, b) => a + b, 0);
  const availableWeight = Object.entries(GREEKS_SUITABILITY_WEIGHTS)
    .filter(([k]) => components[k] !== null)
    .reduce((a, [, b]) => a + b, 0);
  const evidenceCoverage = totalWeight > 0 ? availableWeight / totalWeight : 0;

  const riskWarnings: string[] = [];
  if (gamma.expiryAdjustedRisk === "SEVERE") riskWarnings.push("Severe expiry-day gamma risk: premium can swing violently.");
  if (theta.classification === "SEVERE") riskWarnings.push(`Severe decay cost (${((theta.ratioToLtp ?? 0) * 100).toFixed(1)}% of premium).`);
  if (vega.classification === "ELEVATED") riskWarnings.push("IV is elevated relative to comparable contracts: premium is expensive and exposed to IV crush.");
  if (vega.ivChange !== null && vega.ivChange < -0.5) riskWarnings.push("IV is contracting: favourable spot movement may not translate into premium gains.");
  if (delta.signValid === false) riskWarnings.push("Delta sign does not match the documented convention for this side.");
  if (quality === "UNAVAILABLE") riskWarnings.push("No Greeks available: contract suitability cannot be assessed from sensitivities.");

  let suitabilityScore: number | null = null;
  // A contract with no Greeks at all cannot be scored at all: any nonzero number
  // here would be a residual of the expiry component only and would be misleading.
  if (quality === "UNAVAILABLE") {
    suitabilityScore = null;
  } else if (evidenceCoverage > 0) {
    // Missing Greek evidence contributes ZERO, never a positive score.
    const w = GREEKS_SUITABILITY_WEIGHTS;
    suitabilityScore = clampScore(
      (w.delta * (components.delta ?? 0) +
        w.gamma * (components.gamma ?? 0) +
        w.thetaCost * (components.thetaCost ?? 0) +
        w.ivVega * (components.ivVega ?? 0) +
        w.expiryRisk * (components.expiryRisk ?? 0)) *
        (evidenceCoverage < 1 ? 1 : 1),
    );
    // Scale down when evidence is incomplete so a partial-scored contract cannot
    // outrank a fully-scored one by accident.
    suitabilityScore = clampScore(suitabilityScore * (0.55 + 0.45 * evidenceCoverage));
  }

  const suitabilityClass: SuitabilityClass =
    // Below 50% coverage the Greeks profile cannot support a suitability judgement:
    // e.g. delta alone says nothing about decay cost, IV risk or expiry exposure.
    evidenceCoverage < 0.5 || quality === "UNAVAILABLE"
      ? "INSUFFICIENT DATA"
      : (suitabilityScore ?? 0) >= 80
        ? "EXCELLENT SUITABILITY"
        : (suitabilityScore ?? 0) >= 65
          ? "GOOD SUITABILITY"
          : (suitabilityScore ?? 0) >= 50
            ? "MODERATE SUITABILITY"
            : "POOR SUITABILITY";

  const tradeOff =
    `Delta ${delta.absolute ?? "n/a"} (${delta.band.toLowerCase()} band) · gamma ${gamma.classification.toLowerCase()} · decay ${(theta.ratioToLtp !== null ? (theta.ratioToLtp * 100).toFixed(2) : "n/a")}%/day (${theta.classification.toLowerCase()}) · IV ${vega.iv ?? "n/a"} (${vega.classification.toLowerCase()}). ` +
    bandTradeOff(delta.band, theta.classification, gamma.classification);

  return {
    identity,
    quality,
    present,
    missing,
    delta,
    gamma,
    theta,
    vega,
    suitabilityScore,
    suitabilityClass,
    evidenceCoverage: round2(evidenceCoverage),
    riskWarnings,
    tradeOff,
  };
}

function bandTradeOff(band: DeltaIntel["band"], theta: ThetaIntel["classification"], gamma: GammaIntel["classification"]): string {
  const bits: string[] = [];
  if (band === "BELOW") bits.push("lower premium cost traded against lower sensitivity");
  else if (band === "ABOVE") bits.push("higher sensitivity traded against higher cost and less leverage");
  else bits.push("balanced sensitivity and cost");
  if (theta === "EXPENSIVE" || theta === "SEVERE") bits.push("decay cost demands a prompt move");
  if (gamma === "EXTREME") bits.push("high gamma cuts both ways");
  return `Trade-off: ${bits.join(", ")}.`;
}
