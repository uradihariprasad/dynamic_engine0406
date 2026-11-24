import { DEFAULT_WEIGHTS, type SymbolKey } from "@/lib/config";
import { atr, classifyStrength, clamp01, clampScore, round2 } from "@/lib/engine/indicators";
import type {
  Candle,
  Evidence,
  MarketStructure,
  SrLevelSelection,
  SrLevels,
  VolumeProfileResult,
  Zone,
  ZoneKind,
  ZoneSource,
  ZoneSourceKind,
  ZoneStatus,
  SessionLevels,
} from "@/lib/engine/types";
import type { ConsolidationRange } from "@/lib/engine/structure";

export interface OiClusterInput {
  strike: number;
  side: "CE" | "PE";
  oi: number;
  share: number;
  kind: string;
}

export interface QuoteDepthInput {
  available: boolean;
  bidQty: number | null;
  askQty: number | null;
  note: string;
}

export interface FuturesInput {
  available: boolean;
  classification: string | null;
  note: string;
}

export interface ZoneEngineInputs {
  symbol: SymbolKey;
  spot: number | null;
  candles: Candle[];
  higherTimeframeCandles: Candle[];
  timeframe: string;
  htfTimeframe: string;
  structure: MarketStructure;
  consolidations: ConsolidationRange[];
  sessionLevels: SessionLevels;
  volumeProfile: VolumeProfileResult;
  oiClusters: OiClusterInput[];
  quotes: QuoteDepthInput;
  futures: FuturesInput;
  tickSize: number;
  now: number;
  /** Persisted score history keyed by deterministic zone id. */
  scoreHistory?: Record<string, Array<{ t: number; score: number }>>;
}

/* ------------------------------------------------------------------ *
 * 1. Candidate extraction
 * ------------------------------------------------------------------ */

function rejectionCandidates(candles: Candle[], a: number, timeframe: string, limit: number): ZoneSource[] {
  const out: ZoneSource[] = [];
  const use = candles.filter((c) => c.complete);
  for (let i = Math.max(1, use.length - 60); i < use.length; i += 1) {
    const c = use[i];
    const range = c.high - c.low;
    if (range <= 0) continue;
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);
    const next = use[i + 1];
    const followThroughDown = next ? next.close < c.close : false;
    const followThroughUp = next ? next.close > c.close : false;

    if (lowerWick >= range * 0.55 && lowerWick >= a * 0.3) {
      out.push({
        kind: "WICK_REJECTION_LOW",
        price: round2(c.low + lowerWick * 0.25),
        timeframe,
        ts: c.ts,
        weight: followThroughUp ? 0.34 : 0.24,
        note: `Lower wick rejection ${(lowerWick / range * 100).toFixed(0)}% of candle range${followThroughUp ? " with upward follow-through" : ""}`,
      });
    }
    if (upperWick >= range * 0.55 && upperWick >= a * 0.3) {
      out.push({
        kind: "WICK_REJECTION_HIGH",
        price: round2(c.high - upperWick * 0.25),
        timeframe,
        ts: c.ts,
        weight: followThroughDown ? 0.34 : 0.24,
        note: `Upper wick rejection ${(upperWick / range * 100).toFixed(0)}% of candle range${followThroughDown ? " with downward follow-through" : ""}`,
      });
    }
    // Body rejection: long-range candle closing near an extreme after an expansion move
    if (range >= a * 1.6) {
      const bodyTop = Math.max(c.open, c.close);
      const bodyBottom = Math.min(c.open, c.close);
      const body = bodyTop - bodyBottom;
      if (body / range < 0.35) {
        out.push({
          kind: c.close > c.open ? "BODY_REJECTION" : "BODY_REJECTION",
          price: round2(c.close > c.open ? c.low : c.high),
          timeframe,
          ts: c.ts,
          weight: 0.2,
          note: "Expansion candle with small body closing at an extreme (acceptance/rejection signal)",
        });
      }
    }
  }
  return out.slice(-limit);
}

