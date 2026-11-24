import { clamp01, clampScore, round2 } from "@/lib/engine/indicators";
import { contractIdentityKey } from "@/lib/engine/participation-identity";

/**
 * OPTION PARTICIPATION + QUOTE PRESSURE INTELLIGENCE.
 *
 * FOUR DELIBERATELY SEPARATE LAYERS — never merged into one indicator:
 *
 *   A. Greeks Intelligence        → price sensitivities        (src/lib/engine/greeks.ts)
 *   B. Option Participation       → premium / OI / volume interaction (this file)
 *   C. Quote Pressure             → displayed bid/ask liquidity (this file)
 *   D. Executed Buyer/Seller      → NOT AVAILABLE (no trade-level aggressor data)
 *
 * Every result names its own evidence source. Layer B is an aggregate price/OI
 * interaction pattern and is NOT proof of which participant initiated it. Layer C
 * is DISPLAYED liquidity, not executed trades. Layer D is never manufactured from
 * OI or best bid/ask quantities.
 */

export type ParticipationPattern =
  | "LONG_BUILDUP_PATTERN"
  | "SHORT_BUILDUP_PATTERN"
  | "SHORT_COVERING_PATTERN"
  | "LONG_UNWINDING_PATTERN"
  | "INCONCLUSIVE";

export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";

export type BuyerSellerLabel =
  | "CALL_BUYER_PARTICIPATION"
  | "PUT_BUYER_PARTICIPATION"
  | "CALL_WRITER_SHORT_BUILDUP_PATTERN"
  | "PUT_WRITER_SHORT_BUILDUP_PATTERN"
  | "SHORT_COVERING"
  | "LONG_UNWINDING"
  | "MIXED_PARTICIPATION"
  | "INSUFFICIENT_EVIDENCE";

export type QuotePressureLabel = "BID_SIDE_HEAVY" | "ASK_SIDE_HEAVY" | "BALANCED" | "ONE_SIDED_ASK_ONLY" | "ONE_SIDED_BID_ONLY" | "UNAVAILABLE";

/** Always exactly this. There is no trade-level aggressor feed in the Upstox API. */
export const EXECUTED_DOMINANCE_STATUS = "NOT AVAILABLE FROM CURRENT DATA SOURCE";
export const EXECUTED_DOMINANCE_EXPLANATION =
  "Executed buyer/seller dominance requires trade-level execution data with an aggressor-side classification. The Upstox market-data REST API exposes option-chain snapshots (LTP, OI, volume, best bid/ask price and quantity) and does not provide individual executed trades or aggressor flags. CVD, footprint delta, executed volume delta and confirmed absorption are therefore NOT computed — manufacturing them from OI or displayed bid/ask quantities would be fabrication.";

export interface ParticipationInput {
  identity: { symbol: string; expiry: string; strike: number; optionType: "CE" | "PE"; instrumentKey: string | null };
  /** Current premium. */
  ltp: number | null;
  /** Previous session close supplied by the source. */
  prevClose: number | null;
  /** Current cumulative session volume. */
  volume: number | null;
  /** Current OI. */
  oi: number | null;
  /** Previous-session OI supplied by the source. */
  prevOi: number | null;
  iv: number | null;
  ivChange: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  bidQty: number | null;
  askQty: number | null;
  /** Relative volume vs a time-of-day baseline (null when no valid baseline exists). */
  relativeVolume: number | null;
  /** Rolling premium change over the window (null when history is insufficient). */
  premiumChange5m: number | null;
  premiumChange15m: number | null;
  premiumChange1m: number | null;
  /** Rolling OI change over the window (null when history is insufficient). */
  oiChange5m: number | null;
  oiChange15m: number | null;
  /** Session-cumulative OI change (null when no baseline exists). */
  oiSessionChange: number | null;
}

