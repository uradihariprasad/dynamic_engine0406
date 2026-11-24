import type { SymbolKey, Timeframe } from "@/lib/config";
import { TIMEFRAME_MINUTES } from "@/lib/config";
import { atr, round2, toCandles } from "@/lib/engine/indicators";
import { analyzeStructure, detectConsolidations } from "@/lib/engine/structure";
import { buildClusters, extractCandidates, scoreZones, selectLevels } from "@/lib/engine/zones";
import type { Candle, Zone } from "@/lib/engine/types";
import { aggregateCandles, type RawCandleRow } from "@/lib/upstox/market";

export interface ReplayFrame {
  ts: number;
  spot: number;
  trend: string;
  immediateSupport: { lower: number; upper: number; score: number; status: string } | null;
  primarySupport: { lower: number; upper: number; score: number; status: string } | null;
  immediateResistance: { lower: number; upper: number; score: number; status: string } | null;
  primaryResistance: { lower: number; upper: number; score: number; status: string } | null;
  zones: number;
}

export interface ReplayMetrics {
  barsAnalysed: number;
  zoneTouchCount: number;
  rejectionCount: number;
  rejectionRate: number | null;
  breakoutCount: number;
  breakdownCount: number;
  falseBreakoutCount: number;
  falseBreakdownCount: number;
  falseBreakoutRate: number | null;
  falseBreakdownRate: number | null;
  avgZoneSurvivalBars: number | null;
  avgScoreOfHeldZones: number | null;
  avgScoreOfFailedZones: number | null;
  strengthCalibrationSpread: number | null;
  callSetupForwardMoveAvg: number | null;
  putSetupForwardMoveAvg: number | null;
  callSetupCount: number;
  putSetupCount: number;
}

export interface ReplayResult {
  status: "LIVE" | "PARTIAL" | "UNAVAILABLE" | "INVALID";
  message: string;
  symbol: SymbolKey;
  tradeDate: string;
  timeframe: Timeframe;
  bars: number;
  frames: ReplayFrame[];
  metrics: ReplayMetrics;
  zonesSample: Zone[];
  unavailable: string[];
  lookAheadGuard: string;
}

const emptyMetrics: ReplayMetrics = {
  barsAnalysed: 0,
  zoneTouchCount: 0,
  rejectionCount: 0,
  rejectionRate: null,
  breakoutCount: 0,
  breakdownCount: 0,
  falseBreakoutCount: 0,
  falseBreakdownCount: 0,
  falseBreakoutRate: null,
  falseBreakdownRate: null,
  avgZoneSurvivalBars: null,
  avgScoreOfHeldZones: null,
  avgScoreOfFailedZones: null,
  strengthCalibrationSpread: null,
  callSetupForwardMoveAvg: null,
  putSetupForwardMoveAvg: null,
  callSetupCount: 0,
  putSetupCount: 0,
};

function dayCandles(rows: RawCandleRow[], tradeDate: string): RawCandleRow[] {
  return rows.filter((r) => new Date(r.ts).toISOString().slice(0, 10) === tradeDate);
}

/**
 * Historical replay.
 *
 * LOOK-AHEAD GUARD: for every replay step the zone/structure engines only ever
 * receive candles with `ts <= step`. Nothing from the future is used. OI, Greeks
 * and option premiums are NOT replayed because Upstox does not expose historical
 * option-chain snapshots through the public REST API — those modules are reported
 * as UNAVAILABLE in replay rather than fabricated.
 */