export function extractCandidates(inputs: ZoneEngineInputs): ZoneSource[] {
  const { candles, structure, consolidations, sessionLevels, volumeProfile, timeframe, htfTimeframe } = inputs;
  const use = candles.filter((c) => c.complete);
  const a = atr(use, 14) ?? (use.length > 1 ? (use[use.length - 1].high - use[use.length - 1].low) : 0);
  const sources: ZoneSource[] = [];

  for (const p of structure.swingLows.slice(-6)) {
    sources.push({
      kind: "SWING_LOW",
      price: p.price,
      timeframe,
      ts: p.ts,
      weight: 0.42,
      note: `Confirmed swing low (fractal) from ${timeframe}`,
    });
  }
  for (const p of structure.swingHighs.slice(-6)) {
    sources.push({
      kind: "SWING_HIGH",
      price: p.price,
      timeframe,
      ts: p.ts,
      weight: 0.42,
      note: `Confirmed swing high (fractal) from ${timeframe}`,
    });
  }

  // Higher timeframe pivots add confluence
  const htfPivotLows = structure.htfTrend !== "UNCLEAR" ? htfSwingsFrom(inputs.higherTimeframeCandles, "LOW") : [];
  const htfPivotHighs = structure.htfTrend !== "UNCLEAR" ? htfSwingsFrom(inputs.higherTimeframeCandles, "HIGH") : [];
  for (const p of htfPivotLows.slice(-4)) {
    sources.push({
      kind: "SWING_LOW",
      price: p.price,
      timeframe: htfTimeframe,
      ts: p.ts,
      weight: 0.5,
      note: `Higher-timeframe (${htfTimeframe}) confirmed swing low`,
    });
  }
  for (const p of htfPivotHighs.slice(-4)) {
    sources.push({
      kind: "SWING_HIGH",
      price: p.price,
      timeframe: htfTimeframe,
      ts: p.ts,
      weight: 0.5,
      note: `Higher-timeframe (${htfTimeframe}) confirmed swing high`,
    });
  }

  sources.push(...rejectionCandidates(candles, a, timeframe, 40));

  for (const r of consolidations.slice(-3)) {
    sources.push({
      kind: "CONSOLIDATION_BOUNDARY",
      price: r.low,
      timeframe: r.timeframe,
      ts: r.endTs,
      weight: 0.3 + Math.min(0.2, r.acceptanceLow * 0.03),
      note: `Consolidation low accepted ${r.acceptanceLow}x in ${r.candles} candles (${r.timeframe})`,
    });
    sources.push({
      kind: "CONSOLIDATION_BOUNDARY",
      price: r.high,
      timeframe: r.timeframe,
      ts: r.endTs,
      weight: 0.3 + Math.min(0.2, r.acceptanceHigh * 0.03),
      note: `Consolidation high accepted ${r.acceptanceHigh}x in ${r.candles} candles (${r.timeframe})`,
    });
  }

  for (const e of structure.events) {
    if (e.type === "FAILED_BREAKOUT") {
      sources.push({ kind: "FAILED_BREAKOUT", price: e.level, timeframe, ts: e.ts, weight: 0.4, note: e.detail });
    }
    if (e.type === "FAILED_BREAKDOWN") {
      sources.push({ kind: "FAILED_BREAKDOWN", price: e.level, timeframe, ts: e.ts, weight: 0.4, note: e.detail });
    }
  }

  if (sessionLevels.prevDayHigh !== null) {
    sources.push({ kind: "PRIOR_SESSION_HIGH", price: sessionLevels.prevDayHigh, timeframe: "1d", ts: inputs.now, weight: 0.3, note: "Previous day high" });
  }
  if (sessionLevels.prevDayLow !== null) {
    sources.push({ kind: "PRIOR_SESSION_LOW", price: sessionLevels.prevDayLow, timeframe: "1d", ts: inputs.now, weight: 0.3, note: "Previous day low" });
  }
  if (sessionLevels.prevClose !== null) {
    sources.push({ kind: "PRIOR_CLOSE", price: sessionLevels.prevClose, timeframe: "1d", ts: inputs.now, weight: 0.2, note: "Previous day close" });
  }
  if (sessionLevels.openingRangeHigh !== null) {
    sources.push({ kind: "OPENING_RANGE_HIGH", price: sessionLevels.openingRangeHigh, timeframe, ts: inputs.now, weight: 0.18, note: "Opening range high" });
  }
  if (sessionLevels.openingRangeLow !== null) {
    sources.push({ kind: "OPENING_RANGE_LOW", price: sessionLevels.openingRangeLow, timeframe, ts: inputs.now, weight: 0.18, note: "Opening range low" });
  }

  if (volumeProfile.status !== "UNAVAILABLE" && volumeProfile.status !== "INVALID") {
    for (const node of [...volumeProfile.hvn.slice(0, 2)]) {
      sources.push({
        kind: "VOLUME_NODE",
        price: node,
        timeframe,
        ts: inputs.now,
        weight: 0.22,
        note: `High-volume node (ESTIMATED profile, POC ${volumeProfile.poc ?? "n/a"})`,
      });
    }
    if (volumeProfile.poc !== null) {
      sources.push({
        kind: "VOLUME_NODE",
        price: volumeProfile.poc,
        timeframe,
        ts: inputs.now,
        weight: 0.26,
        note: "Point of control (ESTIMATED profile)",
      });
    }
  }

  for (const c of inputs.oiClusters) {
    sources.push({
      kind: "OI_CLUSTER",
      price: c.strike,
      timeframe: "options",
      ts: inputs.now,
      weight: 0.12 + Math.min(0.16, c.share * 0.8),
      note: `${c.side} OI cluster (${c.kind}, ${(c.share * 100).toFixed(1)}% of chain OI)`,
    });
  }

  return sources;
}

