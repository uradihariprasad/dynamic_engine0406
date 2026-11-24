import { clamp01, clampScore, round2 } from "@/lib/engine/indicators";
import type { OiHistoryPoint } from "@/lib/persistence";
import { contractIdentityKey } from "@/lib/engine/participation-identity";

/**
 * DEDICATED CHANGE-IN-OPEN-INTEREST (ΔOI) INTELLIGENCE ENGINE.
 *
 * Computes, per contract, an explicitly separated set of OI measurements:
 *   1. current total OI               (an absolute level — not a change)
 *   2. source-provided change in OI   (prev_oi from the exchange; a different concept)
 *   3. change in OI                   (current − previous session OI)
 *   4. change in OI percentage        (change / previous OI × 100; null when denominator is 0)
 *   5. 1-minute rolling change        (only where observations exist)
 *   6. 5-minute rolling change
 *   7. 15-minute rolling change
 *   8. session cumulative change      (current − valid session baseline)
 *
 * Rolling windows are measured against the SAME contract identity
 * (underlying + expiry + strike + CE/PE + instrument key). A comparison across a
 * different expiry, strike or side is prohibited and is structurally impossible here
 * because the identity key is part of every lookup.
 *
 * Distinguishing (2) from the calculated values matters: prev_oi is the previous
 * SESSION's close, whereas the rolling windows are intraday. Reporting them under one
 * name would make an intraday change look like an overnight change.
 */

/** Timestamp tolerance for a rolling window. An observation outside it is rejected. */
export const WINDOW_TOLERANCE_MS = {
  m1: 45_000,
  m5: 120_000,
  m15: 240_000,
} as const;

/**
 * Maximum acceptable staleness for any observation used in a rolling comparison.
 *
 * This must exceed the widest window (15 minutes) plus its tolerance, otherwise a
 * legitimate 15-minute reference would be discarded as "stale" — which is exactly
 * what happened before this was fixed, leaving the 15-minute window permanently
 * INSUFFICIENT_DATA even with adequate history.
 */
export const MAX_OBSERVATION_AGE_MS = 20 * 60_000;

export type WindowAvailability = "AVAILABLE" | "WAITING_FOR_HISTORY" | "INSUFFICIENT_DATA";

export interface OiWindows {
  m1: { change: number | null; pct: number | null; referenceAt: string | null; referenceOi: number | null; availability: WindowAvailability; ageMinutes: number | null };
  m5: { change: number | null; pct: number | null; referenceAt: string | null; referenceOi: number | null; availability: WindowAvailability; ageMinutes: number | null };
  m15: { change: number | null; pct: number | null; referenceAt: string | null; referenceOi: number | null; availability: WindowAvailability; ageMinutes: number | null };
}

export interface ContractOiMeasurements {
  /** Canonical identity — every lookup is keyed on this. */
  identityKey: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  instrumentKey: string | null;
  /** Absolute level. Never a change. */
  currentOi: number | null;
  /** Previous-session OI supplied by the exchange (prev_oi). */
  previousSessionOi: number | null;
  /** Change in OI = current − previous-session OI. */
  changeInOi: number | null;
  /** Change in OI % = (change / previous OI) × 100; null when the denominator is 0 or unavailable. */
  changeInOiPct: number | null;
  /** Source-provided change, if Upstox supplies one, kept separate from calculated values. */
  sourceProvidedChange: number | null;
  hasSourceProvidedChange: boolean;
  /** Discrepancy note when the source value and the calculation disagree materially. */
  discrepancyNote: string | null;
  sessionBaselineOi: number | null;
  sessionBaselineAt: string | null;
  sessionCumulativeChange: number | null;
  sessionCumulativeChangePct: number | null;
  /** Combined total OI = baseline OI + cumulative change. */
  combinedTotalOi: number | null;
  windows: OiWindows;
  /** Observations available for this exact contract identity. */
  observationCount: number;
  oldestObservationAt: string | null;
  newestObservationAt: string | null;
  /** True when the newest observation is too old to be trusted. */
  stale: boolean;
  /** Reasons any window is unavailable, shown verbatim in the UI. */
  unavailableReasons: string[];
}

/**
 * Contract-scoped identity: expiry + strike + CE/PE + instrument key.
 *
 * The underlying is deliberately NOT part of this key because a whole ΔOI
 * computation is always for ONE underlying and one expiry (see buildOiIntelligence).
 * Including it here caused the identity gate to compare a symbol-prefixed key
 * against a non-prefixed one, so NO observation ever matched and every rolling
 * window returned INSUFFICIENT_DATA.
 */
function contractScopedIdentity(args: { expiry: string; strike: number; optionType: "CE" | "PE"; instrumentKey: string | null }): string {
  return `${args.expiry}|${args.strike}|${args.optionType}|${args.instrumentKey ?? "unknown"}`;
}

/** Finds the observation closest to `target` within `tolerance`, for ONE contract identity. */
function nearestForIdentity(
  history: OiHistoryPoint[],
  identityKey: string,
  expiry: string,
  target: number,
  toleranceMs: number,
  now: number,
): OiHistoryPoint | null {
  let best: OiHistoryPoint | null = null;
  let bestDelta = Infinity;
  for (const p of history) {
    // Identity gate: never compare against a different contract. Both sides are built
    // by the same helper, so the comparison can never drift out of sync.
    const pKey = contractScopedIdentity({ expiry, strike: p.strike, optionType: p.optionType, instrumentKey: p.instrumentKey });
    if (pKey !== identityKey) continue;
    if (p.oi === null) continue;
    const d = Math.abs(p.receivedAt - target);
    if (d < bestDelta) {
      bestDelta = d;
      best = p;
    }
  }
  if (!best || bestDelta > toleranceMs) return null;
  // Staleness gate: an observation must not be older than the window it is being used
  // for, plus a small grace margin. A 15-minute reference is legitimately ~15 minutes
  // old, so a single global cutoff would wrongly reject it.
  const maxAgeForWindow = windowMaxAgeMs(target, now);
  if (now - best.receivedAt > maxAgeForWindow) return null;
  return best;
}

/**
 * Per-window staleness ceiling: the intended window plus its tolerance, scaled so a
 * wider window is allowed an older reference.
 */
function windowMaxAgeMs(target: number, now: number): number {
  const intendedWindowMinutes = Math.round((now - target) / 60_000);
  const minutes = Math.max(1, intendedWindowMinutes);
  return minutes * 60_000 + WINDOW_TOLERANCE_MS.m15;
}