export interface ParticipationResult {
  /** Premium change actually used for the classification, and where it came from. */
  premiumBasis: { value: number | null; pct: number | null; window: string; source: string };
  oiBasis: { value: number | null; pct: number | null; window: string; source: string };
  pattern: ParticipationPattern;
  /** Premium direction, OI direction, and whether volume confirms. */
  premiumDirection: "RISING" | "FALLING" | "FLAT" | "UNAVAILABLE";
  oiDirection: "RISING" | "FALLING" | "FLAT" | "UNAVAILABLE";
  volumeConfirms: boolean | null;
  volumeReason: string;
  confidence: Confidence;
  evidenceCoverage: number;
  present: string[];
  missing: string[];
  /** Aggregate pattern only — participant identity is explicitly not claimed. */
  interpretation: string;
  caveat: string;
}

const PATTERN_CAVEAT =
  "Aggregate premium/OI interaction pattern only. It does not identify which participant type initiated the change, and OI increase alone is not proof of option writing.";

/* ------------------------------------------------------------------ *
 * Layer B — Option Participation
 * ------------------------------------------------------------------ */

/**
 * Classifies the premium/OI interaction over a stated time window.
 * Requires BOTH a premium observation and an OI observation; a single observation
 * is never classified. Confidence degrades when the window is short or volume
 * cannot confirm.
 */