function htfSwingsFrom(candles: Candle[], type: "HIGH" | "LOW"): Array<{ ts: number; price: number }> {
  const use = candles.filter((c) => c.complete);
  if (use.length < 10) return [];
  const out: Array<{ ts: number; price: number }> = [];
  for (let i = 2; i < use.length - 2; i += 1) {
    const c = use[i];
    if (type === "HIGH" && c.high > use[i - 1].high && c.high > use[i - 2].high && c.high > use[i + 1].high && c.high >= use[i + 2].high) {
      out.push({ ts: c.ts, price: round2(c.high) });
    }
    if (type === "LOW" && c.low < use[i - 1].low && c.low < use[i - 2].low && c.low < use[i + 1].low && c.low <= use[i + 2].low) {
      out.push({ ts: c.ts, price: round2(c.low) });
    }
  }
  return out.slice(-6);
}

/* ------------------------------------------------------------------ *
 * 2. Dynamic zone formation
 * ------------------------------------------------------------------ */

interface Cluster {
  kind: ZoneKind;
  members: ZoneSource[];
  center: number;
  dispersion: number;
}

function kindForSource(kind: ZoneSourceKind): ZoneKind {
  const resistanceKinds: ZoneSourceKind[] = [
    "SWING_HIGH",
    "WICK_REJECTION_HIGH",
    "PRIOR_SESSION_HIGH",
    "OPENING_RANGE_HIGH",
    "SESSION_HIGH",
  ];
  if (kind === "OI_CLUSTER") return "resistance"; // resolved later by price context
  if (kind === "CONSOLIDATION_BOUNDARY" || kind === "PRIOR_CLOSE" || kind === "VOLUME_NODE") {
    return "support"; // resolved later by price context
  }
  return resistanceKinds.includes(kind) ? "resistance" : "support";
}

/** Cluster compatible price reactions. Width derives from ATR, local volatility, reaction dispersion and tick size. */
export function buildClusters(sources: ZoneSource[], inputs: ZoneEngineInputs): Cluster[] {
  const use = inputs.candles.filter((c) => c.complete);
  const a = atr(use, 14);
  const sorted = [...sources].sort((x, y) => x.price - y.price);
  const clusters: Cluster[] = [];
  const baseTol = a !== null ? a * 0.42 : 0;
  const tickTol = inputs.tickSize * 6;
  const pctTol = inputs.spot !== null ? inputs.spot * 0.0002 : 0;

  for (const src of sorted) {
    const last = clusters[clusters.length - 1];
    const tol = Math.max(baseTol, tickTol, pctTol, 0);
    if (last && src.price - last.center <= tol) {
      last.members.push(src);
      const prices = last.members.map((m) => m.price);
      last.center = prices.reduce((x, y) => x + y, 0) / prices.length;
      last.dispersion = Math.sqrt(prices.reduce((x, y) => x + (y - last.center) ** 2, 0) / prices.length);
    } else {
      clusters.push({ kind: kindForSource(src.kind), members: [src], center: src.price, dispersion: 0 });
    }
  }

  // Resolve kind by price context relative to current spot (never by assumption).
  if (inputs.spot !== null) {
    for (const c of clusters) {
      if (c.center < inputs.spot) c.kind = "support";
      else if (c.center > inputs.spot) c.kind = "resistance";
    }
  }
  // Remove single-source, low-weight clusters that carry no structural meaning.
  // OI clusters are kept so their provenance stays visible (they are flagged oiOnly
  // and never merged with structural evidence).
  return clusters.filter((c) => c.members.length > 1 || c.members[0].weight >= 0.3 || c.members[0].kind === "OI_CLUSTER");
}