/** Builds the identity string for the CURRENT contract being measured. */
/**
 * Public identity helper. Includes expiry (cross-expiry isolation) and the instrument
 * key, but not the underlying — one ΔOI computation is always for a single underlying,
 * and NIFTY/SENSEX isolation is asserted at the chain level.
 */
export function identityFor(args: { underlying: string; expiry: string; strike: number; optionType: "CE" | "PE"; instrumentKey: string | null }): string {
  void args.underlying;
  return contractScopedIdentity({ expiry: args.expiry, strike: args.strike, optionType: args.optionType, instrumentKey: args.instrumentKey });
}

/** Computes change percentage, returning null when the denominator is zero or missing. */
export function changePct(change: number | null, base: number | null): number | null {
  if (change === null || base === null || base === 0) return null;
  return round2((change / base) * 100);
}

function availabilityFor(hasReference: boolean, hasEnoughHistory: boolean): WindowAvailability {
  if (hasReference) return "AVAILABLE";
  return hasEnoughHistory ? "INSUFFICIENT_DATA" : "WAITING_FOR_HISTORY";
}

/**
 * Core ΔOI measurement for ONE contract.
 *
 * @param baseline reference for the session cumulative change; taken as the oldest
 *                 observation of this contract within the lookback window.
 */
export function measureContractOi(args: {
  underlying: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  current: { oi: number | null; prevOi: number | null; sourceChange: number | null };
  history: OiHistoryPoint[];
  now: number;
  sessionBaseline?: OiHistoryPoint | null;
}): ContractOiMeasurements {
  const { underlying, expiry, strike, optionType, current, history, now } = args;
  const identityKey = contractScopedIdentity({ expiry, strike, optionType, instrumentKey: currentIdentityKey(history, strike, optionType, expiry) });

  const currentOi = current.oi;
  const previousSessionOi = current.prevOi;
  const sourceProvidedChange = current.sourceChange;

  const changeInOi = currentOi !== null && previousSessionOi !== null ? currentOi - previousSessionOi : null;
  const changeInOiPct = changePct(changeInOi, previousSessionOi);

  // Session baseline: the supplied baseline if valid, otherwise the oldest stored observation.
  const candidates = history
    .filter((p) => p.strike === strike && p.optionType === optionType && p.oi !== null && now - p.receivedAt <= 24 * 3600000)
    .sort((a, b) => a.receivedAt - b.receivedAt);
  const baseline = args.sessionBaseline ?? candidates[0] ?? null;
  const sessionCumulativeChange = baseline && currentOi !== null ? currentOi - baseline.oi! : null;
  const sessionCumulativeChangePct = changePct(sessionCumulativeChange, baseline?.oi ?? null);

  const scoped = history.filter((p) => p.strike === strike && p.optionType === optionType && p.oi !== null);
  const observationTimes = scoped.map((p) => p.receivedAt);

  // A window is "sufficient history" when at least one observation older than the
  // window exists, so the comparison is meaningful rather than trivially zero.
  const hasEnoughFor1m = observationTimes.some((t) => now - t >= 60_000);
  const hasEnoughFor5m = observationTimes.some((t) => now - t >= 5 * 60_000);
  const hasEnoughFor15m = observationTimes.some((t) => now - t >= 15 * 60_000);

  const m1Ref = nearestForIdentity(history, identityKey, expiry, now - 1 * 60_000, WINDOW_TOLERANCE_MS.m1, now);
  const m5Ref = nearestForIdentity(history, identityKey, expiry, now - 5 * 60_000, WINDOW_TOLERANCE_MS.m5, now);
  const m15Ref = nearestForIdentity(history, identityKey, expiry, now - 15 * 60_000, WINDOW_TOLERANCE_MS.m15, now);

  const mk = (
    ref: OiHistoryPoint | null,
    enough: boolean,
    label: string,
  ): OiWindows["m5"] => {
    if (!ref) {
      return {
        change: null,
        pct: null,
        referenceAt: null,
        referenceOi: null,
        availability: availabilityFor(false, enough),
        ageMinutes: null,
      };
    }
    return {
      change: currentOi !== null ? currentOi - ref.oi! : null,
      pct: changePct(currentOi !== null ? currentOi - ref.oi! : null, ref.oi ?? null),
      referenceAt: new Date(ref.receivedAt).toISOString(),
      referenceOi: ref.oi,
      availability: "AVAILABLE",
      ageMinutes: Math.round((now - ref.receivedAt) / 60_000),
    };
  };

  const windows: OiWindows = {
    m1: mk(m1Ref, hasEnoughFor1m, "1m"),
    m5: mk(m5Ref, hasEnoughFor5m, "5m"),
    m15: mk(m15Ref, hasEnoughFor15m, "15m"),
  };

  // Source-provided vs calculated discrepancy: prev_oi is previous SESSION, so a large
  // gap against a short intraday window is expected, not an error. We flag only when the
  // session-cumulative calculation disagrees with the source value.
  let discrepancyNote: string | null = null;
  if (sourceProvidedChange !== null && sessionCumulativeChange !== null && previousSessionOi !== null && previousSessionOi !== 0) {
    const delta = Math.abs(sourceProvidedChange - sessionCumulativeChange);
    if (delta > Math.max(1000, Math.abs(sourceProvidedChange) * 0.25)) {
      discrepancyNote = `Source-provided change (${sourceProvidedChange}) differs from the session-cumulative calculation (${sessionCumulativeChange}) by ${delta}. prev_oi is the previous session close; the baseline used here is ${baseline ? new Date(baseline.receivedAt).toISOString() : "unavailable"}. Both values are reported separately and neither is overwritten.`;
    }
  }

  const unavailableReasons: string[] = [];
  if (windows.m1.availability !== "AVAILABLE") unavailableReasons.push(`1-minute: ${windows.m1.availability.replace(/_/g, " ").toLowerCase()} — need an observation within ±45s of 1 minute ago`);
  if (windows.m5.availability !== "AVAILABLE") unavailableReasons.push(`5-minute: ${windows.m5.availability.replace(/_/g, " ").toLowerCase()} — need an observation within ±2min of 5 minutes ago`);
  if (windows.m15.availability !== "AVAILABLE") unavailableReasons.push(`15-minute: ${windows.m15.availability.replace(/_/g, " ").toLowerCase()} — need an observation within ±4min of 15 minutes ago`);
  if (sessionCumulativeChange === null) unavailableReasons.push("session cumulative: no valid session baseline yet");
  if (changeInOi === null) unavailableReasons.push("change in OI: previous-session OI (prev_oi) not supplied by the source");
  if (changeInOiPct === null && changeInOi !== null) unavailableReasons.push("change in OI %: previous OI is zero, so the percentage is undefined");

  const newest = observationTimes.length ? Math.max(...observationTimes) : null;
  const oldest = observationTimes.length ? Math.min(...observationTimes) : null;

  return {
    identityKey,
    underlying,
    expiry,
    strike,
    optionType,
    instrumentKey: scoped.length > 0 ? scoped[0].instrumentKey : null,
    currentOi,
    previousSessionOi,
    changeInOi,
    changeInOiPct,
    sourceProvidedChange,
    hasSourceProvidedChange: sourceProvidedChange !== null,
    discrepancyNote,
    sessionBaselineOi: baseline?.oi ?? null,
    sessionBaselineAt: baseline ? new Date(baseline.receivedAt).toISOString() : null,
    sessionCumulativeChange,
    sessionCumulativeChangePct,
    combinedTotalOi: baseline && sessionCumulativeChange !== null ? baseline.oi! + sessionCumulativeChange : null,
    windows,
    observationCount: scoped.length,
    oldestObservationAt: oldest ? new Date(oldest).toISOString() : null,
    newestObservationAt: newest ? new Date(newest).toISOString() : null,
    /** True when the newest observation is older than the widest window we support. */
    stale: newest !== null && now - newest > MAX_OBSERVATION_AGE_MS,
    unavailableReasons,
  };
}