export function assessParticipation(input: ParticipationInput): ParticipationResult {
  const present: string[] = [];
  const missing: string[] = [];

  const premiumSources: Array<{ value: number | null; window: string; source: string }> = [];
  if (input.premiumChange5m !== null) premiumSources.push({ value: input.premiumChange5m, window: "5m", source: "persisted premium observations" });
  if (input.premiumChange15m !== null) premiumSources.push({ value: input.premiumChange15m, window: "15m", source: "persisted premium observations" });
  if (input.prevClose !== null && input.ltp !== null) {
    premiumSources.push({ value: input.ltp - input.prevClose, window: "session", source: "source previous close (market_data.close_price)" });
  }
  const premium = premiumSources[0] ?? { value: null, window: "unavailable", source: "none" };
  const premiumPct =
    premium.value !== null && input.ltp !== null && input.ltp !== 0 && input.prevClose !== null
      ? (premium.value / (input.ltp - premium.value)) * 100
      : null;
  if (premium.value !== null) present.push(`premium change (${premium.window}, ${premium.source})`);
  else missing.push("premium change");

  const oiSources: Array<{ value: number | null; window: string; source: string }> = [];
  if (input.oiChange5m !== null) oiSources.push({ value: input.oiChange5m, window: "5m", source: "persisted OI observations" });
  if (input.oiChange15m !== null) oiSources.push({ value: input.oiChange15m, window: "15m", source: "persisted OI observations" });
  if (input.oiSessionChange !== null) oiSources.push({ value: input.oiSessionChange, window: "session", source: "session baseline OI" });
  else if (input.prevOi !== null && input.oi !== null) oiSources.push({ value: input.oi - input.prevOi, window: "session", source: "source previous OI (market_data.prev_oi)" });
  const oi = oiSources[0] ?? { value: null, window: "unavailable", source: "none" };
  const oiPct = oi.value !== null && input.oi !== null && input.oi > 0 ? (oi.value / input.oi) * 100 : null;
  if (oi.value !== null) present.push(`OI change (${oi.window}, ${oi.source})`);
  else missing.push("OI change");

  // Volume confirmation requires a genuine relative-volume baseline.
  let volumeConfirms: boolean | null = null;
  let volumeReason = "Relative volume baseline unavailable — volume cannot confirm or contradict the pattern.";
  if (input.relativeVolume !== null) {
    volumeConfirms = input.relativeVolume >= 1.25;
    volumeReason =
      volumeConfirms
        ? `Relative volume ${input.relativeVolume.toFixed(2)}× the time-of-day baseline supports genuine participation.`
        : input.relativeVolume < 0.75
          ? `Relative volume ${input.relativeVolume.toFixed(2)}× the baseline is below normal: the pattern lacks volume confirmation.`
          : `Relative volume ${input.relativeVolume.toFixed(2)}× the baseline is unremarkable.`;
    present.push("relative volume (time-of-day baseline)");
  } else {
    missing.push("relative volume baseline");
  }

  const premiumDirection: ParticipationResult["premiumDirection"] =
    premium.value === null ? "UNAVAILABLE" : premium.value > 0 ? "RISING" : premium.value < 0 ? "FALLING" : "FLAT";
  const oiDirection: ParticipationResult["oiDirection"] =
    oi.value === null ? "UNAVAILABLE" : oi.value > 0 ? "RISING" : oi.value < 0 ? "FALLING" : "FLAT";

  let pattern: ParticipationPattern = "INCONCLUSIVE";
  if (premiumDirection !== "UNAVAILABLE" && oiDirection !== "UNAVAILABLE") {
    if (premiumDirection === "RISING" && oiDirection === "RISING") pattern = "LONG_BUILDUP_PATTERN";
    else if (premiumDirection === "FALLING" && oiDirection === "RISING") pattern = "SHORT_BUILDUP_PATTERN";
    else if (premiumDirection === "RISING" && oiDirection === "FALLING") pattern = "SHORT_COVERING_PATTERN";
    else if (premiumDirection === "FALLING" && oiDirection === "FALLING") pattern = "LONG_UNWINDING_PATTERN";
    else pattern = "INCONCLUSIVE";
  }

  // Confidence: two independent confirmations = HIGH, one = MEDIUM, none = LOW.
  const confirmations = [premiumDirection !== "UNAVAILABLE", oiDirection !== "UNAVAILABLE", volumeConfirms === true].filter(Boolean).length;
  // Distinguish "we have no data" (INSUFFICIENT) from "we have data but it is flat"
  // (LOW): a flat market is a real observation, not a data gap.
  const dataMissing = premiumDirection === "UNAVAILABLE" || oiDirection === "UNAVAILABLE";
  const flat = premiumDirection === "FLAT" || oiDirection === "FLAT";
  const confidence: Confidence =
    dataMissing
      ? "INSUFFICIENT"
      : flat
        ? "LOW"
        : confirmations >= 3
          ? "HIGH"
          : confirmations === 2
            ? "MEDIUM"
            : "LOW";

  const totalEvidence = 3; // premium, OI, volume
  const evidenceCoverage = round2(present.length / totalEvidence);

  const interpretation = interpretPattern(pattern, premium, oi, input.identity.optionType, volumeConfirms);

  return {
    premiumBasis: { value: premium.value === null ? null : round2(premium.value), pct: premiumPct === null ? null : round2(premiumPct), window: premium.window, source: premium.source },
    oiBasis: { value: oi.value === null ? null : round2(oi.value), pct: oiPct === null ? null : round2(oiPct), window: oi.window, source: oi.source },
    pattern,
    premiumDirection,
    oiDirection,
    volumeConfirms,
    volumeReason,
    confidence,
    evidenceCoverage,
    present,
    missing,
    interpretation,
    caveat: PATTERN_CAVEAT,
  };
}

