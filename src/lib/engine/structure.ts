import type { Candle, MarketStructure, Pivot, StructureEvent, TrendState } from "@/lib/engine/types";
import { atr, round2 } from "@/lib/engine/indicators";

export interface ConsolidationRange {
  startTs: number;
  endTs: number;
  high: number;
  low: number;
  acceptanceHigh: number;
  acceptanceLow: number;
  candles: number;
  timeframe: string;
  expansion: boolean;
  contraction: boolean;
}

interface StructureOptions {
  leftBars?: number;
  rightBars?: number;
}

/** Confirmed fractal pivots. Requires `rightBars` candles AFTER the pivot => no look-ahead bias. */
export function detectPivots(candles: Candle[], leftBars = 2, rightBars = 2): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = leftBars; i < candles.length - rightBars; i += 1) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= leftBars; k += 1) {
      if (candles[i - k].high >= c.high) isHigh = false;
      if (candles[i - k].low <= c.low) isLow = false;
    }
    for (let k = 1; k <= rightBars; k += 1) {
      // Right side is non-strict so that equal highs / equal lows (very common on
      // index tape) still confirm a pivot at the first occurrence.
      if (candles[i + k].high > c.high) isHigh = false;
      if (candles[i + k].low < c.low) isLow = false;
    }
    if (isHigh) pivots.push({ ts: c.ts, price: round2(c.high), type: "HIGH", index: i, confirmedBy: candles[i + rightBars].ts });
    if (isLow) pivots.push({ ts: c.ts, price: round2(c.low), type: "LOW", index: i, confirmedBy: candles[i + rightBars].ts });
  }
  return pivots;
}

function trendFromSwings(highs: Pivot[], lows: Pivot[]): { trend: TrendState; label: { high: "HH" | "LH" | "EQH"; low: "HL" | "LL" | "EQL"; rising: boolean | null } } {
  const h = highs.slice(-2);
  const l = lows.slice(-2);
  let highLabel: "HH" | "LH" | "EQH" = "EQH";
  let lowLabel: "HL" | "LL" | "EQL" = "EQL";
  let rising: boolean | null = null;
  if (h.length === 2) {
    const diff = h[1].price - h[0].price;
    const tol = Math.max(0.0005 * h[0].price, 0.0005 * h[1].price);
    highLabel = diff > tol ? "HH" : diff < -tol ? "LH" : "EQH";
  }
  if (l.length === 2) {
    const diff = l[1].price - l[0].price;
    const tol = Math.max(0.0005 * l[0].price, 0.0005 * l[1].price);
    lowLabel = diff > tol ? "HL" : diff < -tol ? "LL" : "EQL";
  }
  if (highLabel === "HH" && lowLabel === "HL") rising = true;
  else if (highLabel === "LH" && lowLabel === "LL") rising = false;
  const trend: TrendState = rising === true ? "BULLISH" : rising === false ? "BEARISH" : "SIDEWAYS";
  return { trend, label: { high: highLabel, low: lowLabel, rising } };
}

function detectConsolidations(candles: Candle[], a: number | null, timeframe: string): ConsolidationRange[] {
  const ranges: ConsolidationRange[] = [];
  if (candles.length < 12) return ranges;
  const windowSizes = [8, 12, 16];
  const seen = new Set<number>();
  for (const size of windowSizes) {
    for (let end = size; end <= candles.length; end += 1) {
      const slice = candles.slice(end - size, end);
      const high = Math.max(...slice.map((c) => c.high));
      const low = Math.min(...slice.map((c) => c.low));
      const width = high - low;
      const tolerance = a === null ? width * 0.2 : a * 1.6;
      if (width > tolerance) continue;
      const closes = slice.map((c) => c.close);
      const acceptanceHigh = closes.filter((c) => c > low + width * 0.7).length;
      const acceptanceLow = closes.filter((c) => c < low + width * 0.3).length;
      const startTs = slice[0].ts;
      if (seen.has(startTs)) continue;
      seen.add(startTs);
      const half = Math.floor(size / 2);
      const firstHalfWidth = Math.max(...slice.slice(0, half).map((c) => c.high)) - Math.min(...slice.slice(0, half).map((c) => c.low));
      const secondHalfWidth = Math.max(...slice.slice(half).map((c) => c.high)) - Math.min(...slice.slice(half).map((c) => c.low));
      ranges.push({
        startTs,
        endTs: slice[slice.length - 1].ts,
        high: round2(high),
        low: round2(low),
        acceptanceHigh,
        acceptanceLow,
        candles: size,
        timeframe,
        expansion: secondHalfWidth > firstHalfWidth * 1.5,
        contraction: secondHalfWidth < firstHalfWidth * 0.6,
      });
    }
  }
  // Keep non-overlapping, most recent ranges (max 5).
  const unique = ranges.filter((r, i, arr) => arr.findIndex((x) => x.startTs === r.startTs && x.endTs === r.endTs) === i);
  return unique.slice(-5);
}