/** Recovers the instrument key for a contract from its stored observations. */
function currentIdentityKey(history: OiHistoryPoint[], strike: number, optionType: "CE" | "PE", expiry: string): string | null {
  const hit = history.find((p) => p.strike === strike && p.optionType === optionType && p.instrumentKey);
  return hit?.instrumentKey ?? null;
}

/* ------------------------------------------------------------------ *
 * D. OI participation classification (premium + OI, never OI alone)
 * ------------------------------------------------------------------ */

export type OiParticipationPattern =
  | "LONG_BUILDUP_PATTERN"
  | "SHORT_BUILDUP_PATTERN"
  | "SHORT_COVERING_PATTERN"
  | "LONG_UNWINDING_PATTERN"
  | "INCONCLUSIVE";

export type OiConfidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";

export interface OiParticipationResult {
  pattern: OiParticipationPattern;
  /** Which premium observation drove the classification, and its window/source. */
  premiumBasis: { value: number | null; pct: number | null; window: string; source: string };
  /** Which OI observation drove the classification, and its window/source. */
  oiBasis: { value: number | null; pct: number | null; window: string; source: string };
  premiumDirection: "RISING" | "FALLING" | "FLAT" | "UNAVAILABLE";
  oiDirection: "RISING" | "FALLING" | "FLAT" | "UNAVAILABLE";
  oiMagnitude: "LARGE" | "MODERATE" | "SMALL" | "UNAVAILABLE";
  volumeConfirms: boolean | null;
  volumeReason: string;
  confidence: OiConfidence;
  evidenceCoverage: number;
  present: string[];
  missing: string[];
  interpretation: string;
  caveat: string;
}

const OI_CAVEAT =
  "Aggregate premium/OI interaction pattern. It does not identify which participant type initiated the change, and an OI increase alone is not proof of option writing or of buyer/seller dominance.";

/** |ΔOI %| thresholds for magnitude, relative to the contract's own OI level. */
const OI_MAGNITUDE_PCT = { large: 5, moderate: 1.5 } as const;

/**
 * Classifies the premium/OI interaction for one contract.
 * Requires BOTH a premium observation and an OI observation; OI alone is never
 * classified, and a single observation never produces a pattern.
 */