function interpretPattern(
  pattern: ParticipationPattern,
  premium: { value: number | null; window: string; source: string },
  oi: { value: number | null; window: string; source: string },
  side: "CE" | "PE",
  volConfirms: boolean | null,
): string {
  const p = premium.value === null ? "n/a" : `${premium.value > 0 ? "+" : ""}${premium.value} (${premium.window})`;
  const o = oi.value === null ? "n/a" : `${oi.value > 0 ? "+" : ""}${oi.value} (${oi.window})`;
  const vol = volConfirms === null ? "unverified" : volConfirms ? "confirmed" : "not confirmed";
  switch (pattern) {
    case "LONG_BUILDUP_PATTERN":
      return `Premium rising (${p}) with OI rising (${o}); volume ${vol}. Long-buildup pattern — fresh positions consistent with ${side} buying, not proven buyer dominance.`;
    case "SHORT_BUILDUP_PATTERN":
      return `Premium falling (${p}) with OI rising (${o}); volume ${vol}. Short-buildup/writing pattern on the ${side} side — OI increase alone does not prove writing.`;
    case "SHORT_COVERING_PATTERN":
      return `Premium rising (${p}) with OI falling (${o}); volume ${vol}. Short-covering pattern on the ${side} side.`;
    case "LONG_UNWINDING_PATTERN":
      return `Premium falling (${p}) with OI falling (${o}); volume ${vol}. Long-unwinding pattern on the ${side} side.`;
    default:
      return `Premium/OI interaction is inconclusive (premium ${p}, OI ${o}); volume ${vol}. No pattern is asserted.`;
  }
}

/* ------------------------------------------------------------------ *
 * Layer B2 — Buyer/Seller participation classification
 * ------------------------------------------------------------------ */

export interface BuyerSellerResult {
  label: BuyerSellerLabel;
  /** Underlying directional alignment required for a BUYER label. */
  underlyingDirection: "BULLISH" | "BEARISH" | "FLAT" | "UNAVAILABLE";
  deltaAlignment: boolean | null;
  deltaReason: string;
  strikeLocation: "ATM" | "ITM" | "OTM";
  ivAligned: boolean | null;
  confidence: Confidence;
  evidenceCoverage: number;
  present: string[];
  missing: string[];
  interpretation: string;
  caveat: string;
}

const BS_CAVEAT =
  "Participation label derived from aggregate premium/OI/volume interaction plus delta alignment. It is NOT evidence of executed buyer or seller dominance.";

/**
 * Classifies the participation label for ONE contract. Combines the aggregate
 * pattern with delta alignment and underlying direction — each input is reported
 * separately so no single factor can produce a label on its own.
 */