export function runReplay(params: {
  symbol: SymbolKey;
  tradeDate: string;
  timeframe: Timeframe;
  rows: RawCandleRow[];
}): ReplayResult {
  const { symbol, tradeDate, timeframe, rows } = params;
  const unavailable: string[] = [];
  unavailable.push("Historical option-chain OI / Greeks / premium snapshots are not exposed by Upstox historical APIs — options modules are unavailable in replay (not simulated).");
  unavailable.push("Futures OI history is unavailable in replay unless persisted locally during a live session.");

  const day = dayCandles(rows, tradeDate);
  if (day.length < 20) {
    return {
      status: "UNAVAILABLE",
      message: `Only ${day.length} candles available for ${tradeDate}. Historical candles must exist for replay.`,
      symbol,
      tradeDate,
      timeframe,
      bars: day.length,
      frames: [],
      metrics: { ...emptyMetrics },
      zonesSample: [],
      unavailable,
      lookAheadGuard: "Engines receive only candles with ts <= replay step.",
    };
  }

  const minutes = TIMEFRAME_MINUTES[timeframe];
  const aggregated = aggregateCandles(day, minutes);
  const now = new Date(`${tradeDate}T23:59:59.000Z`).getTime();
  const candles = toCandles(aggregated, minutes, now + 1); // everything complete
  const htfMinutes = Math.min(60, minutes * 6);
  const htfCandles = toCandles(aggregateCandles(day, htfMinutes), htfMinutes, now + 1);

  const frames: ReplayFrame[] = [];
  const metrics: ReplayMetrics = { ...emptyMetrics };
  const heldScores: number[] = [];
  const failedScores: number[] = [];
  const survivalBars: number[] = [];
  const forwardCall: number[] = [];
  const forwardPut: number[] = [];
  let lastZones: Zone[] = [];

  const warmup = Math.max(25, Math.floor(minutes / 5) * 5);
  const step = Math.max(1, Math.round(minutes / 5));

  for (let i = warmup; i < candles.length; i += step) {
    const visible = candles.slice(0, i + 1);
    const structure = analyzeStructure(visible, htfCandles.filter((c) => c.ts <= visible[visible.length - 1].ts), timeframe, `${htfMinutes}m`);
    const a = atr(visible, 14);
    const consolidations = detectConsolidations(visible, a, timeframe);
    const spot = visible[visible.length - 1].close;
    const sessionLevels = {
      prevDayHigh: null,
      prevDayLow: null,
      prevClose: null,
      prevWeekHigh: null,
      prevWeekLow: null,
      openingRangeHigh: null,
      openingRangeLow: null,
      sessionHigh: round2(Math.max(...visible.map((c) => c.high))),
      sessionLow: round2(Math.min(...visible.map((c) => c.low))),
      vwap: null,
      vwapStatus: "UNAVAILABLE" as const,
    };
    const sources = extractCandidates({
      symbol,
      spot,
      candles: visible,
      higherTimeframeCandles: htfCandles.filter((c) => c.ts <= visible[visible.length - 1].ts),
      timeframe,
      htfTimeframe: `${htfMinutes}m`,
      structure,
      consolidations,
      sessionLevels,
      volumeProfile: { status: "UNAVAILABLE", message: "", estimated: true, poc: null, vah: null, val: null, developingPoc: null, hvn: [], lvn: [], valueAreaVolumePct: null, concentration: null, migration: null },
      oiClusters: [],
      quotes: { available: false, bidQty: null, askQty: null, note: "Replay: quote depth unavailable" },
      futures: { available: false, classification: null, note: "Replay: futures unavailable" },
      tickSize: 0.05,
      now: visible[visible.length - 1].ts,
    });
    const clusters = buildClusters(sources, {
      symbol,
      spot,
      candles: visible,
      higherTimeframeCandles: [],
      timeframe,
      htfTimeframe: `${htfMinutes}m`,
      structure,
      consolidations,
      sessionLevels,
      volumeProfile: { status: "UNAVAILABLE", message: "", estimated: true, poc: null, vah: null, val: null, developingPoc: null, hvn: [], lvn: [], valueAreaVolumePct: null, concentration: null, migration: null },
      oiClusters: [],
      quotes: { available: false, bidQty: null, askQty: null, note: "Replay" },
      futures: { available: false, classification: null, note: "Replay" },
      tickSize: 0.05,
      now: visible[visible.length - 1].ts,
    });
    const zones = scoreZones(clusters, {
      symbol,
      spot,
      candles: visible,
      higherTimeframeCandles: [],
      timeframe,
      htfTimeframe: `${htfMinutes}m`,
      structure,
      consolidations,
      sessionLevels,
      volumeProfile: { status: "UNAVAILABLE", message: "", estimated: true, poc: null, vah: null, val: null, developingPoc: null, hvn: [], lvn: [], valueAreaVolumePct: null, concentration: null, migration: null },
      oiClusters: [],
      quotes: { available: false, bidQty: null, askQty: null, note: "Replay" },
      futures: { available: false, classification: null, note: "Replay" },
      tickSize: 0.05,
      now: visible[visible.length - 1].ts,
    });
    const levels = selectLevels(zones, spot);
    lastZones = zones;

    frames.push({
      ts: visible[visible.length - 1].ts,
      spot: round2(spot),
      trend: structure.trend,
      immediateSupport: levels.immediateSupport
        ? { lower: levels.immediateSupport.zone.lower, upper: levels.immediateSupport.zone.upper, score: levels.immediateSupport.zone.score, status: levels.immediateSupport.zone.status }
        : null,
      primarySupport: levels.primarySupport
        ? { lower: levels.primarySupport.zone.lower, upper: levels.primarySupport.zone.upper, score: levels.primarySupport.zone.score, status: levels.primarySupport.zone.status }
        : null,
      immediateResistance: levels.immediateResistance
        ? { lower: levels.immediateResistance.zone.lower, upper: levels.immediateResistance.zone.upper, score: levels.immediateResistance.zone.score, status: levels.immediateResistance.zone.status }
        : null,
      primaryResistance: levels.primaryResistance
        ? { lower: levels.primaryResistance.zone.lower, upper: levels.primaryResistance.zone.upper, score: levels.primaryResistance.zone.score, status: levels.primaryResistance.zone.status }
        : null,
      zones: zones.length,
    });

    // Forward evaluation of the zones identified at this step (future candles are
    // used ONLY to measure outcomes, never to build the zone).
    const future = candles.slice(i + 1, i + 1 + 12);
    for (const zone of zones) {
      const touched = future.some((c) => c.low <= zone.upper && c.high >= zone.lower);
      if (!touched) continue;
      metrics.zoneTouchCount += 1;
      const firstTouchIdx = future.findIndex((c) => c.low <= zone.upper && c.high >= zone.lower);
      survivalBars.push(firstTouchIdx + 1);
      const afterTouch = future.slice(firstTouchIdx);
      if (zone.kind === "support") {
        const rejected = afterTouch.some((c) => c.close > zone.lower);
        if (rejected) {
          metrics.rejectionCount += 1;
          heldScores.push(zone.score);
        } else {
          metrics.breakdownCount += 1;
          failedScores.push(zone.score);
        }
      } else {
        const rejected = afterTouch.some((c) => c.close < zone.upper);
        if (rejected) {
          metrics.rejectionCount += 1;
          heldScores.push(zone.score);
        } else {
          metrics.breakoutCount += 1;
          failedScores.push(zone.score);
        }
      }
    }

    // Underlying-only setup outcome measurement (option-level performance is unavailable).
    const structureBullish = structure.trend === "BULLISH";
    const structureBearish = structure.trend === "BEARISH";
    if (structureBullish && levels.immediateResistance) {
      const entry = levels.immediateResistance.zone.upper;
      const fwd = candles.slice(i + 1, i + 7);
      if (fwd.length > 0 && fwd[fwd.length - 1].close > entry) {
        metrics.callSetupCount += 1;
        forwardCall.push(((fwd[fwd.length - 1].close - spot) / spot) * 100);
      }
    }
    if (structureBearish && levels.immediateSupport) {
      const entry = levels.immediateSupport.zone.lower;
      const fwd = candles.slice(i + 1, i + 7);
      if (fwd.length > 0 && fwd[fwd.length - 1].close < entry) {
        metrics.putSetupCount += 1;
        forwardPut.push(((fwd[fwd.length - 1].close - spot) / spot) * 100);
      }
    }
  }

  metrics.barsAnalysed = frames.length;
  metrics.rejectionRate = metrics.zoneTouchCount > 0 ? round2((metrics.rejectionCount / metrics.zoneTouchCount) * 100) : null;
  metrics.falseBreakoutCount = metrics.breakoutCount;
  metrics.falseBreakdownCount = metrics.breakdownCount;
  metrics.falseBreakoutRate = metrics.breakoutCount > 0 ? 100 : null;
  metrics.falseBreakdownRate = metrics.breakdownCount > 0 ? 100 : null;
  metrics.avgZoneSurvivalBars =
    survivalBars.length > 0 ? round2(survivalBars.reduce((a, b) => a + b, 0) / survivalBars.length) : null;
  metrics.avgScoreOfHeldZones = heldScores.length > 0 ? round2(heldScores.reduce((a, b) => a + b, 0) / heldScores.length) : null;
  metrics.avgScoreOfFailedZones = failedScores.length > 0 ? round2(failedScores.reduce((a, b) => a + b, 0) / failedScores.length) : null;
  metrics.strengthCalibrationSpread =
    metrics.avgScoreOfHeldZones !== null && metrics.avgScoreOfFailedZones !== null
      ? round2(metrics.avgScoreOfHeldZones - metrics.avgScoreOfFailedZones)
      : null;
  metrics.callSetupForwardMoveAvg = forwardCall.length > 0 ? round2(forwardCall.reduce((x, y) => x + y, 0) / forwardCall.length) : null;
  metrics.putSetupForwardMoveAvg = forwardPut.length > 0 ? round2(forwardPut.reduce((x, y) => x + y, 0) / forwardPut.length) : null;

  const anyData = frames.length > 0;
  return {
    status: anyData ? "PARTIAL" : "UNAVAILABLE",
    message: anyData
      ? `Replay built from ${aggregated.length} aggregated candles (${frames.length} evaluation steps). Options/OI modules unavailable historically.`
      : "No replay frames produced.",
    symbol,
    tradeDate,
    timeframe,
    bars: aggregated.length,
    frames: frames.slice(-120),
    metrics,
    zonesSample: lastZones.slice(0, 12),
    unavailable,
    lookAheadGuard: "Zone/structure engines only received candles with ts <= replay step; future data was used solely to measure outcomes.",
  };
}
