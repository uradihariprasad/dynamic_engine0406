import type { FuturesIntel } from "@/lib/engine/types";

export interface FuturesSnapshot {
  ltp: number | null;
  oi: number | null;
  prevOi: number | null;
  volume: number | null;
  expiry: string | null;
  instrumentKey: string | null;
  tradingSymbol: string | null;
  lotSize: number | null;
}

/**
 * Futures positioning intelligence.
 *
 * NOTE: aggregate futures OI/price/volume cannot identify *who* is positioned.
 * The classification below is the standard price/OI/volume interaction read and
 * is labelled accordingly (`participation: NOT_INFERRED`).
 */
export function analyzeFutures(
  current: FuturesSnapshot,
  reference: FuturesSnapshot | null,
  spot: number | null,
  referenceAgeMinutes: number | null,
): FuturesIntel {
  const unavailable: FuturesIntel = {
    status: "UNAVAILABLE",
    message: "Futures contract not resolved from the instrument master, or no quote returned by Upstox.",
    instrumentKey: current.instrumentKey,
    tradingSymbol: current.tradingSymbol,
    expiry: current.expiry,
    lotSize: current.lotSize,
    ltp: null,
    spot,
    basis: null,
    basisPct: null,
    volume: null,
    oi: null,
    changeInOi: null,
    changeInOiPct: null,
    priceChange: null,
    volumeChange: null,
    classification: "UNAVAILABLE",
    interpretation: [],
    participation: "NOT_INFERRED",
  };

  if (current.instrumentKey === null || current.ltp === null) return unavailable;
  if (current.oi === null) {
    return {
      ...unavailable,
      status: "PARTIAL",
      message: "Futures LTP available but open interest unavailable in the Upstox response — OI-based positioning read disabled.",
      ltp: current.ltp,
      volume: current.volume,
    };
  }

  const refLtp = reference?.ltp ?? null;
  const refOi = reference?.oi ?? null;
  const refVol = reference?.volume ?? null;
  const priceChange = refLtp !== null ? current.ltp - refLtp : null;
  const changeInOi = refOi !== null ? current.oi - refOi : null;
  const changeInOiPct =
    changeInOi !== null && refOi !== null && refOi !== 0 ? (changeInOi / Math.abs(refOi)) * 100 : null;
  const volumeChange = refVol !== null && current.volume !== null ? current.volume - refVol : null;

  let classification: FuturesIntel["classification"] = "NEUTRAL";
  if (priceChange !== null && changeInOi !== null) {
    const priceUp = priceChange > 0;
    const oiUp = changeInOi > 0;
    if (priceUp && oiUp) classification = "LONG_BUILDUP";
    else if (!priceUp && oiUp) classification = "SHORT_BUILDUP";
    else if (priceUp && !oiUp) classification = "SHORT_COVERING";
    else classification = "LONG_UNWINDING";
  }

  const basis = spot !== null ? current.ltp - spot : null;
  const basisPct = basis !== null && spot !== null ? (basis / spot) * 100 : null;

  const interpretation: string[] = [];
  switch (classification) {
    case "LONG_BUILDUP":
      interpretation.push("Futures price up with rising OI — long buildup pattern (aggregate read).");
      break;
    case "SHORT_BUILDUP":
      interpretation.push("Futures price down with rising OI — short buildup pattern (aggregate read).");
      break;
    case "SHORT_COVERING":
      interpretation.push("Futures price up with falling OI — short covering pattern (aggregate read).");
      break;
    case "LONG_UNWINDING":
      interpretation.push("Futures price down with falling OI — long unwinding pattern (aggregate read).");
      break;
    default:
      interpretation.push("Futures price/OI interaction is inconclusive.");
  }
  if (volumeChange !== null) {
    interpretation.push(`Futures volume change vs ${referenceAgeMinutes ?? "?"} min ago: ${volumeChange}.`);
  }
  if (basis !== null) {
    interpretation.push(`Basis (futures − spot) ${basis.toFixed(2)} (${basisPct?.toFixed(3)}%).`);
  }
  interpretation.push(
    "Participant identity / institutional activity is NOT inferred from aggregate OI.",
  );

  return {
    status: refLtp === null ? "PARTIAL" : "LIVE",
    message:
      refLtp === null
        ? "Futures quote available; no earlier snapshot in this session yet, so price/OI change vs reference is unavailable."
        : `Futures analysed against ${referenceAgeMinutes ?? "?"}-minute-old snapshot.`,
    instrumentKey: current.instrumentKey,
    tradingSymbol: current.tradingSymbol,
    expiry: current.expiry,
    lotSize: current.lotSize,
    ltp: current.ltp,
    spot,
    basis,
    basisPct: basisPct === null ? null : Math.round(basisPct * 1000) / 1000,
    volume: current.volume,
    oi: current.oi,
    changeInOi,
    changeInOiPct: changeInOiPct === null ? null : Math.round(changeInOiPct * 1000) / 1000,
    priceChange,
    volumeChange,
    classification,
    interpretation,
    participation: "NOT_INFERRED",
  };
}
