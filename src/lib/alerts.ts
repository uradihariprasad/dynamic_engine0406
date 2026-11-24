import { db } from "@/db";
import { alertEvent } from "@/db/schema";
import type { SrLevels, Zone, StrikeSelection, TradePlan, OiIntel } from "@/lib/engine/types";

export interface AlertCandidate {
  symbol: string;
  type: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  message: string;
  dedupeKey: string;
  payload?: Record<string, unknown>;
}

export interface AlertEngineInput {
  symbol: string;
  levels: SrLevels;
  zones: Zone[];
  selection: StrikeSelection;
  trade: TradePlan;
  oi: OiIntel;
  atmStrike: number | null;
  candleDataStale: boolean;
  disconnected: boolean;
  bucketTs: number;
  /** Stored quote observations — Greeks alerts fire only when data is fresh. */
  greeksObservationsFresh: boolean;
}

function zoneAlert(symbol: string, role: string, zone: Zone | null, bucketTs: number, extra?: string): AlertCandidate | null {
  if (!zone) return null;
  const allowed = ["STRENGTHENING", "WEAKENING", "BREAKOUT_RISK", "BREAKDOWN_RISK", "BROKEN", "INVALIDATED"];
  if (!allowed.includes(zone.status)) return null;
  const severity = zone.status === "BROKEN" || zone.status === "INVALIDATED" ? "CRITICAL" : zone.status === "BREAKOUT_RISK" || zone.status === "BREAKDOWN_RISK" ? "WARNING" : "INFO";
  return {
    symbol,
    type: `${role}_${zone.status}`,
    severity,
    title: `${role} ${zone.status.replace("_", " ")}`,
    message: `${role} zone ${zone.lower}–${zone.upper} is ${zone.status}. ${zone.statusReason}${extra ? ` ${extra}` : ""}`,
    dedupeKey: `${bucketTs}:${role}:${zone.id}:${zone.status}`,
    payload: { zoneId: zone.id, score: zone.score },
  };
}