/* ------------------------------------------------------------------ *
 * 3. Zone scoring (evidence-weighted, missing data never becomes positive evidence)
 * ------------------------------------------------------------------ */

interface TestStats {
  tests: number;
  defended: number;
  rejected: number;
  followThrough: number;
  avgWickRatio: number;
  lastTestTs: number | null;
  acceptedOutside: number;
}

function evaluateTests(zone: { kind: ZoneKind; lower: number; upper: number }, use: Candle[], a: number | null): TestStats {
  const stats: TestStats = {
    tests: 0,
    defended: 0,
    rejected: 0,
    followThrough: 0,
    avgWickRatio: 0,
    lastTestTs: null,
    acceptedOutside: 0,
  };
  let wickSum = 0;
  for (let i = 0; i < use.length; i += 1) {
    const c = use[i];
    const touched = zone.kind === "support" ? c.low <= zone.upper && c.high >= zone.lower : c.high >= zone.lower && c.low <= zone.upper;
    if (!touched) continue;
    const range = c.high - c.low;
    stats.tests += 1;
    stats.lastTestTs = c.ts;
    if (range > 0) {
      const wickRatio = zone.kind === "support" ? (Math.min(c.open, c.close) - c.low) / range : (c.high - Math.max(c.open, c.close)) / range;
      wickSum += wickRatio;
    }
    if (zone.kind === "support") {
      const defended = c.close > zone.lower;
      if (defended) stats.defended += 1;
      if (range > 0 && (Math.min(c.open, c.close) - c.low) / range >= 0.45) stats.rejected += 1;
      const next = use[i + 1];
      if (next && next.close > c.close && c.close > zone.lower) stats.followThrough += 1;
      if (c.close < zone.lower) stats.acceptedOutside += 1;
    } else {
      const defended = c.close < zone.upper;
      if (defended) stats.defended += 1;
      if (range > 0 && (c.high - Math.max(c.open, c.close)) / range >= 0.45) stats.rejected += 1;
      const next = use[i + 1];
      if (next && next.close < c.close && c.close < zone.upper) stats.followThrough += 1;
      if (c.close > zone.upper) stats.acceptedOutside += 1;
    }
  }
  stats.avgWickRatio = stats.tests > 0 ? wickSum / stats.tests : 0;
  void a;
  return stats;
}

function structuralValue(members: ZoneSource[], htfConfluence: boolean): number {
  let v = 0.18;
  const kinds = new Set(members.map((m) => m.kind));
  if (kinds.has("SWING_LOW") || kinds.has("SWING_HIGH")) v += 0.26;
  if (kinds.has("FAILED_BREAKOUT") || kinds.has("FAILED_BREAKDOWN")) v += 0.22;
  if (kinds.has("CONSOLIDATION_BOUNDARY")) v += 0.16;
  if (kinds.has("PRIOR_SESSION_HIGH") || kinds.has("PRIOR_SESSION_LOW")) v += 0.14;
  if (kinds.has("OPENING_RANGE_HIGH") || kinds.has("OPENING_RANGE_LOW")) v += 0.08;
  if (kinds.has("PRIOR_CLOSE")) v += 0.08;
  if (kinds.has("BREAKOUT_LEVEL") || kinds.has("BREAKDOWN_LEVEL")) v += 0.12;
  if (members.length >= 3) v += 0.1;
  if (members.length >= 5) v += 0.06;
  if (htfConfluence) v += 0.12;
  return clamp01(v);
}