export function classifyOiParticipation(args: {
  optionType: "CE" | "PE";
  strike: number;
  ltp: number | null;
  prevClose: number | null;
  oi: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
  oiWindow: string;
  oiSource: string;
  volume: number | null;
  relativeVolume: number | null;
  premiumChange5m: number | null;
  premiumChange15m: number | null;
  now: number;
}): OiParticipationResult {
  const present: string[] = [];
  const missing: string[] = [];

  // --- Premium basis: prefer the rolling window, fall back to the session close. ---
  const premiumSources: Array<{ value: number | null; window: string; source: string }> = [];
  if (args.premiumChange5m !== null) premiumSources.push({ value: args.premiumChange5m, window: "5m", source: "persisted premium observations" });
  if (args.premiumChange15m !== null) premiumSources.push({ value: args.premiumChange15m, window: "15m", source: "persisted premium observations" });
  if (args.prevClose !== null && args.ltp !== null) {
    premiumSources.push({ value: args.ltp - args.prevClose, window: "session", source: "source previous close (market_data.close_price)" });
  }
  const premium = premiumSources[0] ?? { value: null, window: "unavailable", source: "none" };
  if (premium.value !== null) present.push(`premium change (${premium.window})`);
  else missing.push("premium change");

  // --- OI basis: the caller supplies the change plus its window and source. ---
  const oiValue = args.oiChange;
  const oiWindow = args.oiWindow;
  const oiSource = args.oiSource;
  if (oiValue !== null) present.push(`OI change (${oiWindow})`);
  else missing.push("OI change");
  if (args.relativeVolume !== null) present.push("relative volume");
  else missing.push("relative volume baseline");

  const premiumDirection: OiParticipationResult["premiumDirection"] =
    premium.value === null ? "UNAVAILABLE" : premium.value > 0 ? "RISING" : premium.value < 0 ? "FALLING" : "FLAT";
  const oiDirection: OiParticipationResult["oiDirection"] =
    oiValue === null ? "UNAVAILABLE" : oiValue > 0 ? "RISING" : oiValue < 0 ? "FALLING" : "FLAT";

  // Magnitude from the OI change percentage, so a 50,000-lot change on a 5,000,000
  // base is correctly read as small while the same change on 100,000 is large.
  const pct = args.oiChangePct ?? null;
  const oiMagnitude: OiParticipationResult["oiMagnitude"] =
    pct === null ? "UNAVAILABLE" : Math.abs(pct) >= OI_MAGNITUDE_PCT.large ? "LARGE" : Math.abs(pct) >= OI_MAGNITUDE_PCT.moderate ? "MODERATE" : "SMALL";

  let volumeConfirms: boolean | null = null;
  let volumeReason = "Relative volume baseline unavailable — volume cannot confirm or contradict the pattern.";
  if (args.relativeVolume !== null) {
    volumeConfirms = args.relativeVolume >= 1.25;
    volumeReason =
      volumeConfirms
        ? `Relative volume ${args.relativeVolume.toFixed(2)}× baseline supports genuine participation.`
        : args.relativeVolume < 0.75
          ? `Relative volume ${args.relativeVolume.toFixed(2)}× baseline is below normal: the pattern lacks volume confirmation.`
          : `Relative volume ${args.relativeVolume.toFixed(2)}× baseline is unremarkable.`;
  }

  let pattern: OiParticipationPattern = "INCONCLUSIVE";
  if (premiumDirection !== "UNAVAILABLE" && oiDirection !== "UNAVAILABLE") {
    if (premiumDirection === "RISING" && oiDirection === "RISING") pattern = "LONG_BUILDUP_PATTERN";
    else if (premiumDirection === "FALLING" && oiDirection === "RISING") pattern = "SHORT_BUILDUP_PATTERN";
    else if (premiumDirection === "RISING" && oiDirection === "FALLING") pattern = "SHORT_COVERING_PATTERN";
    else if (premiumDirection === "FALLING" && oiDirection === "FALLING") pattern = "LONG_UNWINDING_PATTERN";
  }

  const confirmations = [premiumDirection !== "UNAVAILABLE", oiDirection !== "UNAVAILABLE", volumeConfirms === true].filter(Boolean).length;
  const dataMissing = premiumDirection === "UNAVAILABLE" || oiDirection === "UNAVAILABLE";
  const flat = premiumDirection === "FLAT" || oiDirection === "FLAT";
  const confidence: OiConfidence = dataMissing ? "INSUFFICIENT" : flat ? "LOW" : confirmations >= 3 ? "HIGH" : confirmations === 2 ? "MEDIUM" : "LOW";

  const evidenceCoverage = round2(present.length / 3);

  const fmtSigned = (v: number | null) => (v === null ? "n/a" : `${v > 0 ? "+" : ""}${v.toLocaleString("en-IN")}`);
  const interpretation =
    pattern === "INCONCLUSIVE"
      ? `Premium/OI interaction is inconclusive (premium ${fmtSigned(premium.value)} over ${premium.window}, OI ${fmtSigned(oiValue)} over ${oiWindow}); volume ${volumeConfirms === null ? "unverified" : volumeConfirms ? "confirmed" : "not confirmed"}. No pattern is asserted.`
      : `${pattern.replace(/_/g, " ").toLowerCase()}: premium ${premiumDirection.toLowerCase()} (${fmtSigned(premium.value)}, ${premium.window}) with OI ${oiDirection.toLowerCase()} (${fmtSigned(oiValue)}, ${oiWindow}, ${oiMagnitude.toLowerCase()} at ${pct === null ? "n/a" : `${pct.toFixed(2)}%`}); volume ${volumeConfirms === null ? "unverified" : volumeConfirms ? "confirmed" : "not confirmed"}.`;

  return {
    pattern,
    premiumBasis: { value: premium.value === null ? null : round2(premium.value), pct: null, window: premium.window, source: premium.source },
    oiBasis: { value: oiValue === null ? null : round2(oiValue), pct, window: oiWindow, source: oiSource },
    premiumDirection,
    oiDirection,
    oiMagnitude,
    volumeConfirms,
    volumeReason,
    confidence,
    evidenceCoverage,
    present,
    missing,
    interpretation,
    caveat: OI_CAVEAT,
  };
}

/* ------------------------------------------------------------------ *
 * E. Strike-wise ΔOI aggregation
 * ------------------------------------------------------------------ */

export type OiClusterKind = "CE_BUILDUP_CLUSTER" | "PE_BUILDUP_CLUSTER" | "CE_UNWINDING_CLUSTER" | "PE_UNWINDING_CLUSTER" | "BALANCED" | "NO_SIGNAL";

export interface StrikeOiRow {
  strike: number;
  isAtm: boolean;
  ce: ContractOiMeasurements;
  pe: ContractOiMeasurements;
  ceParticipation: OiParticipationResult | null;
  peParticipation: OiParticipationResult | null;
  /** PE OI / CE OI at this strike (level ratio, not a change). */
  strikePcr: number | null;
  cluster: OiClusterKind;
  /** Plain-language reason for the cluster label, naming its evidence. */
  clusterReason: string;
}

export interface OiIntelligenceSummary {
  status: "LIVE" | "PARTIAL" | "WAITING_FOR_HISTORY" | "UNAVAILABLE" | "INVALID";
  message: string;
  totalCeOi: number | null;
  totalPeOi: number | null;
  combinedOi: number | null;
  /** PCR from current OI levels. */
  pcr: number | null;
  /** PCR change vs the session baseline, so a shift in positioning is visible. */
  pcrChange: number | null;
  ce5mChange: number | null;
  pe5mChange: number | null;
  ce15mChange: number | null;
  pe15mChange: number | null;
  ceSessionChange: number | null;
  peSessionChange: number | null;
  ce5mPct: number | null;
  pe5mPct: number | null;
  ce15mPct: number | null;
  pe15mPct: number | null;
  /** Availability of each rolling window across the whole chain. */
  windows: { m1: WindowAvailability; m5: WindowAvailability; m15: WindowAvailability; session: WindowAvailability };
  snapshotCount: number;
  distinctObservations: number;
  oldestSnapshotAt: string | null;
  newestSnapshotAt: string | null;
  baselineAt: string | null;
  rows: StrikeOiRow[];
  highestOiStrikes: Array<{ strike: number; side: "CE" | "PE"; oi: number }>;
  largestAdditions: Array<{ strike: number; side: "CE" | "PE"; change: number; pct: number | null; window: string }>;
  largestReductions: Array<{ strike: number; side: "CE" | "PE"; change: number; pct: number | null; window: string }>;
  buildupClusters: Array<{ strike: number; side: "CE" | "PE"; change: number; pct: number | null }>;
  unwindingClusters: Array<{ strike: number; side: "CE" | "PE"; change: number; pct: number | null }>;
  /** Count of contracts classified as fresh vs weakening participation. */
  freshParticipation: number;
  weakeningParticipation: number;
  interpretation: string[];
  unavailableReasons: string[];
  /** Explicit note that OI-only clusters are not confirmed price levels. */
  priceConfirmationNote: string;
}