export function assessBuyerSeller(args: {
  input: ParticipationInput;
  participation: ParticipationResult;
  delta: number | null;
  spotDirection: "BULLISH" | "BEARISH" | "FLAT" | "UNAVAILABLE";
  spot: number | null;
  expectedHoldMinutes?: number;
}): BuyerSellerResult {
  const { input, participation, delta, spotDirection, spot } = args;

  const present: string[] = [];
  const missing: string[] = [];
  if (participation.pattern !== "INCONCLUSIVE") present.push(`aggregate pattern (${participation.pattern})`);
  else missing.push("aggregate premium/OI pattern");
  if (delta !== null) present.push("delta");
  else missing.push("delta");
  if (spotDirection !== "UNAVAILABLE") present.push("underlying direction");
  else missing.push("underlying direction");
  if (input.relativeVolume !== null) present.push("relative volume");
  else missing.push("relative volume");

  const strikeLocation = classifyStrike(input.identity.strike, spot, input.identity.optionType);

  // Delta alignment: for a CE, positive delta means premium should rise with the
  // underlying; for a PE, negative delta means the same. So a BUYER-side read needs
  // the underlying direction and the delta sign to agree.
  // Alignment asks: given THIS contract's delta sign, would the current underlying
  // direction be expected to EXPAND the premium? For a CE (positive delta) only a
  // bullish move expands premium; for a PE (negative delta) only a bearish move does.
  // A counter-directional move is therefore explicitly NOT aligned.
  let deltaAlignment: boolean | null = null;
  let deltaReason = "Delta unavailable — alignment cannot be checked.";
  if (delta !== null && spotDirection !== "UNAVAILABLE") {
    if (input.identity.optionType === "CE") {
      deltaAlignment = spotDirection === "BULLISH" ? delta > 0 : spotDirection === "BEARISH" ? false : null;
      deltaReason =
        spotDirection === "BULLISH"
          ? `CE delta ${delta.toFixed(3)} > 0, so a bullish underlying move is consistent with premium expansion.`
          : spotDirection === "BEARISH"
            ? `Underlying is bearish while this CE has positive delta ${delta.toFixed(3)}: the premium would be expected to fall, so a buyer-side read is not aligned.`
            : "Underlying direction is flat.";
    } else {
      deltaAlignment = spotDirection === "BEARISH" ? delta < 0 : spotDirection === "BULLISH" ? false : null;
      deltaReason =
        spotDirection === "BEARISH"
          ? `PE delta ${delta.toFixed(3)} < 0, so a bearish underlying move is consistent with premium expansion.`
          : spotDirection === "BULLISH"
            ? `Underlying is bullish while this PE has negative delta ${delta.toFixed(3)}: the premium would be expected to fall, so a buyer-side read is not aligned.`
            : "Underlying direction is flat.";
    }
  }

  // IV alignment: expansion supports a long-option read; contraction undermines it.
  let ivAligned: boolean | null = null;
  if (input.ivChange !== null) ivAligned = input.ivChange >= 0;

  const longish =
    participation.pattern === "LONG_BUILDUP_PATTERN" ||
    participation.pattern === "SHORT_COVERING_PATTERN";
  const writerish = participation.pattern === "SHORT_BUILDUP_PATTERN";
  const unwinding = participation.pattern === "LONG_UNWINDING_PATTERN";

  let label: BuyerSellerLabel;
  if (participation.pattern === "INCONCLUSIVE" || delta === null) {
    // A buyer/seller classification needs BOTH an aggregate pattern and delta
    // alignment. Without delta the label would be an unsupported claim.
    label = participation.pattern === "INCONCLUSIVE" ? "INSUFFICIENT_EVIDENCE" : "MIXED_PARTICIPATION";
  } else if (longish && !deltaAlignment) {
    label = "MIXED_PARTICIPATION";
  } else if (participation.pattern === "LONG_BUILDUP_PATTERN") {
    label = input.identity.optionType === "CE" ? "CALL_BUYER_PARTICIPATION" : "PUT_BUYER_PARTICIPATION";
  } else if (participation.pattern === "SHORT_COVERING_PATTERN") {
    label = "SHORT_COVERING";
  } else if (writerish) {
    label = input.identity.optionType === "CE" ? "CALL_WRITER_SHORT_BUILDUP_PATTERN" : "PUT_WRITER_SHORT_BUILDUP_PATTERN";
  } else {
    label = "LONG_UNWINDING";
  }

  const confirmations = [participation.pattern !== "INCONCLUSIVE", deltaAlignment === true, input.relativeVolume !== null && input.relativeVolume >= 1.25].filter(Boolean).length;
  const confidence: Confidence =
    label === "INSUFFICIENT_EVIDENCE"
      ? "INSUFFICIENT"
      : label === "MIXED_PARTICIPATION"
        ? "LOW"
        : confirmations >= 3
          ? "HIGH"
          : confirmations === 2
            ? "MEDIUM"
            : "LOW";

  const evidenceCoverage = round2(present.length / 4);

  const interpretation =
    `${label.replace(/_/g, " ")} for ${input.identity.optionType} ${input.identity.strike}. Pattern: ${participation.pattern.replace(/_/g, " ").toLowerCase()}. ` +
    `Underlying: ${spotDirection.toLowerCase()}. ${deltaReason} Strike location: ${strikeLocation}. ` +
    `Delta alignment: ${deltaAlignment === null ? "unknown" : deltaAlignment ? "yes" : "no"}. IV direction: ${input.ivChange === null ? "unknown" : input.ivChange >= 0 ? "expanding" : "contracting"}.`;

  return {
    label,
    underlyingDirection: spotDirection,
    deltaAlignment,
    deltaReason,
    strikeLocation,
    ivAligned,
    confidence,
    evidenceCoverage,
    present,
    missing,
    interpretation,
    caveat: BS_CAVEAT,
  };
}