function buildEvidence(args: {
  zone: { kind: ZoneKind; lower: number; upper: number; center: number; sources: ZoneSource[] };
  tests: TestStats;
  inputs: ZoneEngineInputs;
  htfConfluence: boolean;
  volumeAligned: number | null;
  oiAligned: number | null;
  futuresAligned: number | null;
  quoteAligned: number | null;
  sessionValue: number;
  contradictions: string[];
}): Evidence {
  const w = DEFAULT_WEIGHTS.zone;
  const components: Record<string, number | null> = {
    priceStructure: structuralValue(args.zone.sources, args.htfConfluence),
    reaction:
      args.tests.tests === 0
        ? 0.35
        : clamp01(
            0.3 +
              (args.tests.defended / args.tests.tests) * 0.35 +
              (args.tests.avgWickRatio || 0) * 0.2 +
              (args.tests.tests > 1 ? 0.1 : 0) +
              (args.tests.tests > 2 ? 0.05 : 0),
          ),
    volumeProfile: args.volumeAligned,
    oiConfluence: args.oiAligned,
    futures: args.futuresAligned,
    quotes: args.quoteAligned,
    liquiditySession: args.sessionValue,
  };

  const available: string[] = [];
  const missing: string[] = [];
  const weights: Record<string, number> = {
    priceStructure: w.priceStructure,
    reaction: w.reaction,
    volumeProfile: w.volumeProfile,
    oiConfluence: w.oiConfluence,
    futures: w.futures,
    quotes: w.quotes,
    liquiditySession: w.liquiditySession,
  };
  for (const [k, weight] of Object.entries(weights)) {
    if (components[k] === null) missing.push(k);
    else available.push(k);
  }
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const availableWeight = Object.entries(weights)
    .filter(([k]) => components[k] !== null)
    .reduce((a, [, b]) => a + b, 0);

  return {
    available,
    missing,
    contradictory: args.contradictions,
    coverage: availableWeight / totalWeight,
    components,
    sourceReliability:
      args.zone.sources.length === 0
        ? 0
        : clamp01(args.zone.sources.reduce((acc, s) => acc + s.weight, 0) / (args.zone.sources.length * 0.5)),
  };
}