export function buildAlerts(input: AlertEngineInput): AlertCandidate[] {
  const { symbol, levels, selection, trade, oi, atmStrike, candleDataStale, disconnected, bucketTs, greeksObservationsFresh } = input;
  const out: AlertCandidate[] = [];
  const push = (a: AlertCandidate | null) => {
    if (a) out.push(a);
  };

  push(zoneAlert(symbol, "IMMEDIATE_SUPPORT", levels.immediateSupport?.zone ?? null, bucketTs));
  push(zoneAlert(symbol, "PRIMARY_SUPPORT", levels.primarySupport?.zone ?? null, bucketTs));
  push(zoneAlert(symbol, "IMMEDIATE_RESISTANCE", levels.immediateResistance?.zone ?? null, bucketTs));
  push(zoneAlert(symbol, "PRIMARY_RESISTANCE", levels.primaryResistance?.zone ?? null, bucketTs));

  const ceMomentum = selection.bestCall?.leg.momentumScore ?? null;
  const peMomentum = selection.bestPut?.leg.momentumScore ?? null;
  if (ceMomentum !== null && ceMomentum >= 70) {
    out.push({
      symbol,
      type: "CE_MOMENTUM_ACCELERATION",
      severity: "INFO",
      title: "CE momentum acceleration",
      message: `Best CALL candidate ${selection.bestCall?.strike} momentum score ${ceMomentum} (premium ${selection.bestCall?.leg.premiumChangePct ?? "n/a"}%).`,
      dedupeKey: `${bucketTs}:CE_MOM:${selection.bestCall?.strike}:${Math.round(ceMomentum / 5)}`,
    });
  }
  if (peMomentum !== null && peMomentum >= 70) {
    out.push({
      symbol,
      type: "PE_MOMENTUM_ACCELERATION",
      severity: "INFO",
      title: "PE momentum acceleration",
      message: `Best PUT candidate ${selection.bestPut?.strike} momentum score ${peMomentum} (premium ${selection.bestPut?.leg.premiumChangePct ?? "n/a"}%).`,
      dedupeKey: `${bucketTs}:PE_MOM:${selection.bestPut?.strike}:${Math.round(peMomentum / 5)}`,
    });
  }
  const ce5 = oi.ce5mChange;
  const pe5 = oi.pe5mChange;
  if (ce5 !== null && Math.abs(ce5) > 0) {
    out.push({
      symbol,
      type: "SIGNIFICANT_OI_CHANGE",
      severity: "INFO",
      title: "Significant CE OI change (5m rolling)",
      message: `CE OI 5m change ${ce5}; PE 5m change ${pe5 ?? "unavailable"}.`,
      dedupeKey: `${bucketTs}:OI:CE:${ce5 > 0 ? "+" : "-"}:${Math.round(Math.abs(ce5) / 1000)}`,
    });
  }
  if (atmStrike !== null) {
    out.push({
      symbol,
      type: "ATM_STRIKE",
      severity: "INFO",
      title: "ATM strike reference",
      message: `ATM strike is ${atmStrike} for expiry ${selection.expiry ?? "unavailable"}.`,
      dedupeKey: `${bucketTs}:ATM:${atmStrike}`,
    });
  }
  if (trade.action !== "NO_TRADE") {
    out.push({
      symbol,
      type: trade.entryState === "MISSED_ENTRY" ? "TRADE_INVALIDATED" : "TRADE_ENTRY_TRIGGER",
      severity: trade.entryState === "MISSED_ENTRY" ? "WARNING" : "INFO",
      title: `${trade.action} setup (${trade.entryState.replace("_", " ")})`,
      message: `${trade.headline}. Setup score ${trade.setupScore}, suitability ${trade.contract?.suitabilityScore ?? "n/a"}. ${trade.entryTrigger}`,
      dedupeKey: `${bucketTs}:TRADE:${trade.action}:${trade.contract?.strike}:${trade.entryState}`,
      payload: { setupScore: trade.setupScore, suitability: trade.contract?.suitabilityScore ?? null },
    });
  }
  if (candleDataStale) {
    out.push({
      symbol,
      type: "STALE_DATA",
      severity: "WARNING",
      title: "Stale candle data",
      message: "Latest candle timestamp is materially behind the current time — analysis is running on stale data.",
      dedupeKey: `${bucketTs}:STALE`,
    });
  }
  if (disconnected) {
    out.push({
      symbol,
      type: "DATA_DISCONNECTION",
      severity: "CRITICAL",
      title: "Market data disconnected",
      message: "Upstox data source reported a disconnection or transport failure.",
      dedupeKey: `${bucketTs}:DISCONNECT`,
    });
  }
  out.push(...buildGreeksAlerts(symbol, selection, bucketTs, greeksObservationsFresh));
  return out;
}

/**
 * Greeks-driven alerts. Every alert carries its own evidence source and is
 * suppressed entirely when the underlying observations are not fresh, so no
 * stale value can trigger an alert.
 */