function classifyStrike(strike: number, spot: number | null, side: "CE" | "PE"): "ATM" | "ITM" | "OTM" {
  if (spot === null) return "ATM";
  const dist = strike - spot;
  if (Math.abs(dist) <= Math.max(spot * 0.0015, 5)) return "ATM";
  if (side === "CE") return dist < 0 ? "ITM" : "OTM";
  return dist > 0 ? "ITM" : "OTM";
}

/* ------------------------------------------------------------------ *
 * Layer C — Displayed Quote Pressure
 * ------------------------------------------------------------------ */

export interface QuotePressureResult {
  label: QuotePressureLabel;
  bidPrice: number | null;
  askPrice: number | null;
  bidQty: number | null;
  askQty: number | null;
  spread: number | null;
  spreadPct: number | null;
  mid: number | null;
  /** Best-level displayed quantity imbalance: (bid - ask) / (bid + ask), -1..1. */
  imbalance: number | null;
  bidSideRatio: number | null;
  askSideRatio: number | null;
  /** Whether quantities were actually supplied — prices alone cannot produce an imbalance. */
  quantitiesAvailable: boolean;
  /** How the imbalance moved vs the previous observation (displayed liquidity only). */
  changeFromHistory: number | null;
  /** 0..1 stability of the displayed quotes across stored observations. */
  quoteStability: number | null;
  observationCount: number;
  interpretation: string;
  caveat: string;
}

const QP_CAVEAT =
  "Displayed liquidity observation from best bid/ask price and quantity (D0 level). Displayed orders are not executed trades, so this is NOT executed buying or selling pressure.";

export interface QuoteHistoryPoint {
  receivedAt: number;
  bidPrice: number | null;
  askPrice: number | null;
  bidQty: number | null;
  askQty: number | null;
}

/**
 * Displayed quote pressure from actual best bid/ask values.
 * Requires quantities: prices alone can produce spread/mid but never an imbalance.
 */