export function scoreZones(clusters: Cluster[], inputs: ZoneEngineInputs): Zone[] {
  const use = inputs.candles.filter((c) => c.complete);
  const a = atr(use, 14);
  const zones: Zone[] = [];

  for (const cluster of clusters) {
    const kind = cluster.kind;
    const prices = cluster.members.map((m) => m.price);
    const dispersion = cluster.dispersion;
    const minW = Math.max(a !== null ? a * 0.18 : 0, inputs.tickSize * 2, inputs.spot ? inputs.spot * 0.0006 : 0);
    const width = Math.max(minW, dispersion * 2.2);
    const center = round2(cluster.center);
    const lower = round2(center - width / 2);
    const upper = round2(center + width / 2);
    const zone = { kind, lower, upper, center, width, sources: cluster.members };

    const tests = evaluateTests(zone, use, a);
    const htfConfluence = cluster.members.some((m) => m.timeframe !== inputs.timeframe && m.timeframe !== "options");

    const volumeAligned = (() => {
      const vp = inputs.volumeProfile;
      if (vp.status === "UNAVAILABLE" || vp.status === "INVALID") return null;
      const candidates = [vp.poc, ...vp.hvn];
      if (candidates.some((p) => p !== null && p >= lower && p <= upper)) return 0.85;
      if (candidates.some((p) => p !== null && p > lower - (a ?? 0) * 0.3 && p < upper + (a ?? 0) * 0.3)) return 0.5;
      if (vp.lvn.some((p) => p >= lower && p <= upper)) return 0.15;
      return 0.3;
    })();

    const oiAligned = (() => {
      const clustersNear = inputs.oiClusters.filter((c) => c.strike >= lower && c.strike <= upper);
      if (clustersNear.length === 0) return null;
      const share = Math.max(...clustersNear.map((c) => c.share));
      return clamp01(0.35 + share * 3);
    })();

    const futuresAligned = (() => {
      if (!inputs.futures.available || inputs.futures.classification === null) return null;
      const bullishFut = inputs.futures.classification === "LONG_BUILDUP" || inputs.futures.classification === "SHORT_COVERING";
      const bearishFut = inputs.futures.classification === "SHORT_BUILDUP" || inputs.futures.classification === "LONG_UNWINDING";
      if (kind === "support") return bullishFut ? 0.85 : bearishFut ? 0.25 : 0.45;
      return bearishFut ? 0.85 : bullishFut ? 0.25 : 0.45;
    })();

    const quoteAligned = (() => {
      if (!inputs.quotes.available) return null;
      const bid = inputs.quotes.bidQty ?? 0;
      const ask = inputs.quotes.askQty ?? 0;
      if (bid + ask === 0) return null;
      const imbalance = bid / (bid + ask);
      return kind === "support" ? clamp01(imbalance) : clamp01(1 - imbalance);
    })();

    const sessionValue = (() => {
      if (use.length === 0) return 0;
      const ageHours = (inputs.now - cluster.members[0].ts) / 3600000;
      const volOk = a !== null && zone.width <= a * 2.5;
      const testedRecently = tests.lastTestTs !== null && inputs.now - tests.lastTestTs < 4 * 3600000;
      let v = 0.4;
      if (ageHours < 6) v += 0.2;
      if (testedRecently) v += 0.2;
      if (volOk) v += 0.2;
      return clamp01(v);
    })();

    const contradictions: string[] = [];
    if (tests.acceptedOutside > 0 && tests.defended > 0) {
      contradictions.push(
        `Price closed outside the zone ${tests.acceptedOutside}x yet defended it ${tests.defended}x — mixed acceptance behaviour.`,
      );
    }
    if (oiAligned !== null && volumeAligned !== null && oiAligned > 0.6 && volumeAligned < 0.25) {
      contradictions.push("Options OI confluence is high while traded-volume confluence is weak — treat OI-only zones cautiously.");
    }
    if (futuresAligned !== null && futuresAligned < 0.3) {
      contradictions.push("Futures positioning contradicts the zone direction.");
    }

    const evidence = buildEvidence({
      zone,
      tests,
      inputs,
      htfConfluence,
      volumeAligned,
      oiAligned,
      futuresAligned,
      quoteAligned,
      sessionValue,
      contradictions,
    });

    const w = DEFAULT_WEIGHTS.zone;
    const raw =
      w.priceStructure * (evidence.components.priceStructure ?? 0) +
      w.reaction * (evidence.components.reaction ?? 0) +
      w.volumeProfile * (evidence.components.volumeProfile ?? 0) +
      w.oiConfluence * (evidence.components.oiConfluence ?? 0) +
      w.futures * (evidence.components.futures ?? 0) +
      w.quotes * (evidence.components.quotes ?? 0) +
      w.liquiditySession * (evidence.components.liquiditySession ?? 0);
    const score = clampScore(raw);

    const history = inputs.scoreHistory?.[zoneIdFor(inputs.symbol, kind, center)] ?? [];
    const scoreHistory = [...history, { t: inputs.now, score }].slice(-80);
    const prev = history.length > 0 ? history[history.length - 1].score : null;
    const delta5 = deltaAt(scoreHistory, inputs.now - 5 * 60000);
    const delta15 = deltaAt(scoreHistory, inputs.now - 15 * 60000);

    const statusInfo = computeStatus({
      kind,
      lower,
      upper,
      center,
      spot: inputs.spot,
      tests,
      score,
      prevScore: prev,
      delta5,
      candles: use,
      atrValue: a,
      now: inputs.now,
    });

    // Zones that sit on the wrong side of spot without any defending evidence of
    // their own kind are role-reversal candidates — tracked separately, never
    // presented as confirmed Immediate/Primary levels.
    const directionalSourceOk =
      kind === "support"
        ? cluster.members.some((m) => SUPPORT_DEFENSIVE.includes(m.kind))
        : cluster.members.some((m) => RESISTANCE_OFFENSIVE.includes(m.kind));
    const finalStatus: ZoneStatus = directionalSourceOk
      ? statusInfo.status
      : statusInfo.status === "BROKEN" || statusInfo.status === "INVALIDATED"
        ? statusInfo.status
        : "ROLE_REVERSAL_CANDIDATE";
    const finalReason = directionalSourceOk
      ? statusInfo.reason
      : `Zone is derived from ${
          kind === "support" ? "resistance-side" : "support-side"
        } evidence only (no ${kind === "support" ? "defensive" : "capping"} reaction yet) — role-reversal candidate, excluded from Immediate/Primary selection until a ${kind === "support" ? "defence" : "rejection"} is confirmed.`;

    zones.push({
      id: zoneIdFor(inputs.symbol, kind, center),
      symbol: inputs.symbol,
      kind,
      lower,
      upper,
      center,
      width: round2(width),
      widthPct: inputs.spot ? round2((width / inputs.spot) * 100) : 0,
      score,
      prevScore: prev,
      scoreChange5m: delta5,
      scoreChange15m: delta15,
      classification: classifyStrength(score),
      status: finalStatus,
      statusReason: finalReason,
      tests: tests.tests,
      createdAt: cluster.members.reduce((min, m) => Math.min(min, m.ts), cluster.members[0].ts),
      lastTestedAt: tests.lastTestTs,
      sources: cluster.members,
      evidence,
      timeframeConfluence: Array.from(new Set(cluster.members.map((m) => m.timeframe))),
      oiOnly: cluster.members.every((m) => m.kind === "OI_CLUSTER"),
      scoreHistory,
    });
  }

  return zones;
}

