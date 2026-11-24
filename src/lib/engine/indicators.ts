import type { AtrInfo, Candle, VolumeProfileResult } from "@/lib/engine/types";
import type { RawCandleRow } from "@/lib/upstox/market";

/** Convert raw Upstox rows into analysis candles, flagging the (possibly incomplete) forming candle. */
export function toCandles(rows: RawCandleRow[], timeframeMinutes: number, now: number): Candle[] {
  const bucketMs = timeframeMinutes * 60000;
  const out: Candle[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const bucketEnd = r.ts + bucketMs;
    // The most recent bucket is treated as forming unless Upstox already delivered a
    // candle whose bucket is fully elapsed.
    const forming = i === rows.length - 1 && bucketEnd > now;
    out.push({
      ts: r.ts,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      volumeStatus: r.volumeStatus,
      complete: !forming,
      forming,
    });
  }
  return out;
}

export function completeCandles(candles: Candle[]): Candle[] {
  return candles.filter((c) => c.complete);
}

export function atr(candles: Candle[], period = 14): number | null {
  const use = candles.slice(-Math.max(period + 1, 2));
  if (use.length < 2) return null;
  let sum = 0;
  let count = 0;
  for (let i = 1; i < use.length; i += 1) {
    const prev = use[i - 1];
    const cur = use[i];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    sum += tr;
    count += 1;
  }
  if (count === 0) return null;
  return sum / count;
}

export function atrInfo(candles: Candle[], timeframe: string, period = 14): AtrInfo {
  const value = atr(candles, period);
  return {
    value,
    timeframe,
    period,
    status: value === null ? "UNAVAILABLE" : "LIVE",
  };
}

/** Session VWAP from candles. Only VALID when genuine traded volume exists. */
export function sessionVwap(candles: Candle[], sessionStartTs: number): { value: number | null; status: "VALID" | "ESTIMATED" | "UNAVAILABLE" } {
  const session = candles.filter((c) => c.ts >= sessionStartTs && c.complete);
  if (session.length === 0) return { value: null, status: "UNAVAILABLE" };
  const hasVolume = session.some((c) => c.volumeStatus === "VALID" && c.volume !== null && c.volume > 0);
  if (!hasVolume) return { value: null, status: "UNAVAILABLE" };
  let pv = 0;
  let v = 0;
  for (const c of session) {
    const typical = (c.high + c.low + c.close) / 3;
    const vol = c.volume ?? 0;
    pv += typical * vol;
    v += vol;
  }
  if (v <= 0) return { value: null, status: "UNAVAILABLE" };
  // Index spot has no traded volume of its own; when derived this way it is ESTIMATED.
  return { value: pv / v, status: "ESTIMATED" };
}

/* ------------------------------------------------------------------ *
 * Volume profile (OHLCV-derived, labelled ESTIMATED)
 * ------------------------------------------------------------------ */

export interface VolumeNode {
  price: number;
  volume: number;
}