export function assessQuotePressure(args: {
  identity: { symbol: string; expiry: string; strike: number; optionType: "CE" | "PE"; instrumentKey: string | null };
  bidPrice: number | null;
  askPrice: number | null;
  bidQty: number | null;
  askQty: number | null;
  history: QuoteHistoryPoint[];
  now: number;
}): QuotePressureResult {
  const { bidPrice, askPrice, bidQty, askQty, history, now } = args;
  const spread = bidPrice !== null && askPrice !== null ? askPrice - bidPrice : null;
  const mid = bidPrice !== null && askPrice !== null ? (bidPrice + askPrice) / 2 : null;
  const spreadPct = spread !== null && mid !== null && mid > 0 ? (spread / mid) * 100 : null;

  const quantitiesAvailable = bidQty !== null || askQty !== null;
  const total = (bidQty ?? 0) + (askQty ?? 0);
  const imbalance = quantitiesAvailable && total > 0 ? ((bidQty ?? 0) - (askQty ?? 0)) / total : null;
  const bidSideRatio = total > 0 ? (bidQty ?? 0) / total : null;
  const askSideRatio = total > 0 ? (askQty ?? 0) / total : null;

  const recent = history
    .filter((h) => now - h.receivedAt < 6 * 3600000)
    .sort((a, b) => a.receivedAt - b.receivedAt);

  // Imbalance change vs ~5 minutes ago.
  let changeFromHistory: number | null = null;
  const ref = recent.length > 1 ? recent[Math.max(0, recent.findIndex((h) => h.receivedAt >= now - 5 * 60000) - 1)] ?? recent[0] : null;
  if (ref && ref.bidQty !== null && ref.askQty !== null && ref.bidQty + ref.askQty > 0) {
    const refImb = (ref.bidQty - ref.askQty) / (ref.bidQty + ref.askQty);
    if (imbalance !== null) changeFromHistory = round2(imbalance - refImb);
  }

  // Quote stability: how little bid/ask moved across stored observations (0..1).
  let quoteStability: number | null = null;
  if (recent.length >= 3) {
    const bids = recent.map((h) => h.bidPrice).filter((v): v is number => v !== null);
    const asks = recent.map((h) => h.askPrice).filter((v): v is number => v !== null);
    if (bids.length >= 3 && asks.length >= 3) {
      const range = (arr: number[]) => Math.max(...arr) - Math.min(...arr);
      const mids = recent.map((h) => (h.bidPrice !== null && h.askPrice !== null ? (h.bidPrice + h.askPrice) / 2 : null)).filter((v): v is number => v !== null);
      const denom = mids.length > 0 ? Math.max(...mids) : 1;
      if (denom > 0) {
        const instability = (range(bids) + range(asks)) / (2 * denom);
        quoteStability = round2(clamp01(1 - instability * 20));
      }
    }
  }

  let label: QuotePressureLabel;
  if (!quantitiesAvailable) label = bidPrice !== null && askPrice !== null ? "UNAVAILABLE" : "UNAVAILABLE";
  else if ((bidQty ?? 0) === 0 && (askQty ?? 0) > 0) label = "ONE_SIDED_ASK_ONLY";
  else if ((askQty ?? 0) === 0 && (bidQty ?? 0) > 0) label = "ONE_SIDED_BID_ONLY";
  else if (imbalance === null) label = "UNAVAILABLE";
  else if (imbalance > 0.2) label = "BID_SIDE_HEAVY";
  else if (imbalance < -0.2) label = "ASK_SIDE_HEAVY";
  else label = "BALANCED";

  const interpretation =
    quantitiesAvailable && imbalance !== null
      ? `Displayed best-level quantities: bid ${bidQty ?? 0} vs ask ${askQty ?? 0} → imbalance ${(imbalance * 100).toFixed(0)}% (${bidSideRatio !== null ? `bid side ${(bidSideRatio * 100).toFixed(0)}%` : "n/a"} / ${askSideRatio !== null ? `ask side ${(askSideRatio * 100).toFixed(0)}%` : "n/a"}). ${
          label === "BID_SIDE_HEAVY"
            ? "More displayed liquidity is resting on the bid side."
            : label === "ASK_SIDE_HEAVY"
              ? "More displayed liquidity is resting on the ask side."
              : "Displayed liquidity is broadly balanced."
        }${changeFromHistory !== null ? ` Imbalance moved ${changeFromHistory > 0 ? "+" : ""}${changeFromHistory} vs ~5m ago.` : ""}${quoteStability !== null ? ` Quote stability ${Math.round(quoteStability * 100)}%.` : ""}`
      : bidPrice !== null && askPrice !== null
        ? `Spread ${(spread ?? 0).toFixed(2)} (${spreadPct?.toFixed(2) ?? "n/a"}% of mid). Bid/ask QUANTITIES were not supplied for this contract, so displayed imbalance cannot be computed — only prices are available.`
        : "Best bid/ask unavailable for this contract.";

  return {
    label,
    bidPrice,
    askPrice,
    bidQty,
    askQty,
    spread: spread === null ? null : round2(spread),
    spreadPct: spreadPct === null ? null : round2(spreadPct),
    mid: mid === null ? null : round2(mid),
    imbalance: imbalance === null ? null : round2(imbalance),
    bidSideRatio: bidSideRatio === null ? null : round2(bidSideRatio),
    askSideRatio: askSideRatio === null ? null : round2(askSideRatio),
    quantitiesAvailable,
    changeFromHistory,
    quoteStability,
    observationCount: recent.length,
    interpretation,
    caveat: QP_CAVEAT,
  };
}

/** Canonical contract identity used by every layer, so identities can never drift. */
export function identityOf(args: { symbol: string; expiry: string; strike: number; optionType: "CE" | "PE"; instrumentKey: string | null }): string {
  return contractIdentityKey(args);
}

export { clampScore };