function deltaAt(history: Array<{ t: number; score: number }>, target: number): number | null {
  if (history.length === 0) return null;
  let best: { t: number; score: number } | null = null;
  let bestDelta = Infinity;
  for (const point of history) {
    const d = Math.abs(point.t - target);
    if (d < bestDelta) {
      bestDelta = d;
      best = point;
    }
  }
  if (!best || bestDelta > 4 * 60000) return null;
  const current = history[history.length - 1];
  return round2(current.score - best.score);
}

export function zoneIdFor(symbol: string, kind: ZoneKind, center: number): string {
  return `${symbol}:${kind}:${center.toFixed(2)}`;
}

/* ------------------------------------------------------------------ *
 * 4. Zone lifecycle status (independent of strength score)
 * ------------------------------------------------------------------ */

function computeStatus(args: {
  kind: ZoneKind;
  lower: number;
  upper: number;
  center: number;
  spot: number | null;
  tests: TestStats;
  score: number;
  prevScore: number | null;
  delta5: number | null;
  candles: Candle[];
  atrValue: number | null;
  now: number;
}): { status: ZoneStatus; reason: string } {
  const { kind, lower, upper, spot, tests, score, prevScore, delta5, candles, atrValue: a } = args;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (!last || spot === null) return { status: "CANDIDATE", reason: "No actionable price context available." };

  const threshold = Math.max(a !== null ? a * 0.25 : 0, (upper - lower) * 0.5);
  const breach = kind === "support" ? last.close < lower - threshold : last.close > upper + threshold;
  const twoClosesBeyond =
    breach &&
    prev !== undefined &&
    (kind === "support" ? prev.close < lower - threshold : prev.close > upper + threshold);

  if (breach && twoClosesBeyond) {
    return {
      status: kind === "support" ? "INVALIDATED" : "INVALIDATED",
      reason: `Two consecutive closes beyond the zone (last close ${last.close}) — structural role lost.`,
    };
  }
  if (breach) {
    return { status: "BROKEN", reason: `Latest close beyond the zone; confirmation requires a second close.` };
  }
  if (kind === "resistance" && last.close >= lower && last.close < upper + (a ?? 0) * 0.2 && (prev?.close ?? 0) <= last.close) {
    return { status: "BREAKOUT_RISK", reason: "Price is pressing into the resistance zone with rising closes." };
  }
  if (kind === "support" && last.close <= upper && last.close > lower - (a ?? 0) * 0.2 && (prev?.close ?? 0) >= last.close) {
    return { status: "BREAKDOWN_RISK", reason: "Price is pressing down onto the support zone with falling closes." };
  }

  const rejectionQuality = tests.tests > 0 ? tests.defended / tests.tests : 0;
  const deltaPositive = delta5 !== null && delta5 > 2;
  const deltaNegative = delta5 !== null && delta5 < -2;

  if (deltaPositive) return { status: "STRENGTHENING", reason: `Strength score improving (+${delta5}) and rejection quality ${(rejectionQuality * 100).toFixed(0)}%.` };
  if (deltaNegative) return { status: "WEAKENING", reason: `Strength score declining (${delta5}); last ${tests.defended}/${tests.tests} tests defended.` };

  if (tests.tests >= 3 && rejectionQuality >= 0.6 && score >= 55) {
    return { status: "STRENGTHENING", reason: `Repeatedly defended (${tests.defended}/${tests.tests}) with improving confluence.` };
  }
  if (tests.tests >= 3 && rejectionQuality < 0.45) {
    return { status: "WEAKENING", reason: `Multiple tests with poor rejection quality (${(rejectionQuality * 100).toFixed(0)}%).` };
  }
  if (score >= 55) return { status: "ACTIVE", reason: "Structurally valid zone inside the active session." };
  if (tests.tests === 0) return { status: "CANDIDATE", reason: "Forming zone with no tests yet." };
  return { status: "VALIDATED", reason: "Zone validated by price but awaiting stronger confluence." };
}

/* ------------------------------------------------------------------ *
 * 5. Four mandatory levels
 * ------------------------------------------------------------------ */

const INACTIVE_STATUSES: ZoneStatus[] = ["INVALIDATED", "EXPIRED", "ROLE_REVERSAL_CANDIDATE"];