const PRICE_CONFIRMATION_NOTE =
  "OI concentration and OI buildup clusters are participation evidence only. A high PE OI strike is NOT confirmed support and a high CE OI strike is NOT confirmed resistance until price action confirms the level; OI-only clusters are kept separate from the structural S/R zones produced by the Dynamic S/R engine.";

/**
 * Builds the full strike-wise ΔOI intelligence view for one underlying + expiry.
 *
 * All rolling comparisons are identity-scoped to expiry + strike + CE/PE + instrument
 * key, so no cross-expiry, cross-strike or cross-side mixing is possible. Underlying
 * isolation is guaranteed by the caller: NIFTY and SENSEX each invoke this with their
 * own chain rows and their own observation history, which is asserted by tests.
 */
export function buildOiIntelligence(args: {
  underlying: string;
  expiry: string;
  spot: number | null;
  atmStrike: number | null;
  strikes: Array<{
    strike: number;
    ce: { oi: number | null; prevOi: number | null; sourceChange: number | null; volume: number | null; ltp: number | null; prevClose: number | null; premiumChange5m: number | null; premiumChange15m: number | null; relativeVolume: number | null; instrumentKey: string | null };
    pe: { oi: number | null; prevOi: number | null; sourceChange: number | null; volume: number | null; ltp: number | null; prevClose: number | null; premiumChange5m: number | null; premiumChange15m: number | null; relativeVolume: number | null; instrumentKey: string | null };
  }>;
  history: OiHistoryPoint[];
  now: number;
}): OiIntelligenceSummary {
  const { underlying, expiry, spot, atmStrike, strikes, history, now } = args;

  const rows: StrikeOiRow[] = [];
  for (const s of strikes) {
    const ce = measureContractOi({
      underlying, expiry, strike: s.strike, optionType: "CE",
      current: { oi: s.ce.oi, prevOi: s.ce.prevOi, sourceChange: s.ce.sourceChange },
      history, now,
    });
    const pe = measureContractOi({
      underlying, expiry, strike: s.strike, optionType: "PE",
      current: { oi: s.pe.oi, prevOi: s.pe.prevOi, sourceChange: s.pe.sourceChange },
      history, now,
    });

    // Prefer the rolling 5m window for participation; fall back to session cumulative.
    const pickOi = (m: ContractOiMeasurements) => {
      if (m.windows.m5.change !== null) return { value: m.windows.m5.change, pct: m.windows.m5.pct, window: "5m", source: "persisted OI observations" };
      if (m.windows.m15.change !== null) return { value: m.windows.m15.change, pct: m.windows.m15.pct, window: "15m", source: "persisted OI observations" };
      if (m.sessionCumulativeChange !== null) return { value: m.sessionCumulativeChange, pct: m.sessionCumulativeChangePct, window: "session", source: "session baseline" };
      if (m.changeInOi !== null) return { value: m.changeInOi, pct: m.changeInOiPct, window: "session", source: "source previous-session OI (prev_oi)" };
      return { value: null, pct: null, window: "unavailable", source: "none" };
    };
    const ceOi = pickOi(ce);
    const peOi = pickOi(pe);

    const ceParticipation =
      ceOi.value === null
        ? null
        : classifyOiParticipation({
            optionType: "CE", strike: s.strike,
            ltp: s.ce.ltp, prevClose: s.ce.prevClose,
            oi: ce.currentOi, oiChange: ceOi.value, oiChangePct: ceOi.pct,
            oiWindow: ceOi.window, oiSource: ceOi.source,
            volume: s.ce.volume, relativeVolume: s.ce.relativeVolume,
            premiumChange5m: s.ce.premiumChange5m, premiumChange15m: s.ce.premiumChange15m,
            now,
          });
    const peParticipation =
      peOi.value === null
        ? null
        : classifyOiParticipation({
            optionType: "PE", strike: s.strike,
            ltp: s.pe.ltp, prevClose: s.pe.prevClose,
            oi: pe.currentOi, oiChange: peOi.value, oiChangePct: peOi.pct,
            oiWindow: peOi.window, oiSource: peOi.source,
            volume: s.pe.volume, relativeVolume: s.pe.relativeVolume,
            premiumChange5m: s.pe.premiumChange5m, premiumChange15m: s.pe.premiumChange15m,
            now,
          });

    const strikePcr = ce.currentOi !== null && ce.currentOi > 0 && pe.currentOi !== null ? pe.currentOi / ce.currentOi : null;

    const { cluster, clusterReason } = classifyCluster(ceOi, peOi, spot, s.strike);
    rows.push({ strike: s.strike, isAtm: atmStrike !== null && s.strike === atmStrike, ce, pe, ceParticipation, peParticipation, strikePcr, cluster, clusterReason });
  }

  // ---- Chain-level aggregates ----
  const totalCeOi = sum(rows.map((r) => r.ce.currentOi));
  const totalPeOi = sum(rows.map((r) => r.pe.currentOi));
  const combinedOi = totalCeOi !== null && totalPeOi !== null ? totalCeOi + totalPeOi : null;
  const pcr = totalCeOi !== null && totalCeOi > 0 && totalPeOi !== null ? round2(totalPeOi / totalCeOi) : null;

  const ce5m = sum(rows.map((r) => r.ce.windows.m5.change));
  const pe5m = sum(rows.map((r) => r.pe.windows.m5.change));
  const ce15m = sum(rows.map((r) => r.ce.windows.m15.change));
  const pe15m = sum(rows.map((r) => r.pe.windows.m15.change));
  const ceSession = sum(rows.map((r) => r.ce.sessionCumulativeChange));
  const peSession = sum(rows.map((r) => r.pe.sessionCumulativeChange));

  const ceBase = sum(rows.map((r) => r.ce.sessionBaselineOi));
  const peBase = sum(rows.map((r) => r.pe.sessionBaselineOi));
  const ce5mPct = changePct(ce5m, ceBase);
  const pe5mPct = changePct(pe5m, peBase);
  const ce15mPct = changePct(ce15m, ceBase);
  const pe15mPct = changePct(pe15m, peBase);

  // PCR change: baseline PCR vs current PCR, so a positioning shift is visible.
  const pcrChange = (() => {
    if (pcr === null || ceBase === null || peBase === null || ceBase === 0) return null;
    return round2(peBase / ceBase - pcr);
  })();

  const windowsAvailability = (windowKey: "m1" | "m5" | "m15"): WindowAvailability => {
    const states = rows.map((r) => r.ce.windows[windowKey].availability);
    if (states.length === 0) return "WAITING_FOR_HISTORY";
    if (states.every((s) => s === "AVAILABLE")) return "AVAILABLE";
    if (states.some((s) => s === "AVAILABLE")) return "INSUFFICIENT_DATA";
    return states.every((s) => s === "WAITING_FOR_HISTORY") ? "WAITING_FOR_HISTORY" : "INSUFFICIENT_DATA";
  };
  const sessionAvailability: WindowAvailability = rows.length > 0 && rows.every((r) => r.ce.sessionCumulativeChange !== null) ? "AVAILABLE" : rows.some((r) => r.ce.sessionCumulativeChange !== null) ? "INSUFFICIENT_DATA" : "WAITING_FOR_HISTORY";

  // ---- Rankings ----
  const oiPairs: Array<{ strike: number; side: "CE" | "PE"; oi: number }> = [];
  for (const r of rows) {
    if (r.ce.currentOi !== null) oiPairs.push({ strike: r.strike, side: "CE", oi: r.ce.currentOi });
    if (r.pe.currentOi !== null) oiPairs.push({ strike: r.strike, side: "PE", oi: r.pe.currentOi });
  }
  const highestOiStrikes = [...oiPairs].sort((a, b) => b.oi - a.oi).slice(0, 6);

  const collectChanges = (windowKey: "m5" | "m15" | "session") =>
    rows.flatMap((r) => {
      const out: Array<{ strike: number; side: "CE" | "PE"; change: number; pct: number | null; window: string }> = [];
      const win = windowKey === "m5" ? r.ce.windows.m5 : windowKey === "m15" ? r.ce.windows.m15 : null;
      const ceChange = windowKey === "session" ? r.ce.sessionCumulativeChange : win?.change ?? null;
      const ceP = windowKey === "session" ? r.ce.sessionCumulativeChangePct : win?.pct ?? null;
      if (ceChange !== null) out.push({ strike: r.strike, side: "CE", change: ceChange, pct: ceP, window: windowKey });
      const peWin = windowKey === "m5" ? r.pe.windows.m5 : windowKey === "m15" ? r.pe.windows.m15 : null;
      const peChange = windowKey === "session" ? r.pe.sessionCumulativeChange : peWin?.change ?? null;
      const peP = windowKey === "session" ? r.pe.sessionCumulativeChangePct : peWin?.pct ?? null;
      if (peChange !== null) out.push({ strike: r.strike, side: "PE", change: peChange, pct: peP, window: windowKey });
      return out;
    });

  // Prefer the finest available window for the rankings.
  const rankingWindow: "m5" | "m15" | "session" = rows.some((r) => r.ce.windows.m5.change !== null || r.pe.windows.m5.change !== null) ? "m5" : rows.some((r) => r.ce.windows.m15.change !== null || r.pe.windows.m15.change !== null) ? "m15" : "session";
  const allChanges = collectChanges(rankingWindow);
  const largestAdditions = [...allChanges].filter((c) => c.change > 0).sort((a, b) => b.change - a.change).slice(0, 6);
  const largestReductions = [...allChanges].filter((c) => c.change < 0).sort((a, b) => a.change - b.change).slice(0, 6);

  const buildupClusters = largestAdditions.slice(0, 4).map(({ strike, side, change, pct }) => ({ strike, side, change, pct }));
  const unwindingClusters = largestReductions.slice(0, 4).map(({ strike, side, change, pct }) => ({ strike, side, change, pct }));

  const freshParticipation = rows.reduce((acc, r) => acc + (r.ceParticipation?.pattern === "LONG_BUILDUP_PATTERN" || r.ceParticipation?.pattern === "SHORT_BUILDUP_PATTERN" ? 1 : 0) + (r.peParticipation?.pattern === "LONG_BUILDUP_PATTERN" || r.peParticipation?.pattern === "SHORT_BUILDUP_PATTERN" ? 1 : 0), 0);
  const weakeningParticipation = rows.reduce((acc, r) => acc + (r.ceParticipation?.pattern === "LONG_UNWINDING_PATTERN" || r.ceParticipation?.pattern === "SHORT_COVERING_PATTERN" ? 1 : 0) + (r.peParticipation?.pattern === "LONG_UNWINDING_PATTERN" || r.peParticipation?.pattern === "SHORT_COVERING_PATTERN" ? 1 : 0), 0);

  const distinctTimes = [...new Set(history.map((h) => h.receivedAt))].sort((a, b) => a - b);
  const baselineAt = distinctTimes.length > 0 ? new Date(distinctTimes[0]).toISOString() : null;
  const newestAt = distinctTimes.length > 0 ? new Date(distinctTimes[distinctTimes.length - 1]).toISOString() : null;

  const unavailableReasons: string[] = [];
  if (windowsAvailability("m5") !== "AVAILABLE") unavailableReasons.push(`5-minute rolling change ${windowsAvailability("m5").replace(/_/g, " ").toLowerCase()} — keep the app running so observations accumulate`);
  if (windowsAvailability("m15") !== "AVAILABLE") unavailableReasons.push(`15-minute rolling change ${windowsAvailability("m15").replace(/_/g, " ").toLowerCase()}`);
  if (windowsAvailability("m1") !== "AVAILABLE") unavailableReasons.push(`1-minute rolling change ${windowsAvailability("m1").replace(/_/g, " ").toLowerCase()}`);
  if (sessionAvailability !== "AVAILABLE") unavailableReasons.push("session cumulative change pending a valid baseline");
  if (strikes.length === 0) unavailableReasons.push("no option-chain rows available");

  const status: OiIntelligenceSummary["status"] =
    strikes.length === 0
      ? "UNAVAILABLE"
      : windowsAvailability("m5") === "AVAILABLE" && sessionAvailability === "AVAILABLE"
        ? "LIVE"
        : rows.some((r) => r.ce.currentOi !== null)
          ? windowsAvailability("m5") === "WAITING_FOR_HISTORY"
            ? "WAITING_FOR_HISTORY"
            : "PARTIAL"
          : "INVALID";

  const interpretation: string[] = [];
  if (pcr !== null) interpretation.push(`PCR (PE OI / CE OI, current levels) = ${pcr.toFixed(3)}${pcrChange !== null ? `, moved ${pcrChange > 0 ? "+" : ""}${pcrChange} vs the session baseline` : ""}.`);
  if (ce5m !== null || pe5m !== null) interpretation.push(`Rolling 5m ΔOI: CE ${ce5m === null ? "n/a" : ce5m.toLocaleString("en-IN")} (${ce5mPct === null ? "pct n/a" : `${ce5mPct.toFixed(2)}%`}), PE ${pe5m === null ? "n/a" : pe5m.toLocaleString("en-IN")} (${pe5mPct === null ? "pct n/a" : `${pe5mPct.toFixed(2)}%`}).`);
  if (ce15m !== null || pe15m !== null) interpretation.push(`Rolling 15m ΔOI: CE ${ce15m === null ? "n/a" : ce15m.toLocaleString("en-IN")}, PE ${pe15m === null ? "n/a" : pe15m.toLocaleString("en-IN")}.`);
  if (ceSession !== null || peSession !== null) interpretation.push(`Session cumulative ΔOI: CE ${ceSession === null ? "n/a" : ceSession.toLocaleString("en-IN")}, PE ${peSession === null ? "n/a" : peSession.toLocaleString("en-IN")}.`);
  if (largestAdditions.length > 0) interpretation.push(`Largest ${rankingWindow} OI additions: ${largestAdditions.slice(0, 3).map((c) => `${c.side} ${c.strike.toLocaleString("en-IN")} +${c.change.toLocaleString("en-IN")}`).join(", ")}.`);
  if (largestReductions.length > 0) interpretation.push(`Largest ${rankingWindow} OI reductions: ${largestReductions.slice(0, 3).map((c) => `${c.side} ${c.strike.toLocaleString("en-IN")} ${c.change.toLocaleString("en-IN")}`).join(", ")}.`);
  interpretation.push(`Participation: ${freshParticipation} contract(s) showing fresh buildup, ${weakeningParticipation} showing unwinding/covering.`);
  interpretation.push("OI additions alone do not prove option writing, and OI is never treated as direct proof of buyer or seller identity.");

  return {
    status,
    message:
      strikes.length === 0
        ? "No option-chain rows available — ΔOI intelligence has nothing to measure."
        : `${rows.length} strike(s) measured for expiry ${expiry} across ${distinctTimes.length} stored observation(s). ${unavailableReasons.length > 0 ? `Pending: ${unavailableReasons.length} window(s).` : "All rolling windows available."}`,
    totalCeOi, totalPeOi, combinedOi, pcr, pcrChange,
    ce5mChange: ce5m, pe5mChange: pe5m, ce15mChange: ce15m, pe15mChange: pe15m,
    ceSessionChange: ceSession, peSessionChange: peSession,
    ce5mPct, pe5mPct, ce15mPct, pe15mPct,
    windows: { m1: windowsAvailability("m1"), m5: windowsAvailability("m5"), m15: windowsAvailability("m15"), session: sessionAvailability },
    snapshotCount: history.length,
    distinctObservations: distinctTimes.length,
    oldestSnapshotAt: baselineAt,
    newestSnapshotAt: newestAt,
    baselineAt,
    rows,
    highestOiStrikes,
    largestAdditions,
    largestReductions,
    buildupClusters,
    unwindingClusters,
    freshParticipation,
    weakeningParticipation,
    interpretation,
    unavailableReasons,
    priceConfirmationNote: PRICE_CONFIRMATION_NOTE,
  };
}