export function analyzeStructure(
  candles: Candle[],
  higherTimeframeCandles: Candle[],
  timeframe: string,
  htfTimeframe: string,
  opts: StructureOptions = {},
): MarketStructure {
  const left = opts.leftBars ?? 2;
  const right = opts.rightBars ?? 2;
  const use = candles.filter((c) => c.complete);
  const a = atr(use, 14);

  if (use.length < left + right + 4) {
    return {
      status: "UNAVAILABLE",
      message: `Insufficient complete candles for structure analysis on ${timeframe} (need >= ${left + right + 4}).`,
      trend: "UNCLEAR",
      htfTrend: "UNCLEAR",
      ltfTrend: "UNCLEAR",
      swingHighs: [],
      swingLows: [],
      highs: { rising: null, label: "EQH" },
      lows: { rising: null, label: "EQL" },
      events: [],
      lastHigh: null,
      lastLow: null,
      rangeHigh: null,
      rangeLow: null,
      structureBiasScore: null,
      explanation: [],
    };
  }

  const pivots = detectPivots(use, left, right);
  const swingHighs = pivots.filter((p) => p.type === "HIGH");
  const swingLows = pivots.filter((p) => p.type === "LOW");
  const { trend, label } = trendFromSwings(swingHighs, swingLows);

  const htfUse = higherTimeframeCandles.filter((c) => c.complete);
  const htfPivots = htfUse.length >= left + right + 4 ? detectPivots(htfUse, left, right) : [];
  const htf = trendFromSwings(
    htfPivots.filter((p) => p.type === "HIGH"),
    htfPivots.filter((p) => p.type === "LOW"),
  );

  const events: StructureEvent[] = [];
  let lastBrokenHigh: Pivot | null = null;
  let lastBrokenLow: Pivot | null = null;
  let bias = 0; // +1 bullish, -1 bearish

  for (let i = 1; i < use.length; i += 1) {
    const c = use[i];
    const prev = use[i - 1];
    const tolerance = a === null ? 0 : a * 0.1;

    // Bullish break of structure
    const candidateHighs = swingHighs.filter((p) => p.index < i && p.confirmedBy <= c.ts);
    for (const p of candidateHighs.slice(-3)) {
      if (lastBrokenHigh && lastBrokenHigh.ts >= p.ts) continue;
      if (prev.close <= p.price && c.close > p.price + tolerance) {
        const bullish = bias >= 0;
        events.push({
          ts: c.ts,
          type: bullish ? "BOS" : "CHoCH",
          direction: "BULLISH",
          level: p.price,
          detail: `Close ${round2(c.close)} above confirmed swing high ${p.price} (${timeframe})`,
          confirmed: true,
        });
        bias = 1;
        lastBrokenHigh = p;
        break;
      }
    }
    // Bearish break of structure
    const candidateLows = swingLows.filter((p) => p.index < i && p.confirmedBy <= c.ts);
    for (const p of candidateLows.slice(-3)) {
      if (lastBrokenLow && lastBrokenLow.ts >= p.ts) continue;
      if (prev.close >= p.price && c.close < p.price - tolerance) {
        const bearish = bias <= 0;
        events.push({
          ts: c.ts,
          type: bearish ? "BOS" : "CHoCH",
          direction: "BEARISH",
          level: p.price,
          detail: `Close ${round2(c.close)} below confirmed swing low ${p.price} (${timeframe})`,
          confirmed: true,
        });
        bias = -1;
        lastBrokenLow = p;
        break;
      }
    }

    // Failed breakout / breakdown detection (acceptance reversal)
    if (lastBrokenHigh && c.close < lastBrokenHigh.price && prev.close > lastBrokenHigh.price) {
      events.push({
        ts: c.ts,
        type: "FAILED_BREAKOUT",
        direction: "BEARISH",
        level: lastBrokenHigh.price,
        detail: `Price closed back below broken high ${lastBrokenHigh.price}`,
        confirmed: false,
      });
    }
    if (lastBrokenLow && c.close > lastBrokenLow.price && prev.close < lastBrokenLow.price) {
      events.push({
        ts: c.ts,
        type: "FAILED_BREAKDOWN",
        direction: "BULLISH",
        level: lastBrokenLow.price,
        detail: `Price closed back above broken low ${lastBrokenLow.price}`,
        confirmed: false,
      });
    }
    // Retests of broken levels
    if (a !== null) {
      if (lastBrokenHigh && Math.abs(c.high - lastBrokenHigh.price) <= a * 0.25 && c.close < lastBrokenHigh.price) {
        events.push({
          ts: c.ts,
          type: "RETEST",
          direction: "BEARISH",
          level: lastBrokenHigh.price,
          detail: `Retest of broken high ${lastBrokenHigh.price} rejected`,
          confirmed: false,
        });
      }
      if (lastBrokenLow && Math.abs(c.low - lastBrokenLow.price) <= a * 0.25 && c.close > lastBrokenLow.price) {
        events.push({
          ts: c.ts,
          type: "RETEST",
          direction: "BULLISH",
          level: lastBrokenLow.price,
          detail: `Retest of broken low ${lastBrokenLow.price} held`,
          confirmed: false,
        });
      }
    }
  }

  const recent = events.slice(-6);
  const bullishEvents = recent.filter((e) => e.direction === "BULLISH").length;
  const bearishEvents = recent.filter((e) => e.direction === "BEARISH").length;
  let structureBiasScore: number | null = null;
  if (recent.length > 0) {
    structureBiasScore = 50 + ((bullishEvents - bearishEvents) / recent.length) * 30;
    structureBiasScore = Math.min(85, Math.max(15, round2(structureBiasScore)));
  }

  const sessionHigh = round2(Math.max(...use.map((c) => c.high)));
  const sessionLow = round2(Math.min(...use.map((c) => c.low)));

  const explanation: string[] = [];
  explanation.push(`Swing highs ${label.high} / swing lows ${label.low} on ${timeframe}.`);
  explanation.push(`Higher timeframe (${htfTimeframe}) structure: ${htf.trend}.`);
  if (label.rising === null) explanation.push("Swings are equal / inconclusive — structure not directional yet.");
  if (htf.trend !== "UNCLEAR" && htf.trend !== trend && trend !== "SIDEWAYS") {
    explanation.push("Lower timeframe structure conflicts with higher timeframe structure — treat direction as transitional.");
  }

  return {
    status: "LIVE",
    message: `Structure from ${use.length} complete ${timeframe} candles`,
    trend,
    htfTrend: htf.trend,
    ltfTrend: trend,
    swingHighs: swingHighs.slice(-8),
    swingLows: swingLows.slice(-8),
    highs: { rising: label.rising, label: label.high },
    lows: { rising: label.rising, label: label.low },
    events: recent,
    lastHigh: swingHighs.length ? swingHighs[swingHighs.length - 1].price : null,
    lastLow: swingLows.length ? swingLows[swingLows.length - 1].price : null,
    rangeHigh: sessionHigh,
    rangeLow: sessionLow,
    structureBiasScore,
    explanation,
  };
}

export { detectConsolidations };