/** Source kinds that genuinely defend a downside level (used to flag role-reversal-only zones). */
const SUPPORT_DEFENSIVE: ZoneSourceKind[] = [
  "SWING_LOW",
  "WICK_REJECTION_LOW",
  "CONSOLIDATION_BOUNDARY",
  "PRIOR_SESSION_LOW",
  "OPENING_RANGE_LOW",
  "FAILED_BREAKDOWN",
  "SESSION_LOW",
  "BREAKDOWN_LEVEL",
];

/** Source kinds that genuinely cap an upside level. */
const RESISTANCE_OFFENSIVE: ZoneSourceKind[] = [
  "SWING_HIGH",
  "WICK_REJECTION_HIGH",
  "CONSOLIDATION_BOUNDARY",
  "PRIOR_SESSION_HIGH",
  "OPENING_RANGE_HIGH",
  "FAILED_BREAKOUT",
  "SESSION_HIGH",
  "BREAKOUT_LEVEL",
];

export function selectLevels(zones: Zone[], spot: number | null): SrLevels {
  const unavailable: string[] = [];
  if (spot === null) {
    unavailable.push("Spot price unavailable — Immediate/Primary levels cannot be selected relative to spot.");
    return { immediateSupport: null, primarySupport: null, immediateResistance: null, primaryResistance: null, unavailable };
  }

  const active = zones.filter((z) => !INACTIVE_STATUSES.includes(z.status) || z.status === "BROKEN");
  // A zone qualifies as "at or below spot" when its lower bound is at/below spot —
  // this also covers the case of price pressing INTO the zone (never hidden).
  const supports = active
    .filter((z) => z.kind === "support" && z.lower <= spot)
    .sort((a, b) => Math.max(0, spot - a.upper) - Math.max(0, spot - b.upper) || b.center - a.center);
  const resistances = active
    .filter((z) => z.kind === "resistance" && z.upper >= spot)
    .sort((a, b) => Math.max(0, a.lower - spot) - Math.max(0, b.lower - spot) || b.center - a.center);

  const immediateSupport = supports[0]
    ? ({
        role: "IMMEDIATE_SUPPORT",
        zone: supports[0],
        distanceFromSpot: round2(spot - supports[0].upper),
        reason: `Nearest active structural support at/below spot (upper bound ${supports[0].upper}${spot - supports[0].upper < 0 ? "; price is inside the zone" : ""}).`,
      } as SrLevelSelection)
    : null;
  if (!immediateSupport) unavailable.push("No valid active support zone below current spot.");

  const primarySupportCandidate = supports
    .filter((z) => !immediateSupport || z.id !== immediateSupport.zone.id)
    .sort((a, b) => b.score - a.score)[0];
  const primarySupport = primarySupportCandidate
    ? ({
        role: "PRIMARY_SUPPORT",
        zone: primarySupportCandidate,
        distanceFromSpot: round2(spot - primarySupportCandidate.upper),
        reason: `Highest-strength distinct support zone (score ${primarySupportCandidate.score}, ${primarySupportCandidate.classification}).`,
      } as SrLevelSelection)
    : null;
  if (!primarySupport) unavailable.push("No second distinct support zone available for Primary Support — not fabricated.");

  const immediateResistance = resistances[0]
    ? ({
        role: "IMMEDIATE_RESISTANCE",
        zone: resistances[0],
        distanceFromSpot: round2(resistances[0].lower - spot),
        reason: `Nearest active structural resistance above spot (lower bound ${resistances[0].lower}).`,
      } as SrLevelSelection)
    : null;
  if (!immediateResistance) unavailable.push("No valid active resistance zone above current spot.");

  const primaryResistanceCandidate = resistances
    .filter((z) => !immediateResistance || z.id !== immediateResistance.zone.id)
    .sort((a, b) => b.score - a.score)[0];
  const primaryResistance = primaryResistanceCandidate
    ? ({
        role: "PRIMARY_RESISTANCE",
        zone: primaryResistanceCandidate,
        distanceFromSpot: round2(primaryResistanceCandidate.lower - spot),
        reason: `Highest-strength distinct resistance zone (score ${primaryResistanceCandidate.score}, ${primaryResistanceCandidate.classification}).`,
      } as SrLevelSelection)
    : null;
  if (!primaryResistance) unavailable.push("No second distinct resistance zone available for Primary Resistance — not fabricated.");

  return { immediateSupport, primarySupport, immediateResistance, primaryResistance, unavailable };
}

export { evaluateTests };