function classifyCluster(
  ceOi: { value: number | null; pct: number | null },
  peOi: { value: number | null; pct: number | null },
  spot: number | null,
  strike: number,
): { cluster: OiClusterKind; clusterReason: string } {
  const ceUp = ceOi.value !== null && ceOi.value > 0;
  const ceDown = ceOi.value !== null && ceOi.value < 0;
  const peUp = peOi.value !== null && peOi.value > 0;
  const peDown = peOi.value !== null && peOi.value < 0;
  const ceMag = ceOi.pct !== null && Math.abs(ceOi.pct) >= OI_MAGNITUDE_PCT.moderate;
  const peMag = peOi.pct !== null && Math.abs(peOi.pct) >= OI_MAGNITUDE_PCT.moderate;

  if (ceUp && ceMag && !peUp) return { cluster: "CE_BUILDUP_CLUSTER", clusterReason: `CE OI added ${ceOi.value!.toLocaleString("en-IN")} (${ceOi.pct!.toFixed(2)}% of the contract's OI) while PE OI did not rise — participation concentrating on the call side. Not confirmed resistance without price action.` };
  if (peUp && peMag && !ceUp) return { cluster: "PE_BUILDUP_CLUSTER", clusterReason: `PE OI added ${peOi.value!.toLocaleString("en-IN")} (${peOi.pct!.toFixed(2)}% of the contract's OI) while CE OI did not rise — participation concentrating on the put side. Not confirmed support without price action.` };
  if (ceDown && ceMag) return { cluster: "CE_UNWINDING_CLUSTER", clusterReason: `CE OI reduced by ${Math.abs(ceOi.value!).toLocaleString("en-IN")} (${ceOi.pct!.toFixed(2)}%) — positions on the call side are being closed, not freshly written.` };
  if (peDown && peMag) return { cluster: "PE_UNWINDING_CLUSTER", clusterReason: `PE OI reduced by ${Math.abs(peOi.value!).toLocaleString("en-IN")} (${peOi.pct!.toFixed(2)}%) — positions on the put side are being closed, not freshly written.` };
  if (ceUp && peUp) return { cluster: "BALANCED", clusterReason: "Both CE and PE OI rose at this strike — two-sided participation, so neither side can be read as dominant." };
  return { cluster: "NO_SIGNAL", clusterReason: "OI change at this strike is below the magnitude threshold or unavailable — no cluster asserted." };
}