export function volumeProfile(candles: Candle[], bucketCount = 24): VolumeProfileResult {
  const use = candles.filter((c) => c.complete);
  const validVolume = use.filter((c) => c.volumeStatus === "VALID" && c.volume !== null && c.volume > 0);
  const estimated = validVolume.length < use.length;
  if (validVolume.length < 5) {
    return {
      status: "UNAVAILABLE",
      message:
        "Traded volume unavailable for this instrument series — volume profile requires genuine traded volume (index spot has none).",
      estimated,
      poc: null,
      vah: null,
      val: null,
      developingPoc: null,
      hvn: [],
      lvn: [],
      valueAreaVolumePct: null,
      concentration: null,
      migration: null,
    };
  }
  const high = Math.max(...use.map((c) => c.high));
  const low = Math.min(...use.map((c) => c.low));
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) {
    return {
      status: "INVALID",
      message: "Invalid price range for volume profile computation.",
      estimated,
      poc: null,
      vah: null,
      val: null,
      developingPoc: null,
      hvn: [],
      lvn: [],
      valueAreaVolumePct: null,
      concentration: null,
      migration: null,
    };
  }
  const step = (high - low) / bucketCount;
  const bins = new Array<number>(bucketCount).fill(0);
  const developing = new Array<number>(bucketCount).fill(0);
  for (const c of validVolume) {
    const vol = c.volume ?? 0;
    const startBin = Math.min(bucketCount - 1, Math.max(0, Math.floor((c.low - low) / step)));
    const endBin = Math.min(bucketCount - 1, Math.max(0, Math.floor((c.high - low) / step)));
    const span = Math.max(1, endBin - startBin + 1);
    for (let b = startBin; b <= endBin; b += 1) bins[b] += vol / span;
  }
  const half = Math.floor(validVolume.length / 2);
  const early = validVolume.slice(0, half);
  for (const c of early) {
    const vol = c.volume ?? 0;
    const startBin = Math.min(bucketCount - 1, Math.max(0, Math.floor((c.low - low) / step)));
    const endBin = Math.min(bucketCount - 1, Math.max(0, Math.floor((c.high - low) / step)));
    const span = Math.max(1, endBin - startBin + 1);
    for (let b = startBin; b <= endBin; b += 1) developing[b] += vol / span;
  }

  const total = bins.reduce((a, b) => a + b, 0);
  let pocIdx = 0;
  for (let i = 1; i < bins.length; i += 1) if (bins[i] > bins[pocIdx]) pocIdx = i;
  let devIdx = 0;
  for (let i = 1; i < developing.length; i += 1) if (developing[i] > developing[devIdx]) devIdx = i;

  // 70% value area around POC
  const target = total * 0.7;
  let lo = pocIdx;
  let hi = pocIdx;
  let acc = bins[pocIdx];
  while (acc < target && (lo > 0 || hi < bins.length - 1)) {
    const nextLo = lo > 0 ? bins[lo - 1] : -1;
    const nextHi = hi < bins.length - 1 ? bins[hi + 1] : -1;
    if (nextHi >= nextLo) {
      hi += 1;
      acc += Math.max(0, nextHi);
    } else {
      lo -= 1;
      acc += Math.max(0, nextLo);
    }
  }

  const sorted = [...bins].sort((a, b) => b - a);
  const medianBin = sorted[Math.floor(sorted.length / 2)] || 1;
  const hvn: number[] = [];
  const lvn: number[] = [];
  for (let i = 0; i < bins.length; i += 1) {
    const price = low + step * (i + 0.5);
    if (bins[i] >= medianBin * 1.6) hvn.push(round2(price));
    else if (bins[i] <= medianBin * 0.4) lvn.push(round2(price));
  }

  const concentration = total > 0 ? (bins[pocIdx] / total) * 100 : null;
  let migration: "UP" | "DOWN" | "STABLE" | null = null;
  const pocPrice = low + step * (pocIdx + 0.5);
  const devPrice = low + step * (devIdx + 0.5);
  if (step > 0) {
    const delta = (devPrice - pocPrice) / step;
    migration = delta > 1 ? "UP" : delta < -1 ? "DOWN" : "STABLE";
  }

  return {
    status: estimated ? "PARTIAL" : "LIVE",
    message: estimated
      ? "OHLCV-derived volume distribution (ESTIMATED — not true footprint data)."
      : "Volume profile from traded volume.",
    estimated,
    poc: round2(pocPrice),
    vah: round2(low + step * (hi + 1)),
    val: round2(low + step * lo),
    developingPoc: round2(devPrice),
    hvn: hvn.slice(0, 6),
    lvn: lvn.slice(0, 6),
    valueAreaVolumePct: 70,
    concentration: concentration === null ? null : round2(concentration),
    migration,
  };
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

export function clampScore(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v * 10) / 10));
}

export function classifyStrength(score: number): "VERY_STRONG" | "STRONG" | "MODERATE" | "WEAK" | "VERY_WEAK" {
  if (score >= 85) return "VERY_STRONG";
  if (score >= 70) return "STRONG";
  if (score >= 55) return "MODERATE";
  if (score >= 40) return "WEAK";
  return "VERY_WEAK";
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