function buildGreeksAlerts(symbol: string, selection: StrikeSelection, bucketTs: number, fresh: boolean): AlertCandidate[] {
  if (!fresh) return [];
  const out: AlertCandidate[] = [];
  const candidates = [selection.bestCall, selection.bestPut].filter((c): c is NonNullable<typeof c> => Boolean(c));

  for (const c of candidates) {
    const ga = c.leg.greeksAssessment;
    if (!ga) continue;
    const tag = `${c.optionType}${c.strike}`;

    // Delta entering the preference band
    if (ga.delta.band === "INSIDE" && ga.delta.absolute !== null) {
      out.push({
        symbol,
        type: "DELTA_IN_PREFERENCE_BAND",
        severity: "INFO",
        title: `${c.optionType} ${c.strike} delta in preference band`,
        message: `|Delta| ${ga.delta.absolute.toFixed(3)} is inside the preferred 0.40–0.65 band for a BUY candidate. Source: option_greeks.delta. ${ga.delta.bandReason}`,
        dedupeKey: `${bucketTs}:DELTA_BAND:${tag}:${Math.round(ga.delta.absolute * 100)}`,
        payload: { strike: c.strike, delta: ga.delta.absolute },
      });
    }
    // Unusually elevated gamma (relative to comparable contracts, never a fixed threshold)
    if (ga.gamma.classification === "EXTREME" || ga.gamma.classification === "HIGH") {
      out.push({
        symbol,
        type: "GAMMA_ELEVATED",
        severity: ga.gamma.expiryAdjustedRisk === "SEVERE" ? "WARNING" : "INFO",
        title: `${c.optionType} ${c.strike} gamma ${ga.gamma.classification.toLowerCase()}`,
        message: `Gamma is ${ga.gamma.relativeToPeers?.toFixed(2) ?? "?"}× the median of comparable contracts; expiry-adjusted risk ${ga.gamma.expiryAdjustedRisk.toLowerCase()}. ${ga.gamma.reason}`,
        dedupeKey: `${bucketTs}:GAMMA:${tag}:${ga.gamma.classification}`,
        payload: { strike: c.strike, relativeGamma: ga.gamma.relativeToPeers },
      });
    }
    // Excessive theta cost
    if (ga.theta.classification === "EXPENSIVE" || ga.theta.classification === "SEVERE") {
      out.push({
        symbol,
        type: "THETA_COST_EXCESSIVE",
        severity: ga.theta.classification === "SEVERE" ? "WARNING" : "INFO",
        title: `${c.optionType} ${c.strike} decay cost ${ga.theta.classification.toLowerCase()}`,
        message: `Decay is ${((ga.theta.ratioToLtp ?? 0) * 100).toFixed(2)}% of premium. ${ga.theta.reason}`,
        dedupeKey: `${bucketTs}:THETA:${tag}:${ga.theta.classification}`,
        payload: { strike: c.strike, ratio: ga.theta.ratioToLtp },
      });
    }
    // IV expansion / contraction
    if (ga.vega.ivChange !== null && Math.abs(ga.vega.ivChange) >= 0.5) {
      out.push({
        symbol,
        type: ga.vega.ivChange > 0 ? "IV_EXPANSION" : "IV_CONTRACTION",
        severity: ga.vega.ivChange < 0 ? "WARNING" : "INFO",
        title: `${c.optionType} ${c.strike} IV ${ga.vega.ivChange > 0 ? "expanding" : "contracting"}`,
        message: `IV moved ${ga.vega.ivChange > 0 ? "+" : ""}${ga.vega.ivChange} vs ~5m ago. ${ga.vega.ivChange > 0 ? (ga.vega.expansionRisk ?? "") : (ga.vega.contractionRisk ?? "")}`,
        dedupeKey: `${bucketTs}:IV:${tag}:${ga.vega.ivChange > 0 ? "up" : "down"}`,
        payload: { strike: c.strike, ivChange: ga.vega.ivChange },
      });
    }
    // Material Greeks change vs ~5 minutes ago
    if (ga.delta.changeFromHistory !== null && Math.abs(ga.delta.changeFromHistory) >= 0.05) {
      out.push({
        symbol,
        type: "GREEKS_MATERIAL_CHANGE",
        severity: "INFO",
        title: `${c.optionType} ${c.strike} delta moved materially`,
        message: `Delta changed ${ga.delta.changeFromHistory > 0 ? "+" : ""}${ga.delta.changeFromHistory.toFixed(3)} vs ~5m ago. Gamma change ${ga.gamma.changeFromHistory ?? "n/a"}. Source: stored option_greeks observations.`,
        dedupeKey: `${bucketTs}:GCHANGE:${tag}:${ga.delta.changeFromHistory > 0 ? "up" : "down"}`,
        payload: { strike: c.strike, deltaChange: ga.delta.changeFromHistory },
      });
    }
  }
  return out;
}

export async function persistAlerts(alerts: AlertCandidate[]): Promise<void> {
  if (alerts.length === 0) return;
  try {
    await db
      .insert(alertEvent)
      .values(
        alerts.map((a) => ({
          symbol: a.symbol,
          type: a.type,
          severity: a.severity,
          title: a.title,
          message: a.message,
          dedupeKey: a.dedupeKey,
          payload: a.payload ?? null,
        })),
      )
      .onConflictDoNothing();
  } catch {
    // Alert persistence must never break the analysis pipeline.
  }
}