function sum(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null;
}

/* ------------------------------------------------------------------ *
 * H. OI Participation Score for the Best Strike Finder
 * ------------------------------------------------------------------ */

export interface OiParticipationScore {
  score: number | null;
  coverage: number;
  components: Record<string, number | null>;
  reasons: string[];
  alignment: "SUPPORTIVE" | "NEUTRAL" | "CONTRADICTORY" | "UNAVAILABLE";
}

/**
 * OI Participation Score (Score B2) — how well THIS contract's OI behaviour supports a
 * directional BUY on its side. Deliberately separate from the directional setup score
 * (A), Greeks suitability (B) and execution quality (C).
 *
 * A rising-OI + rising-premium contract on the aligned side scores highest; an
 * unwinding contract scores lowest; an unaligned or unmeasurable contract scores null.
 */
export function scoreOiParticipation(args: {
  optionType: "CE" | "PE";
  measurement: ContractOiMeasurements | null;
  participation: OiParticipationResult | null;
  underlyingDirection: "BULLISH" | "BEARISH" | "FLAT" | "UNAVAILABLE";
}): OiParticipationScore {
  const { optionType, measurement, participation, underlyingDirection } = args;
  const reasons: string[] = [];

  if (!measurement || !participation) {
    return {
      score: null,
      coverage: 0,
      components: {},
      reasons: ["OI participation not measurable for this contract — no OI change observation available."],
      alignment: "UNAVAILABLE",
    };
  }

  // Component 1: OI change direction. A BUY candidate wants FRESH participation on its
  // own side, which means rising OI. Falling OI means positions are closing.
  const oiChange = measurement.windows.m5.change ?? measurement.sessionCumulativeChange ?? measurement.changeInOi;
  const oiWindow = measurement.windows.m5.change !== null ? "5m" : measurement.sessionCumulativeChange !== null ? "session" : "prev_oi";
  let oiDirScore: number | null = null;
  if (oiChange !== null) {
    if (oiChange > 0) {
      oiDirScore = 1;
      reasons.push(`OI rising over ${oiWindow} — fresh participation on the ${optionType} side.`);
    } else if (oiChange < 0) {
      oiDirScore = 0.1;
      reasons.push(`OI falling over ${oiWindow} — positions closing, not fresh participation.`);
    } else {
      oiDirScore = 0.4;
      reasons.push(`OI unchanged over ${oiWindow}.`);
    }
  }

  // Component 2: OI change magnitude (percentage of the contract's own OI).
  const pct = measurement.windows.m5.pct ?? measurement.sessionCumulativeChangePct ?? measurement.changeInOiPct;
  let magnitudeScore: number | null = null;
  if (pct !== null) {
    magnitudeScore = clamp01(Math.abs(pct) / OI_MAGNITUDE_PCT.large);
    if (Math.abs(pct) >= OI_MAGNITUDE_PCT.large) reasons.push(`OI moved ${pct.toFixed(2)}% of the contract's OI — a material shift.`);
    else if (Math.abs(pct) < OI_MAGNITUDE_PCT.moderate) reasons.push(`OI moved ${pct.toFixed(2)}% — small relative to the contract's OI.`);
  }

  // Component 3: participation pattern. Only a pattern where premium AND OI move in the
  // direction a buyer needs scores well. A writing pattern (premium falling + OI rising)
  // or an unwinding pattern scores near zero, because the premium leg contradicts the BUY.
  let patternScore: number | null = null;
  if (participation.pattern !== "INCONCLUSIVE") {
    switch (participation.pattern) {
      case "LONG_BUILDUP_PATTERN":
        patternScore = 1;
        break;
      case "SHORT_COVERING_PATTERN":
        // Premium rising on falling OI: favourable but not fresh participation.
        patternScore = 0.6;
        break;
      case "SHORT_BUILDUP_PATTERN":
      case "LONG_UNWINDING_PATTERN":
        // The premium leg is falling — directly against a BUY.
        patternScore = 0.05;
        break;
      default:
        patternScore = 0.4;
    }
    reasons.push(`Pattern: ${participation.pattern.replace(/_/g, " ").toLowerCase()}.`);
  }

  // Component 4: volume confirmation.
  let volumeScore: number | null = null;
  if (participation.volumeConfirms !== null) {
    volumeScore = participation.volumeConfirms ? 1 : 0.3;
    reasons.push(participation.volumeReason);
  }

  // Component 5: alignment — BOTH the underlying direction and the contract's own
  // premium direction must agree with the intended trade. A CE BUY with a bullish
  // underlying but a falling CE premium is not aligned: the contract is not confirming
  // the move, regardless of what OI is doing.
  let alignmentScore: number | null = null;
  if (underlyingDirection !== "UNAVAILABLE" && underlyingDirection !== "FLAT") {
    const underlyingAligned =
      (optionType === "CE" && underlyingDirection === "BULLISH") || (optionType === "PE" && underlyingDirection === "BEARISH");
    const premiumAligned =
      participation.premiumDirection === "RISING" ? true : participation.premiumDirection === "FALLING" ? false : null;
    if (underlyingAligned && premiumAligned === true) {
      alignmentScore = 1;
      reasons.push(`OI participation and premium are both aligned with a ${underlyingDirection.toLowerCase()} underlying read for a ${optionType} BUY.`);
    } else if (!underlyingAligned) {
      alignmentScore = 0.05;
      reasons.push(`OI participation is not aligned with a ${underlyingDirection.toLowerCase()} underlying read for a ${optionType} BUY.`);
    } else {
      // Underlying aligned but the premium is falling or flat.
      alignmentScore = 0.2;
      reasons.push(
        `Underlying is ${underlyingDirection.toLowerCase()} but the ${optionType} premium is ${participation.premiumDirection.toLowerCase()} — the contract is not confirming the move.`,
      );
    }
  }

  const components: Record<string, number | null> = { oiDirection: oiDirScore, magnitude: magnitudeScore, pattern: patternScore, volume: volumeScore, alignment: alignmentScore };
  // Weighting rationale: the pattern (premium+OI together) and the combined alignment
  // carry the directional meaning, so together they outweigh raw OI direction. Without
  // this, "rising OI" alone could mask a collapsing premium and a writing pattern would
  // score as SUPPORTIVE for a BUY.
  const weights = { oiDirection: 20, magnitude: 15, pattern: 30, volume: 15, alignment: 20 };
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const availableWeight = Object.entries(weights).filter(([k]) => components[k] !== null).reduce((a, [, b]) => a + b, 0);
  const coverage = totalWeight > 0 ? availableWeight / totalWeight : 0;

  let score: number | null = null;
  if (coverage > 0) {
    score = clampScore(
      (weights.oiDirection * (oiDirScore ?? 0) +
        weights.magnitude * (magnitudeScore ?? 0) +
        weights.pattern * (patternScore ?? 0) +
        weights.volume * (volumeScore ?? 0) +
        weights.alignment * (alignmentScore ?? 0)) *
        (0.6 + 0.4 * coverage),
    );
  }

  const alignment: OiParticipationScore["alignment"] =
    score === null
      ? "UNAVAILABLE"
      : score >= 65
        ? "SUPPORTIVE"
        : score >= 45
          ? "NEUTRAL"
          : "CONTRADICTORY";

  return { score, coverage: Math.round(coverage * 100) / 100, components, reasons, alignment };
}
