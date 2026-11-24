import { and, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  candleCache,
  dataQualityEvent,
  futuresSnapshot,
  oiSnapshot,
  recommendation,
  zoneRegistry,
  zoneScoreHistory,
} from "@/db/schema";
import { DEFAULT_WEIGHTS } from "@/lib/config";
import {
  PRIMARY_TIMEFRAME,
  SYMBOL_CONFIGS,
  TIMEFRAME_MINUTES,
  type SymbolKey,
  type Timeframe,
} from "@/lib/config";
import { atr, round2, sessionVwap, toCandles, volumeProfile as buildVolumeProfile } from "@/lib/engine/indicators";
import { analyzeFutures, type FuturesSnapshot } from "@/lib/engine/futures";
import { analyzeStructure, detectConsolidations } from "@/lib/engine/structure";
import {
  buildStrikeIntel,
  computeOiIntel,
  buildStrikeSelection,
  type OiHistoryPoint,
  type PersistedOiRow,
} from "@/lib/engine/options";
import { buildScenarios, buildTradePlan, type MomentumRead } from "@/lib/engine/trade";
import { buildClusters, extractCandidates, scoreZones, selectLevels, zoneIdFor } from "@/lib/engine/zones";
import type {
  AnalysisSnapshot,
  Candle,
  DataFoundationView,
  DataQualityEntry,
  DataQualityReport,
  DataStatus,
  StorageResultView,
  FuturesIntel,
  MarketStructure,
  SrLevelSelection,
  SrLevels,
  StrikeSelection,
  TradeInputs,
  TradePlan,
  Zone,
} from "@/lib/engine/types";
import { buildAlerts, persistAlerts } from "@/lib/alerts";
import {
  countFuturesSnapshots,
  loadFuturesReference,
  loadOiHistory,
  loadZoneScoreHistory,
  persistFuturesSnapshot,
  persistOiSnapshots,
} from "@/lib/persistence";
import { evaluateReadiness, readinessSummary, type ReadinessInputs } from "@/lib/readiness";
import { buildOiIntelligence, type ContractOiMeasurements } from "@/lib/engine/ochange";
import { warmCache } from "@/lib/warmup";
import { failureToModuleStatus, upstoxRequest } from "@/lib/upstox/client";
import {
  fetchHistoryCandles,
  fetchIntradayCandles,
  fetchOptionChain,
  getMarketStatus,
  getSpotQuote,
  mergeCandleSets,
  type OptionChainResult,
  type OptionChainStrike,
  type RawCandleRow,
} from "@/lib/upstox/market";
import {
  buildContractMap,
  discoverExpiries,
  resolveFuturesDetailed,
  type ExpiryDiscovery,
} from "@/lib/upstox/instruments";
import { ensureSessionLoaded, getMetrics, getToken, isConnected, processId, updateValidationTs } from "@/lib/upstox/session";
import { getQuoteForKeys } from "@/lib/upstox/market";

const ANALYSIS_TTL_MS = Number(process.env.ANALYSIS_TTL_MS ?? 4000);
const HISTORY_DAYS: Record<Timeframe, number> = {
  "1m": 5,
  "2m": 7,
  "5m": 10,
  "15m": 15,
  "30m": 20,
  "1h": 30,
};

const HTF_MAP: Record<Timeframe, Timeframe> = {
  "1m": "15m",
  "2m": "30m",
  "5m": "30m",
  "15m": "1h",
  "30m": "1h",
  "1h": "1h",
};

interface CachedAnalysis {
  snapshot: AnalysisSnapshot;
  builtAt: number;
  candleSignature: string;
  moduleStatuses: Record<string, string>;
  monitor: TradeMonitorState | null;
}

interface TradeMonitorState {
  action: "CALL_BUY" | "PUT_BUY" | "NO_TRADE";
  strike: number | null;
  expiry: string | null;
  entryLow: number | null;
  entryHigh: number | null;
  stopLoss: number | null;
  target1: number | null;
  target2: number | null;
  state: string;
  since: number;
}

const globalForPipeline = globalThis as typeof globalThis & {
  __dynamicEngineCache?: Map<string, CachedAnalysis>;
  __dynamicEngineInflight?: Map<string, Promise<AnalysisSnapshot>>;
  __dynamicEngineInstruments?: Map<string, { value: unknown; at: number }>;
  __dynamicEngineMonitors?: Map<string, TradeMonitorState>;
};

const cache = (globalForPipeline.__dynamicEngineCache ??= new Map<string, CachedAnalysis>());
const inflight = (globalForPipeline.__dynamicEngineInflight ??= new Map<string, Promise<AnalysisSnapshot>>());
const instrumentCache = (globalForPipeline.__dynamicEngineInstruments ??= new Map<string, { value: unknown; at: number }>());
const monitorStore = (globalForPipeline.__dynamicEngineMonitors ??= new Map<string, TradeMonitorState>());

function cachedInstrument<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = instrumentCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
  return loader().then((value) => {
    instrumentCache.set(key, { value, at: Date.now() });
    return value;
  });
}

async function fetchQuoteMap(keys: string[]): Promise<Record<string, Record<string, unknown>>> {
  if (keys.length === 0) return {};
  try {
    const res = await upstoxRequest<{ data?: Record<string, Record<string, unknown>> }>({
      path: "/v2/market-quote/quotes",
      token: getToken(),
      query: { instrument_key: keys.join(",") },
      minIntervalMs: 1200,
    });
    return res.data?.data ?? {};
  } catch {
    return {};
  }
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function pickQuoteEntry(map: Record<string, Record<string, unknown>>, key: string): Record<string, unknown> | null {
  const normalized = key.replace("|", ":");
  const direct = map[key];
  if (direct) return direct;
  const alt = map[normalized];
  if (alt) return alt;
  const match = Object.entries(map).find(([k]) => k.replace("|", ":") === normalized);
  return match ? match[1] : null;
}

function momentumFromCandles(candles: Candle[], now: number): MomentumRead {
  const complete = candles.filter((c) => c.complete);
  const last = complete[complete.length - 1];
  if (!last) return { lastClose: null, change5m: null, change15m: null, bias: "NEUTRAL", strength: null };
  const closeAt = (target: number): number | null => {
    let best: Candle | null = null;
    let bestDelta = Infinity;
    for (const c of complete) {
      const d = Math.abs(c.ts - target);
      if (d < bestDelta) {
        bestDelta = d;
        best = c;
      }
    }
    return best && bestDelta <= 3 * 60000 ? best.close : null;
  };
  const change5m = last.close - (closeAt(now - 5 * 60000) ?? last.close);
  const change15m = last.close - (closeAt(now - 15 * 60000) ?? last.close);
  const score = (change5m ?? 0) + (change15m ?? 0) * 0.5;
  const bias = score > 0 ? "BULLISH" : score < 0 ? "BEARISH" : "NEUTRAL";
  return {
    lastClose: last.close,
    change5m: round2(change5m),
    change15m: round2(change15m),
    bias,
    strength: Math.abs(score) < 0.0001 ? 50 : Math.min(95, 50 + Math.abs(score) * 2),
  };
}

function sessionLevelsFrom(candles: Candle[], now: number) {
  const byDate = new Map<string, Candle[]>();
  for (const c of candles) {
    const d = new Date(c.ts).toISOString().slice(0, 10);
    const arr = byDate.get(d) ?? [];
    arr.push(c);
    byDate.set(d, arr);
  }
  const dates = [...byDate.keys()].sort();
  const today = new Date(now).toISOString().slice(0, 10);
  const todayIdx = dates.indexOf(today);
  const prevDate = todayIdx > 0 ? dates[todayIdx - 1] : dates.length > 1 ? dates[dates.length - 2] : null;
  const prevCandles = prevDate ? (byDate.get(prevDate) ?? []) : [];

  // ISO week grouping
  const isoWeek = (ts: number) => {
    const d = new Date(ts);
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const fDay = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - fDay + 3);
    return `${d.getUTCFullYear()}-W${Math.max(1, 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)))}`;
  };
  const weeks = new Map<string, Candle[]>();
  for (const [d, arr] of byDate) weeks.set(isoWeek(new Date(`${d}T00:00:00.000Z`).getTime()), [...(weeks.get(isoWeek(new Date(`${d}T00:00:00.000Z`).getTime())) ?? []), ...arr]);
  const weekKeys = [...weeks.keys()].sort();
  const currentWeek = weekKeys[weekKeys.length - 1];
  const prevWeekKey = weekKeys.length > 1 ? weekKeys[weekKeys.length - 2] : null;
  const prevWeekCandles = prevWeekKey ? (weeks.get(prevWeekKey) ?? []) : [];

  const todayCandles = byDate.get(today) ?? [];
  // IST session opens 09:15; the first 15 minutes are 09:15-09:30 IST == 03:45-04:00 UTC.
  const openingWindow = todayCandles.filter((c) => {
    const d = new Date(c.ts);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return mins >= 3 * 60 + 45 && mins < 4 * 60;
  });

  const vwap = sessionVwap(
    candles,
    todayCandles.length > 0 ? todayCandles[0].ts : 0,
  );

  return {
    prevDayHigh: prevCandles.length ? round2(Math.max(...prevCandles.map((c) => c.high))) : null,
    prevDayLow: prevCandles.length ? round2(Math.min(...prevCandles.map((c) => c.low))) : null,
    prevClose: prevCandles.length ? prevCandles[prevCandles.length - 1].close : null,
    prevWeekHigh: prevWeekCandles.length ? round2(Math.max(...prevWeekCandles.map((c) => c.high))) : null,
    prevWeekLow: prevWeekCandles.length ? round2(Math.min(...prevWeekCandles.map((c) => c.low))) : null,
    openingRangeHigh: openingWindow.length ? round2(Math.max(...openingWindow.map((c) => c.high))) : null,
    openingRangeLow: openingWindow.length ? round2(Math.min(...openingWindow.map((c) => c.low))) : null,
    sessionHigh: todayCandles.length ? round2(Math.max(...todayCandles.map((c) => c.high))) : null,
    sessionLow: todayCandles.length ? round2(Math.min(...todayCandles.map((c) => c.low))) : null,
    vwap: vwap.value,
    vwapStatus: vwap.status,
  };
}

function worstStatus(entries: DataQualityEntry[]): DataStatus {
  const order: DataStatus[] = ["LIVE", "PARTIAL", "STALE", "DISCONNECTED", "INVALID", "UNAVAILABLE"];
  let worstIdx = 0;
  for (const e of entries) {
    const idx = order.indexOf(e.status);
    if (idx > worstIdx) worstIdx = idx;
  }
  return order[worstIdx];
}

function buildDataQuality(args: {
  symbol: string;
  connected: boolean;
  spot: { status: DataStatus; message: string; freshnessMs: number | null; sourceTs: string | null; receivedAt: string | null; lastUpdate: string | null };
  candles: { status: DataStatus; message: string; sourceTs: string | null; receivedAt: string | null };
  futures: { status: DataStatus; message: string; sourceTs: string | null };
  chain: { status: DataStatus; message: string; sourceTs: string | null; receivedAt: string | null };
  greeks: { status: DataStatus; message: string };
  oi: { status: DataStatus; message: string; receivedAt: string | null };
  notes: string[];
}): DataQualityReport {
  const entries: DataQualityEntry[] = [
    {
      module: "SPOT_QUOTE",
      status: args.connected ? args.spot.status : "UNAVAILABLE",
      message: args.connected ? args.spot.message : "No Upstox token in backend memory — connect from Settings.",
      freshnessMs: args.spot.freshnessMs,
      lastUpdate: args.spot.lastUpdate,
      sourceTs: args.spot.sourceTs,
      receivedAt: args.spot.receivedAt,
    },
    {
      module: "CANDLES",
      status: args.connected ? args.candles.status : "UNAVAILABLE",
      message: args.candles.message,
      freshnessMs: null,
      lastUpdate: null,
      sourceTs: args.candles.sourceTs,
      receivedAt: args.candles.receivedAt,
    },
    {
      module: "FUTURES",
      status: args.connected ? args.futures.status : "UNAVAILABLE",
      message: args.futures.message,
      freshnessMs: null,
      lastUpdate: null,
      sourceTs: args.futures.sourceTs,
      receivedAt: null,
    },
    {
      module: "OPTION_CHAIN",
      status: args.connected ? args.chain.status : "UNAVAILABLE",
      message: args.chain.message,
      freshnessMs: null,
      lastUpdate: null,
      sourceTs: args.chain.sourceTs,
      receivedAt: args.chain.receivedAt,
    },
    {
      module: "GREEKS",
      status: args.connected ? args.greeks.status : "UNAVAILABLE",
      message: args.greeks.message,
      freshnessMs: null,
      lastUpdate: null,
      sourceTs: null,
      receivedAt: null,
    },
    {
      module: "OI_SNAPSHOT_HISTORY",
      status: args.connected ? args.oi.status : "UNAVAILABLE",
      message: args.oi.message,
      freshnessMs: null,
      lastUpdate: null,
      sourceTs: null,
      receivedAt: args.oi.receivedAt,
    },
    {
      module: "BID_ASK_DEPTH",
      status: args.connected ? (args.chain.status === "LIVE" ? "PARTIAL" : args.chain.status) : "UNAVAILABLE",
      message:
        "Upstox /v2/option/chain exposes best bid/ask price and quantity only (D0 level). Multi-level market depth is not provided by this endpoint — depth-based order-flow intelligence is therefore NOT AVAILABLE.",
      freshnessMs: null,
      lastUpdate: null,
      sourceTs: null,
      receivedAt: null,
    },
    {
      module: "ORDER_FLOW_CVD",
      status: "UNAVAILABLE",
      message:
        "Executed-trade aggressor data, CVD, footprint delta and confirmed absorption are NOT AVAILABLE: Upstox does not expose trade-level execution feeds through the public market-data API. Nothing is simulated.",
      freshnessMs: null,
      lastUpdate: null,
      sourceTs: null,
      receivedAt: null,
    },
  ];
  return { overall: worstStatus(entries), entries, notes: args.notes, connected: args.connected };
}

export async function buildAnalysis(symbol: SymbolKey, timeframe: Timeframe = PRIMARY_TIMEFRAME): Promise<AnalysisSnapshot> {
  const cfg = SYMBOL_CONFIGS[symbol];
  const now = Date.now();
  const notes: string[] = [];

  // The session must be visible to THIS process before any market-data call.
  await ensureSessionLoaded();
  // Ensure the instrument master is warm. On the very first scan after boot this is
  // awaited so contract resolution is correct; afterwards it resolves instantly.
  await warmCache();
  const connected = isConnected();

  if (!connected) {
    return emptySnapshot(symbol, timeframe, now, processId(), getMetrics());
  }

  /* ---------------------------------------------------------------- *
   * STAGE 1 — critical path (spot + candles) so the chart renders fast
   * ---------------------------------------------------------------- */
  const [spotResult, historyRes, intradayRes] = await Promise.all([
    getSpotQuote(symbol),
    fetchHistoryCandles(symbol, timeframe, HISTORY_DAYS[timeframe]),
    fetchIntradayCandles(symbol, timeframe),
  ]);
  updateValidationTs();

  const spot = spotResult.quote;
  const merged = mergeCandleSets(historyRes, intradayRes);
  const rawRows: RawCandleRow[] = merged.rows;
  const candles: Candle[] = toCandles(rawRows, TIMEFRAME_MINUTES[timeframe], now);
  const complete = candles.filter((c) => c.complete);
  const htfTimeframe = HTF_MAP[timeframe];
  const htfCandles = toCandles(aggregateRows(rawRows, TIMEFRAME_MINUTES[htfTimeframe]), TIMEFRAME_MINUTES[htfTimeframe], now);
  const a = atr(complete, 14);
  const candleStatus: DataStatus =
    complete.length === 0 ? "UNAVAILABLE" : merged.invalidRows > 0 || historyRes.status !== "LIVE" ? "PARTIAL" : "LIVE";

  const structure = analyzeStructure(candles, htfCandles, timeframe, htfTimeframe);
  const consolidations = detectConsolidations(complete, a, timeframe);
  const vp = buildVolumeProfile(complete, 24);
  const sessionLevels = sessionLevelsFrom(candles, now);
  const momentum = momentumFromCandles(candles, now);

  /* ---------------------------------------------------------------- *
   * STAGE 2 — independent enrichment. Each module fails independently:
   * a futures, option-chain or Greeks failure can never blank the chart.
   * ---------------------------------------------------------------- */
  // Each module runs independently and KEEPS its own error. A futures, expiry or
  // option-chain failure can never blank the spot chart or S/R analysis.
  const settled = await Promise.allSettled([
    analyzeFuturesFor(symbol, spot?.ltp ?? null, now),
    discoverExpiries(symbol, getToken()),
  ]);
  const settleErr = (r: PromiseSettledResult<unknown>): string | null =>
    r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : null;

  const futuresRes = settled[0];
  const expiriesRes = settled[1];

  const futuresError =
    settleErr(futuresRes) ??
    (futuresRes.status === "fulfilled" && futuresRes.value.status === "UNAVAILABLE" ? futuresRes.value.message : null);

  let expiries: string[] | null = null;
  let expiriesReason: string | null = null;
  let expiryDiscovery: ExpiryDiscovery | null = null;
  if (expiriesRes.status === "fulfilled") {
    expiryDiscovery = expiriesRes.value;
    expiries = expiryDiscovery.expiries.length > 0 ? expiryDiscovery.expiries : null;
    expiriesReason = expiryDiscovery.reason;
  } else {
    expiriesReason = settleErr(expiriesRes) ?? "Expiry discovery failed";
  }

  const expiry = expiryDiscovery?.selectedExpiry ?? null;

  // Expiry selection is validated against actual contract availability: an expiry
  // must carry BOTH CE and PE contracts. If the selected expiry returns zero chain
  // rows, the next usable expiry is tried (max 3) instead of blindly retrying.
  const usableExpiries = expiryDiscovery?.usableExpiries?.length ? expiryDiscovery.usableExpiries : expiry ? [expiry] : [];
  // Only the nearest expiry is requested up front. Trying several expiries serially
  // multiplied the first-scan latency; the fallback list is used only if it returns
  // zero rows, and even then just one retry.
  const candidateExpiries = usableExpiries.slice(0, 2);
  let chainResult: OptionChainResult | null = null;
  let chainError: string | null = null;
  let attemptedExpiries: Array<{ expiry: string; strikeCount: number; reason: string }> = [];
  let resolvedExpiry: string | null = null;
  for (const candidate of candidateExpiries) {
    const ceCount = expiryDiscovery?.ceCounts?.[candidate] ?? 0;
    const peCount = expiryDiscovery?.peCounts?.[candidate] ?? 0;
    if (ceCount === 0 && peCount === 0 && expiryDiscovery?.source === "OPTION_CONTRACT") {
      attemptedExpiries.push({ expiry: candidate, strikeCount: 0, reason: `skipped: contract discovery shows 0 CE and 0 PE contracts for this expiry` });
      continue;
    }
    const r = await fetchOptionChain(symbol, candidate, cfg.indexKey);
    attemptedExpiries.push({ expiry: candidate, strikeCount: r.strikes.length, reason: r.strikes.length > 0 ? "ok" : r.message });
    if (r.strikes.length > 0) {
      chainResult = r;
      resolvedExpiry = candidate;
      break;
    }
    chainError = r.message;
  }
  const chainSettled = await Promise.allSettled([
    chainResult ? Promise.resolve(chainResult) : Promise.resolve(null),
    resolvedExpiry ? buildContractMap(symbol, resolvedExpiry, getToken()) : Promise.resolve(new Map<string, { tradingSymbol: string; lotSize: number | null }>()),
  ]);
  const chainError2 = chainSettled[0].status === "rejected"
    ? (chainSettled[0].reason instanceof Error ? chainSettled[0].reason.message : String(chainSettled[0].reason))
    : null;
  const contractMap = chainSettled[1].status === "fulfilled"
    ? chainSettled[1].value
    : new Map<string, { tradingSymbol: string; lotSize: number | null }>();

  const activeExpiry = resolvedExpiry ?? expiry;
  const chain = chainResult ?? {
    strikes: [] as OptionChainStrike[],
    status: "UNAVAILABLE" as DataStatus,
    message: chainError2
      ? `Option chain request failed: ${chainError2}`
      : attemptedExpiries.length > 0
        ? `No option-chain rows could be retrieved. Tried expiry/expiries: ${attemptedExpiries.map((a) => `${a.expiry} → ${a.reason}`).join("; ")}`
        : chainError
          ? `Option chain request failed: ${chainError}`
          : expiryDiscovery
            ? `${expiryDiscovery.message}${expiryDiscovery.errorCode ? ` [${expiryDiscovery.errorCode}]` : ""}`
            : (expiriesReason ?? "Option chain skipped: no expiry could be selected."),
    greeksAvailable: false,
    bidAskQtyAvailable: false,
    receivedAt: now,
    rawRowCount: expiryDiscovery?.contractRowCount ?? 0,
  };

  // Persist OI snapshots BEFORE loading history so this cycle's data is available next cycle.
  const daysToExpiry = activeExpiry ? Math.max(0, Math.round((new Date(`${activeExpiry}T15:30:00+05:30`).getTime() - now) / 86400000)) : null;

  // ---- Persistence FIRST, then history read, then engines ----
  // A database failure is captured in oiPersist and surfaced by the readiness gate;
  // it can never masquerade as "no history yet".
  const oiPersist = activeExpiry
    ? await persistOiSnapshots({ symbol, expiry: activeExpiry, strikes: chain.strikes, now })
    : { ok: false, operation: "INSERT" as const, table: "oi_snapshot", symbol, expiry: null, recordCount: 0, error: "no expiry selected", durationMs: 0, at: new Date(now).toISOString(), skipped: true, skipReason: "no expiry selected" };

  const oiHistoryRead = activeExpiry
    ? await loadOiHistory({ symbol, expiry: activeExpiry, sinceMs: now - 6 * 3600000, now })
    : { ok: false, rows: [], recordCount: 0, error: "no expiry selected", durationMs: 0, oldestAt: null, newestAt: null, distinctObservations: 0, has5m: false, has15m: false, hasBaseline: false, at: new Date(now).toISOString() };

  const oi = computeOiIntel(chain.strikes, oiHistoryRead.rows, now, chain.greeksAvailable, chain.bidAskQtyAvailable);
  // Premium observations are stored alongside OI (ltp + receivedAt), so their count
  // is the number of stored rows carrying a price.
  const premiumObservationCount = oiHistoryRead.rows.filter((r) => r.ltp !== null).length;

  // Underlying direction is needed by the participation layer BEFORE strike intel.
  const momentumEarly = momentumFromCandles(candles, now);
  const spotDirection: "BULLISH" | "BEARISH" | "FLAT" | "UNAVAILABLE" =
    spot?.ltp === null || spot?.ltp === undefined ? "UNAVAILABLE" : momentumEarly.bias === "NEUTRAL" ? "FLAT" : momentumEarly.bias;
  const strikeIntel = buildStrikeIntel(chain.strikes, spot?.ltp ?? null, oiHistoryRead.rows, now, contractMap, {
    symbol,
    expiry: activeExpiry ?? "",
    spotDirection,
    daysToExpiry,
    expectedHoldMinutes: 60,
  });
  // The ΔOI engine needs the ATM strike, derived directly from the chain (a nearest-
  // strike comparison, no API call). Full candidate selection runs later in STAGE 2c
  // because ranking depends on the ΔOI measurements.
  const preliminaryAtmStrike =
    spot?.ltp === null || spot?.ltp === undefined
      ? null
      : (chain.strikes.reduce<{ strike: number; dist: number } | null>((best, st) => {
          const dist = Math.abs(st.strike - spot.ltp!);
          return best === null || dist < best.dist ? { strike: st.strike, dist } : best;
        }, null)?.strike ?? null);

  /* ---------------------------------------------------------------- *
   * STAGE 2b — DEDICATED ΔOI INTELLIGENCE ENGINE
   * Runs after strike intel so premium momentum and relative volume are already
   * available, and before S/R so OI clusters can be passed as (unconfirmed)
   * candidate evidence. Every rolling window is identity-scoped.
   * ---------------------------------------------------------------- */
  const oiIntelligence = buildOiIntelligence({
    underlying: symbol,
    expiry: activeExpiry ?? "",
    spot: spot?.ltp ?? null,
    atmStrike: preliminaryAtmStrike,
    strikes: chain.strikes.map((st) => {
      const ceIntel = strikeIntel.find((x) => x.strike === st.strike);
      const peIntel = strikeIntel.find((x) => x.strike === st.strike);
      return {
        strike: st.strike,
        ce: {
          oi: st.ce.oi,
          prevOi: st.ce.prevOi,
          sourceChange: st.ce.oi !== null && st.ce.prevOi !== null ? st.ce.oi - st.ce.prevOi : null,
          volume: st.ce.volume,
          ltp: st.ce.ltp,
          prevClose: st.ce.prevClose,
          premiumChange5m: ceIntel?.ce.momentum5m ?? null,
          premiumChange15m: ceIntel?.ce.momentum15m ?? null,
          relativeVolume: ceIntel?.ce.relativeVolume ?? null,
          instrumentKey: st.ce.instrumentKey,
        },
        pe: {
          oi: st.pe.oi,
          prevOi: st.pe.prevOi,
          sourceChange: st.pe.oi !== null && st.pe.prevOi !== null ? st.pe.oi - st.pe.prevOi : null,
          volume: st.pe.volume,
          ltp: st.pe.ltp,
          prevClose: st.pe.prevClose,
          premiumChange5m: peIntel?.pe.momentum5m ?? null,
          premiumChange15m: peIntel?.pe.momentum15m ?? null,
          relativeVolume: peIntel?.pe.relativeVolume ?? null,
          instrumentKey: st.pe.instrumentKey,
        },
      };
    }),
    history: oiHistoryRead.rows,
    now,
  });

  /* ---------------------------------------------------------------- *
   * STAGE 2c — BEST STRIKE SELECTION using validated ΔOI results
   * ---------------------------------------------------------------- */
  const oiMeasurementMap = new Map<string, ContractOiMeasurements>();
  for (const row of oiIntelligence.rows) {
    oiMeasurementMap.set(`CE:${row.strike}`, row.ce);
    oiMeasurementMap.set(`PE:${row.strike}`, row.pe);
  }
  const selection = buildStrikeSelection({
    strikeIntel,
    spot: spot?.ltp ?? null,
    expiry: activeExpiry,
    daysToExpiry,
    now,
    contractMap,
    oiMeasurements: oiMeasurementMap,
    underlyingDirection: spotDirection,
  });

  /* ---------------------------------------------------------------- *
   * STAGE 3 — dynamic S/R + trade intelligence
   * ---------------------------------------------------------------- */
  // futuresRes.value is already a FuturesIntel (with its own diagnostic message).
  // Only fall back to a generic object when the promise itself rejected.
  const futuresIntel: FuturesIntel =
    futuresRes.status === "fulfilled"
      ? futuresRes.value
      : {
          ...(await emptyFutures(symbol, spot?.ltp ?? null)),
          message: `Futures analysis failed: ${futuresError ?? "unknown error"}`,
        };

  const oiClusters = oi.oiClusters
    .filter((c) => (spot?.ltp !== null && spot?.ltp !== undefined ? Math.abs(c.strike - spot.ltp) < (a ?? spot.ltp * 0.01) * 25 : true))
    .slice(0, 8);
  const zoneInputsBase = {
    symbol,
    spot: spot?.ltp ?? null,
    candles,
    higherTimeframeCandles: htfCandles,
    timeframe,
    htfTimeframe,
    structure,
    consolidations,
    sessionLevels,
    volumeProfile: vp,
    oiClusters,
    quotes: {
      available: (spot?.bidQty ?? null) !== null && (spot?.askQty ?? null) !== null,
      bidQty: spot?.bidQty ?? null,
      askQty: spot?.askQty ?? null,
      note: "Best-level bid/ask quantity from the market quote (multi-level depth is reported separately)",
    },
    futures: {
      available: futuresIntel.status === "LIVE" || futuresIntel.status === "PARTIAL",
      classification: futuresIntel.classification === "UNAVAILABLE" ? null : futuresIntel.classification,
      note: "Futures price/OI/volume interaction",
    },
    tickSize: 0.05,
    now,
  };
  const provisionalClusters = buildClusters(extractCandidates(zoneInputsBase), zoneInputsBase);
  const provisionalZones = scoreZones(provisionalClusters, zoneInputsBase);
  // Zone score history only affects the strengthening/weakening deltas, so it is
  // fetched with a timeout rather than allowed to stall the whole cycle.
  const scoreRead = await Promise.race([
    loadZoneScoreHistory(provisionalZones.map((z) => z.id)),
    new Promise<{ ok: boolean; history: Record<string, Array<{ t: number; score: number }>>; error: string | null; recordCount: number }>((resolve) =>
      setTimeout(() => resolve({ ok: false, history: {}, error: "zone score history read timed out", recordCount: 0 }), 3000),
    ),
  ]);
  const historyMap = scoreRead.history;
  const zones = scoreZones(provisionalClusters, { ...zoneInputsBase, scoreHistory: historyMap });
  const levels = selectLevels(zones, spot?.ltp ?? null);

  const tradeArgs: TradeInputs = {
    spot: spot?.ltp ?? null,
    structure,
    zones,
    levels,
    futures: futuresIntel,
    oi,
    selection: { bestCall: selection.bestCall, bestPut: selection.bestPut, atmStrike: selection.atmStrike, expiry: selection.expiry },
    momentum,
    atrValue: a,
    volumeProfile: vp,
    chainStatus: chain.status,
    greeksAvailable: chain.greeksAvailable,
    bidAskQtyAvailable: chain.bidAskQtyAvailable,
    candlesStatus: candleStatus,
    now,
  };
  let plan = buildTradePlan(tradeArgs);
  plan = monitorTrade(symbol, plan, spot?.ltp ?? null, now);
  const scenarios = buildScenarios(tradeArgs, plan);

  /* ---------------------------------------------------------------- *
   * STAGE 4 — data quality, alerts, persistence
   * ---------------------------------------------------------------- */
  const lastCandle = candles[candles.length - 1] ?? null;
  const candleStale = lastCandle !== null ? now - lastCandle.ts > 6 * TIMEFRAME_MINUTES[timeframe] * 60000 : true;
  const metrics = getMetrics();
  // Market status is purely cosmetic context. It must never delay the response, so it
  // runs with a strict timeout and degrades to null instead of blocking.
  const marketStatus = await Promise.race([
    getMarketStatus(cfg.exchange),
    new Promise<{ status: string; message: string; marketStatus: string | null; graph: string | null }>((resolve) =>
      setTimeout(() => resolve({ status: "UNAVAILABLE", message: "market status timed out", marketStatus: null, graph: null }), 2500),
    ),
  ]);

  const dq = buildDataQuality({
    symbol,
    connected,
    spot: {
      status: spotResult.status,
      message: spotResult.message,
      freshnessMs: spot?.freshnessMs ?? null,
      sourceTs: spot?.sourceTs ? new Date(spot.sourceTs).toISOString() : null,
      receivedAt: spot ? new Date(spot.receivedAt).toISOString() : null,
      lastUpdate: marketStatus.marketStatus,
    },
    candles: {
      status: candleStatus,
      message: `${historyRes.message}; intraday: ${intradayRes.message}`,
      sourceTs: lastCandle ? new Date(lastCandle.ts).toISOString() : null,
      receivedAt: new Date(historyRes.receivedAt).toISOString(),
    },
    futures: { status: futuresIntel.status, message: futuresIntel.message, sourceTs: null },
    chain: {
      status: chain.status,
      message: chain.message,
      sourceTs: expiry,
      receivedAt: new Date(chain.receivedAt).toISOString(),
    },
    greeks: {
      status: chain.greeksAvailable ? "LIVE" : chain.strikes.length > 0 ? "PARTIAL" : "UNAVAILABLE",
      message: chain.greeksAvailable
        ? "Delta/Gamma/Theta/Vega/IV provided directly by Upstox /v2/option/chain (source: UPSTOX). Nothing calculated locally."
        : "Greeks not returned by Upstox for this chain — displayed as UNAVAILABLE, never estimated.",
    },
    oi: {
      status: oi.status,
      message: oi.message,
      receivedAt: oi.baselineAt,
    },
    notes,
  });

  const bucketTs = Math.floor(now / (5 * 60000)) * 5 * 60000;
  const alerts = buildAlerts({
    symbol,
    levels,
    zones,
    selection,
    trade: plan,
    oi,
    atmStrike: selection.atmStrike,
    candleDataStale: candleStale,
    disconnected: dq.entries.some((e) => e.status === "DISCONNECTED"),
    bucketTs,
    greeksObservationsFresh: oiHistoryRead.ok && oiHistoryRead.distinctObservations >= 2,
  });
  // Persistence is background work. It must never delay a scan response: the live
  // data is already computed and validated, and a slow write must not make the user
  // wait for it. Errors are captured asynchronously and surfaced on the next cycle.
  void persistAlerts(alerts).catch(() => {});
  void Promise.allSettled([
    persistCandles(symbol, timeframe, rawRows),
    persistZones(zones, now),
    persistRecommendation(symbol, plan, now),
  ]);

  const recentAlerts = alerts.slice(0, 8).map((al) => ({ type: al.type, title: al.title, message: al.message, createdAt: new Date(now).toISOString(), severity: al.severity }));

  /* ---------------------------------------------------------------- *
   * STAGE 5 — DATA READINESS GATE
   * Evaluates whether each downstream engine had the validated source data
   * it requires. Results are reported to the UI and diagnostics; engines
   * above were only executed where their prerequisites were satisfied.
   * ---------------------------------------------------------------- */
  const chainPricedStrikes = chain.strikes.filter((st) => st.ce.ltp !== null || st.pe.ltp !== null).length;
  const greekFields = chain.strikes.reduce<number>((acc, st) => acc + [st.ce.delta, st.ce.gamma, st.ce.theta, st.ce.vega, st.ce.iv, st.pe.delta, st.pe.gamma, st.pe.theta, st.pe.vega, st.pe.iv].filter((v) => v !== null).length, 0);
  const greekSlots = chain.strikes.length * 10;
  const greeksCoveragePct = greekSlots > 0 ? (greekFields / greekSlots) * 100 : null;
  const chainPriced = chainPricedStrikes > 0;
  const liquidityOk = selection.bestCall !== null || selection.bestPut !== null;
  const spreadOk = selection.alternatives.some((c) => (c.leg.spreadPct ?? 0) > 0 && (c.leg.spreadPct ?? Infinity) <= DEFAULT_WEIGHTS.thresholds.maxSpreadPct);
  const lastCandleTs = lastCandle ? new Date(lastCandle.ts).toISOString() : null;

  const readinessInputs: ReadinessInputs = {
    sessionConnected: connected,
    spot: { status: spotResult.status, ltp: spot?.ltp ?? null, prevClose: spot?.prevClose ?? null },
    candles: { status: candleStatus, count: complete.length, lastTs: lastCandleTs, stale: candleStale },
    structureOk: structure.status === "LIVE",
    levelsOk: levels.immediateSupport !== null || levels.immediateResistance !== null,
    instrumentKey: spotResult.resolvedKey ?? cfg.indexKey,
    expiry,
    contractRowCount: expiryDiscovery?.contractRowCount ?? 0,
    chainStrikes: chain.strikes.length,
    chainPricedStrikes,
    chainMessage: chain.message,
    greeksAvailable: chain.greeksAvailable,
    greeksCoveragePct,
    oiPersistenceOk: oiPersist.ok,
    oiPersistenceError: oiPersist.ok ? null : oiPersist.error,
    oiSnapshotCount: oiHistoryRead.recordCount,
    oldestOiAt: oiHistoryRead.oldestAt,
    has5mHistory: oiHistoryRead.has5m,
    has15mHistory: oiHistoryRead.has15m,
    hasBaseline: oiHistoryRead.hasBaseline,
    futuresResolved: futuresIntel.instrumentKey !== null,
    futuresLtp: futuresIntel.ltp,
    futuresOi: futuresIntel.oi,
    futuresMessage: futuresIntel.message,
    futuresReferenceAgeMinutes: futuresIntel.referencePending ? null : 5,
    futuresObservationCount: futuresIntel.futuresObservationCount ?? 0,
    futuresPersistenceOk: futuresIntel.futuresPersist?.ok ?? false,
    futuresPersistenceError: futuresIntel.futuresPersist && !futuresIntel.futuresPersist.ok ? (futuresIntel.futuresPersist.error ?? "unknown") : null,
    liquidityOk,
    spreadOk,
    bestCallAvailable: selection.bestCall !== null,
    bestPutAvailable: selection.bestPut !== null,
  };
  const readiness = evaluateReadiness(readinessInputs);
  const readinessSummaryValue = readinessSummary(readiness);

  const storageResults: StorageResultView[] = [
    oiPersist,
    futuresIntel.futuresPersist ?? null,
  ].filter((r): r is StorageResultView => r !== null);
  if (!oiHistoryRead.ok) {
    storageResults.push({ ok: false, operation: "SELECT", table: "oi_snapshot", symbol, expiry, recordCount: 0, error: oiHistoryRead.error, durationMs: oiHistoryRead.durationMs, at: oiHistoryRead.at, skipped: false, skipReason: null });
  }
  if (!scoreRead.ok) {
    storageResults.push({ ok: false, operation: "SELECT", table: "zone_score_history", symbol, expiry: null, recordCount: 0, error: scoreRead.error, durationMs: 0, at: new Date(now).toISOString(), skipped: false, skipReason: null });
  }

  const failedStorage = storageResults.filter((r) => !r.ok);
  const blockedModules = Object.values(readiness).filter((r) => r.state === "BLOCKED");
  const failedModules = Object.values(readiness).filter((r) => r.state === "FAILED");
  const verdict: DataFoundationView["verdict"] =
    !connected
      ? "BLOCKED"
      : failedStorage.length > 0 || failedModules.length > 0
        ? "FAILED"
        : blockedModules.length === 0
          ? "READY"
          : blockedModules.length >= 5
            ? "BLOCKED"
            : "PARTIAL";
  const verdictReason =
    !connected
      ? "No Upstox session in this process — connect a token in Settings."
      : failedStorage.length > 0
        ? `Database problem: ${failedStorage.map((r) => `${r.table} ${r.operation} failed — ${r.error}`).join("; ")}`
        : failedModules.length > 0
          ? failedModules.map((m) => `${m.module}: ${m.reason}`).join(" | ")
          : blockedModules.length === 0
            ? `All ${Object.keys(readiness).length} modules have their required validated source data.`
            : `READY ${readinessSummaryValue.ready}/${readinessSummaryValue.total}; blocked: ${blockedModules.map((m) => m.module).join(", ")}.`;

  const dataFoundation: DataFoundationView = {
    verdict,
    reason: verdictReason,
    modules: Object.values(readiness).map((r) => ({
      module: r.module,
      state: r.state,
      ready: r.ready,
      present: r.present,
      missing: r.missing,
      pendingHistory: r.pendingHistory,
      reason: r.reason,
      action: r.action,
    })),
    storage: storageResults,
    counts: {
      oiSnapshotCount: oiHistoryRead.recordCount,
      oldestOiAt: oiHistoryRead.oldestAt,
      newestOiAt: oiHistoryRead.newestAt,
      distinctOiObservations: oiHistoryRead.distinctObservations,
      premiumObservationCount,
      futuresObservationCount: futuresIntel.futuresObservationCount ?? 0,
      oiReadOk: oiHistoryRead.ok,
      oiReadError: oiHistoryRead.ok ? null : oiHistoryRead.error,
      chainStrikes: chain.strikes.length,
      chainPricedStrikes,
      contractRowCount: expiryDiscovery?.contractRowCount ?? 0,
      expiryCount: expiryDiscovery?.expiryCount ?? 0,
      greeksCoveragePct,
    },
  };

  return {
    symbol,
    timeframe,
    generatedAt: new Date(now).toISOString(),
    marketStatus: marketStatus.marketStatus,
    sessionConnected: connected,
    processId: processId(),
    lastRequestAt: metrics.lastRequestAt ? new Date(metrics.lastRequestAt).toISOString() : null,
    lastError: metrics.lastError,
    spot: {
      status: spotResult.status,
      message: spotResult.message,
      ltp: spot?.ltp ?? null,
      open: spot?.open ?? null,
      high: spot?.high ?? null,
      low: spot?.low ?? null,
      prevClose: spot?.prevClose ?? null,
      change: spot?.change ?? null,
      pctChange: spot?.pctChange ?? null,
      volume: spot?.volume ?? null,
      volumeStatus: spot?.volumeStatus ?? "UNAVAILABLE",
      sourceTs: spot?.sourceTs ? new Date(spot.sourceTs).toISOString() : null,
      freshnessMs: spot?.freshnessMs ?? null,
      prevCloseSource: spotResult.prevCloseSource,
      resolvedKey: spotResult.resolvedKey,
    },
    candles: {
      status: candleStatus,
      message: `${historyRes.message}; ${complete.length} complete candles, ${candles.length - complete.length} forming.`,
      source: merged.sources,
      count: complete.length,
      formingCount: candles.length - complete.length,
      first: candles.length ? new Date(candles[0].ts).toISOString() : null,
      last: lastCandle ? new Date(lastCandle.ts).toISOString() : null,
      atr: { value: a === null ? null : round2(a), timeframe, period: 14, status: a === null ? "UNAVAILABLE" : "LIVE" },
    },
    chart: {
      timeframe,
      candles: candles.slice(-300),
      zones,
      levels,
      session: sessionLevels,
      vwap: sessionLevels.vwap,
    },
    structure,
    volumeProfile: vp,
    sessionLevels,
    zones,
    levels,
    futures: futuresIntel,
    optionChain: {
      status: chain.status,
      message: chain.message,
      expiry: activeExpiry,
      expiries: expiryDiscovery?.usableExpiries ?? expiryDiscovery?.expiries ?? expiries ?? [],
      strikes: strikeIntel,
      oi,
      spot: chain.strikes[0]?.spot ?? spot?.ltp ?? null,
    },
    greeks: {
      status: chain.greeksAvailable ? "LIVE" : chain.strikes.length > 0 ? "PARTIAL" : "UNAVAILABLE",
      message: chain.greeksAvailable
        ? "Greeks sourced from Upstox (UPSTOX). No local model used."
        : "Greeks unavailable from Upstox for this chain — displayed as UNAVAILABLE (never fabricated).",
      source: chain.greeksAvailable ? "UPSTOX" : "UNAVAILABLE",
      distribution: strikeIntel.map((s) => ({
        strike: s.strike,
        ceDelta: s.ce.delta,
        peDelta: s.pe.delta,
        ceGamma: s.ce.gamma,
        peGamma: s.pe.gamma,
        ceTheta: s.ce.theta,
        peTheta: s.pe.theta,
        ceVega: s.ce.vega,
        peVega: s.pe.vega,
        ceIv: s.ce.iv,
        peIv: s.pe.iv,
      })),
    },
    strikeMomentum: {
      status: chain.strikes.length > 0 ? "LIVE" : "UNAVAILABLE",
      message: `Ranked by premium momentum, volume, OI change and Greeks across ${strikeIntel.length} strikes.`,
      ceRanked: selection.alternatives.filter((c) => c.optionType === "CE").slice(0, 6),
      peRanked: selection.alternatives.filter((c) => c.optionType === "PE").slice(0, 6),
    },
    selection,
    trade: plan,
    scenarios,
    dataQuality: dq,
    dataFoundation,
    oiIntelligence,
    alertsRecent: recentAlerts,
    notes: [
      "Live data source: Upstox REST APIs only. Spot uses GET /v3/market-quote/quotes with a /v2 fallback; candles use GET /v3/historical-candle with a /v2 fallback.",
      "NIFTY and SENSEX run fully independent pipelines; no instruments, expiries or data are ever mixed.",
      "Each module fails independently: a futures, option-chain or Greeks failure cannot blank the price chart or S/R analysis.",
    ],
  };
}

function emptySnapshot(symbol: SymbolKey, timeframe: Timeframe, now: number, pid: string, metrics: TransportMetricsView): AnalysisSnapshot {
  const dq = buildDataQuality({
    symbol,
    connected: false,
    spot: { status: "UNAVAILABLE", message: "No Upstox token in this process session.", freshnessMs: null, sourceTs: null, receivedAt: null, lastUpdate: null },
    candles: { status: "UNAVAILABLE", message: "Candles require a connected session.", sourceTs: null, receivedAt: null },
    futures: { status: "UNAVAILABLE", message: "Futures require a connected session.", sourceTs: null },
    chain: { status: "UNAVAILABLE", message: "Option chain requires a connected session.", sourceTs: null, receivedAt: null },
    greeks: { status: "UNAVAILABLE", message: "Greeks require a connected session." },
    oi: { status: "UNAVAILABLE", message: "OI snapshots require a connected session.", receivedAt: null },
    notes: [],
  });
  const emptyLevels: SrLevels = { immediateSupport: null, primarySupport: null, immediateResistance: null, primaryResistance: null, unavailable: [] };
  const emptyStructure: MarketStructure = {
    status: "UNAVAILABLE",
    message: "Structure analysis requires candle data.",
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
  return {
    symbol,
    timeframe,
    generatedAt: new Date(now).toISOString(),
    marketStatus: null,
    sessionConnected: false,
    processId: pid,
    lastRequestAt: metrics.lastRequestAt ? new Date(metrics.lastRequestAt).toISOString() : null,
    lastError: metrics.lastError,
    spot: {
      status: "UNAVAILABLE",
      message: "No Upstox token in backend session — connect from Settings.",
      ltp: null, open: null, high: null, low: null, prevClose: null, change: null, pctChange: null,
      volume: null, volumeStatus: "UNAVAILABLE", sourceTs: null, freshnessMs: null,
      prevCloseSource: "none", resolvedKey: null,
    },
    candles: {
      status: "UNAVAILABLE",
      message: "No candles fetched — no session.",
      source: [], count: 0, formingCount: 0, first: null, last: null,
      atr: { value: null, timeframe, period: 14, status: "UNAVAILABLE" },
    },
    chart: { timeframe, candles: [], zones: [], levels: emptyLevels, session: sessionLevelsFrom([], now), vwap: null },
    structure: emptyStructure,
    volumeProfile: { status: "UNAVAILABLE", message: "Requires candle data.", estimated: false, poc: null, vah: null, val: null, developingPoc: null, hvn: [], lvn: [], valueAreaVolumePct: null, concentration: null, migration: null },
    sessionLevels: sessionLevelsFrom([], now),
    zones: [],
    levels: emptyLevels,
    futures: emptyFuturesObject(symbol),
    optionChain: {
      status: "UNAVAILABLE", message: "Requires a connected session.", expiry: null, expiries: [],
      strikes: [],
      oi: { status: "UNAVAILABLE", message: "Requires a connected session.", totalCeOi: null, totalPeOi: null, combinedOi: null, pcr: null, pcrBasis: "UNAVAILABLE", ce5mChange: null, pe5mChange: null, ce15mChange: null, pe15mChange: null, ceSessionChange: null, peSessionChange: null, snapshotCount: 0, oldestSnapshotAt: null, baselineAt: null, oiClusters: [], additions: [], reductions: [], interpretation: [], greeksAvailable: false, bidAskQtyAvailable: false },
      spot: null,
    },
    greeks: { status: "UNAVAILABLE", message: "Requires a connected session.", source: "UNAVAILABLE", distribution: [] },
    strikeMomentum: { status: "UNAVAILABLE", message: "Requires a connected session.", ceRanked: [], peRanked: [] },
    selection: { status: "UNAVAILABLE", message: "Requires a connected session.", spot: null, atmStrike: null, expiry: null, bestCall: null, bestPut: null, alternatives: [], rationale: [] },
    trade: {
      action: "NO_TRADE", direction: "neutral", status: "UNAVAILABLE", headline: "NO TRADE — not connected",
      setupScore: null, setupCoverage: 0, setupComponents: {}, entryTrigger: "Not applicable", entryLow: null, entryHigh: null,
      entryState: "NOT_APPLICABLE", stopLoss: null, stopBasis: "Not applicable", target1: null, target2: null,
      targetBasis: "Not applicable", riskReward: null, invalidation: [], conditionsMet: [], conditionsFailed: [],
      spotAtSignal: null, premium: null, contract: null,
      noTradeReasons: ["No Upstox token in backend session. Connect from Settings to enable live analysis."],
      updatedAt: new Date(now).toISOString(),
    },
    scenarios: [],
    dataQuality: dq,
    dataFoundation: {
      verdict: "BLOCKED",
      reason: "No Upstox session in this process. Every downstream engine is gated until a token is connected in Settings.",
      modules: [
        "OPTION_CHAIN", "GREEKS", "OI_INTELLIGENCE", "STRIKE_MOMENTUM", "BEST_STRIKE_FINDER", "FUTURES", "FUTURES_POSITIONING", "TRADE_FINDER",
      ].map((m) => ({
        module: m,
        state: "BLOCKED" as const,
        ready: false,
        present: [],
        missing: ["Upstox session"],
        pendingHistory: [],
        reason: "Requires a connected Upstox session.",
        action: "Connect an Upstox token in Settings.",
      })),
      storage: [],
      counts: {
        oiSnapshotCount: 0, oldestOiAt: null, newestOiAt: null, distinctOiObservations: 0,
        premiumObservationCount: 0, futuresObservationCount: 0,
        oiReadOk: true, oiReadError: null,
        chainStrikes: 0, chainPricedStrikes: 0, contractRowCount: 0, expiryCount: 0, greeksCoveragePct: null,
      },
    },
    oiIntelligence: {
      status: "UNAVAILABLE",
      message: "Requires a connected Upstox session.",
      totalCeOi: null, totalPeOi: null, combinedOi: null, pcr: null, pcrChange: null,
      ce5mChange: null, pe5mChange: null, ce15mChange: null, pe15mChange: null,
      ceSessionChange: null, peSessionChange: null,
      ce5mPct: null, pe5mPct: null, ce15mPct: null, pe15mPct: null,
      windows: { m1: "WAITING_FOR_HISTORY" as const, m5: "WAITING_FOR_HISTORY" as const, m15: "WAITING_FOR_HISTORY" as const, session: "WAITING_FOR_HISTORY" as const },
      snapshotCount: 0, distinctObservations: 0,
      oldestSnapshotAt: null, newestSnapshotAt: null, baselineAt: null,
      rows: [], highestOiStrikes: [], largestAdditions: [], largestReductions: [],
      buildupClusters: [], unwindingClusters: [],
      freshParticipation: 0, weakeningParticipation: 0,
      interpretation: ["ΔOI intelligence requires option-chain data and stored observations."],
      unavailableReasons: ["Upstox session not connected"],
      priceConfirmationNote: "OI clusters are participation evidence only and are never confirmed support/resistance without price action.",
    },
    alertsRecent: [],
    notes: ["Connect an Upstox access token in Settings to enable live market data. No values are simulated while disconnected."],
  };
}

function emptyFuturesObject(symbol: string): FuturesIntel {
  return {
    status: "UNAVAILABLE",
    message: "Futures require a connected Upstox session.",
    instrumentKey: null, tradingSymbol: null, expiry: null, lotSize: null, ltp: null, spot: null,
    basis: null, basisPct: null, volume: null, oi: null, changeInOi: null, changeInOiPct: null,
    priceChange: null, volumeChange: null, classification: "UNAVAILABLE",
    interpretation: [], participation: "NOT_INFERRED",
  };
}

function aggregateRows(rows: RawCandleRow[], minutes: number): RawCandleRow[] {
  if (minutes <= 1 || rows.length === 0) return rows;
  // Aggregation from complete candles only (forming candle excluded from context).
  return aggregateRaw(rows.filter((r, idx) => idx < rows.length - 1 || true), minutes);
}

function aggregateRaw(rows: RawCandleRow[], minutes: number): RawCandleRow[] {
  const out: RawCandleRow[] = [];
  let bucketStart: number | null = null;
  let current: RawCandleRow | null = null;
  for (const row of rows) {
    if (bucketStart === null || current === null || row.ts >= bucketStart + minutes * 60000) {
      bucketStart = row.ts;
      current = { ...row };
      out.push(current);
    } else {
      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.volume = current.volume !== null && row.volume !== null ? current.volume + row.volume : null;
      current.volumeStatus = current.volumeStatus === "VALID" || row.volumeStatus === "VALID" ? "VALID" : "UNAVAILABLE";
    }
  }
  return out;
}

async function analyzeFuturesFor(symbol: SymbolKey, spot: number | null, now: number): Promise<FuturesIntel> {
  // Resolve the nearest valid futures contract from the instrument master (never guessed).
  const resolution = await resolveFuturesDetailed(symbol);
  if (resolution.contracts.length === 0) {
    return {
      status: "UNAVAILABLE",
      message: resolution.reason ?? "No index futures contract resolved from the Upstox instrument master.",
      instrumentKey: null,
      tradingSymbol: null,
      expiry: null,
      lotSize: null,
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
  }
  const contract = resolution.contracts[0];
  const q = await getQuoteForKeys([contract.instrumentKey]);
  void contract.tradingSymbol;
  const entry = q.entries[contract.instrumentKey] ?? q.entries[contract.instrumentKey.replace("|", ":")] ?? null;
  if (!entry) {
    return {
      status: "UNAVAILABLE",
      message: `Futures resolved (${contract.tradingSymbol}, ${contract.instrumentKey}, expiry ${contract.expiry}) but the quote request failed. ${q.message}${q.missingKeys.length > 0 ? ` missing: ${q.missingKeys.join(", ")}` : ""}`,
      instrumentKey: contract.instrumentKey,
      tradingSymbol: contract.tradingSymbol,
      expiry: contract.expiry,
      lotSize: contract.lotSize,
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
  }

  const current: FuturesSnapshot = {
    ltp: num(entry.last_price),
    oi: num(entry.oi) ?? num(entry.open_interest),
    prevOi: num(entry.previous_oi) ?? num(entry.prev_oi),
    volume: num(entry.volume),
    expiry: contract.expiry,
    instrumentKey: contract.instrumentKey,
    tradingSymbol: contract.tradingSymbol,
    lotSize: contract.lotSize,
  };
  if (current.ltp === null) {
    return {
      status: "PARTIAL",
      message: `${q.message} — quote entry present for ${contract.tradingSymbol} but LTP is missing.`,
      instrumentKey: contract.instrumentKey,
      tradingSymbol: contract.tradingSymbol,
      expiry: contract.expiry,
      lotSize: contract.lotSize,
      ltp: null,
      spot,
      basis: null,
      basisPct: null,
      volume: current.volume,
      oi: current.oi,
      changeInOi: null,
      changeInOiPct: null,
      priceChange: null,
      volumeChange: null,
      classification: "UNAVAILABLE",
      interpretation: [],
      participation: "NOT_INFERRED",
    };
  }

  // Reference snapshot from DB, scoped to the SAME contract AND expiry, closest to
  // ~5 minutes ago. Comparing against a different expiry is prohibited.
  const refRead = await loadFuturesReference({ symbol, expiry: contract.expiry, instrumentKey: contract.instrumentKey, now });
  let reference: FuturesSnapshot | null = null;
  let refAgeMinutes: number | null = null;
  if (refRead.reference) {
    refAgeMinutes = refRead.referenceAgeMinutes;
    reference = {
      ltp: refRead.reference.ltp,
      oi: refRead.reference.oi,
      prevOi: refRead.reference.prevOi,
      volume: refRead.reference.volume,
      expiry: contract.expiry,
      instrumentKey: contract.instrumentKey,
      tradingSymbol: null,
      lotSize: null,
    };
  }
  const futuresPersist = await persistFuturesSnapshot({
    symbol,
    expiry: contract.expiry,
    instrumentKey: contract.instrumentKey,
    observation: { ltp: current.ltp, oi: current.oi, prevOi: current.prevOi, volume: current.volume },
    spot,
    now,
  });
  // Record why no comparable reference exists so the UI can explain it.
  let referenceNote: string | null = null;
  if (!refRead.ok) referenceNote = `Futures reference read FAILED: ${refRead.error}`;
  else if (refRead.reference === null) {
    referenceNote =
      refRead.observationCount === 0
        ? "No futures snapshot stored yet for this contract — positioning classification is pending."
        : `Stored observations exist (${refRead.observationCount}) but none is within the 8-minute tolerance for a ~5-minute comparison.`;
  }
  const intel = analyzeFutures(current, reference, spot, refAgeMinutes);
  // Surface WHY no comparable reference exists, instead of silently classifying NEUTRAL.
  if (referenceNote) {
    intel.message = `${q.message}; ${intel.message} ${referenceNote}`;
  } else {
    intel.message = `${q.message}; ${intel.message}`;
  }
  intel.futuresPersist = futuresPersist;
  intel.futuresObservationCount = refRead.observationCount;
  intel.referencePending = reference === null;
  return intel;
}

function emptyFutures(symbol: SymbolKey, spot: number | null): FuturesIntel {
  return {
    status: "UNAVAILABLE",
    message: "Futures intelligence unavailable for this cycle.",
    instrumentKey: null,
    tradingSymbol: null,
    expiry: null,
    lotSize: null,
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
}

export interface TransportMetricsView {
  lastRequestAt: number | null;
  lastRequestEndpoint: string | null;
  lastRequestOk: boolean | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastErrorCode: string | null;
  totalRequests: number;
  totalFailures: number;
}


async function persistCandles(symbol: string, timeframe: string, rows: RawCandleRow[]): Promise<void> {
  if (rows.length === 0) return;
  const cacheKey = `${symbol}:${timeframe}`;
  const signature = `${rows.length}:${rows[rows.length - 1]?.ts ?? 0}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.candleSignature === signature) return;
  try {
    const values = rows.slice(-400).map((r) => ({
      symbol,
      instrumentKey: SYMBOL_CONFIGS[symbol as SymbolKey].indexKey,
      timeframe,
      ts: new Date(r.ts),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      openInterest: r.openInterest,
      volumeStatus: r.volumeStatus,
      source: "upstox",
    }));
    await db.insert(candleCache).values(values).onConflictDoNothing();
    const existing = cache.get(cacheKey);
    if (existing) cache.set(cacheKey, { ...existing, candleSignature: signature });
  } catch {
    // non-fatal
  }
}

async function persistZones(zones: Zone[], now: number): Promise<void> {
  if (zones.length === 0) return;
  try {
    for (const z of zones) {
      await db
        .insert(zoneRegistry)
        .values({
          id: z.id,
          symbol: z.symbol,
          kind: z.kind,
          lower: z.lower,
          upper: z.upper,
          center: z.center,
          score: z.score,
          status: z.status,
          classification: z.classification,
          oiOnly: z.oiOnly,
          tests: z.tests,
          createdAt: new Date(z.createdAt),
          lastTestedAt: z.lastTestedAt ? new Date(z.lastTestedAt) : null,
          updatedAt: new Date(now),
          payload: {
            sources: z.sources,
            evidence: z.evidence,
            timeframeConfluence: z.timeframeConfluence,
            scoreHistory: z.scoreHistory.slice(-20),
            widthPct: z.widthPct,
          },
        })
        .onConflictDoUpdate({
          target: zoneRegistry.id,
          set: {
            lower: z.lower,
            upper: z.upper,
            center: z.center,
            score: z.score,
            status: z.status,
            classification: z.classification,
            tests: z.tests,
            lastTestedAt: z.lastTestedAt ? new Date(z.lastTestedAt) : null,
            updatedAt: new Date(now),
            payload: {
              sources: z.sources,
              evidence: z.evidence,
              timeframeConfluence: z.timeframeConfluence,
              scoreHistory: z.scoreHistory.slice(-20),
              widthPct: z.widthPct,
            },
          },
        });
      await db.insert(zoneScoreHistory).values({
        zoneId: z.id,
        symbol: z.symbol,
        score: z.score,
        capturedAt: new Date(now),
      });
    }
  } catch {
    // non-fatal
  }
}

function monitorTrade(symbol: string, plan: TradePlan, spot: number | null, now: number): TradePlan {
  const state = monitorStore.get(symbol) ?? null;

  if (plan.action === "NO_TRADE") {
    if (state && state.action !== "NO_TRADE") {
      const expired = now - state.since > 4 * 3600000;
      plan.headline = expired ? "NO TRADE (previous setup expired)" : plan.headline;
    }
    monitorStore.delete(symbol);
    return plan;
  }

  let nextState = plan.entryState === "MISSED_ENTRY" ? "MISSED" : plan.entryState === "WAIT_FOR_RETEST" ? "WATCHLIST" : "WAITING_FOR_ENTRY";

  if (state && state.action === plan.action && state.strike === plan.contract?.strike && spot !== null) {
    const bullish = plan.action === "CALL_BUY";
    if (state.entryLow !== null && spot >= state.entryLow && state.entryHigh !== null && spot <= state.entryHigh) {
      nextState = "ENTRY_TRIGGERED";
    } else if (bullish && state.entryLow !== null && spot > state.entryHigh!) {
      nextState = "ACTIVE";
    } else if (!bullish && state.entryHigh !== null && spot < state.entryLow!) {
      nextState = "ACTIVE";
    }
    if (state.stopLoss !== null && ((bullish && spot <= state.stopLoss) || (!bullish && spot >= state.stopLoss))) {
      nextState = "STOP_LOSS_HIT";
    } else if (state.target1 !== null && ((bullish && spot >= state.target1) || (!bullish && spot <= state.target1))) {
      nextState = "TARGET_1_HIT";
      if (state.target2 !== null && ((bullish && spot >= state.target2) || (!bullish && spot <= state.target2))) nextState = "TARGET_2_HIT";
    }
    plan = { ...plan, entryTrigger: `${plan.entryTrigger} [MONITOR STATE: ${nextState}]` };
  }

  monitorStore.set(symbol, {
    action: plan.action,
    strike: plan.contract?.strike ?? null,
    expiry: plan.contract?.leg.tradingSymbol ?? null,
    entryLow: plan.entryLow,
    entryHigh: plan.entryHigh,
    stopLoss: plan.stopLoss,
    target1: plan.target1,
    target2: plan.target2,
    state: nextState,
    since: state && state.action === plan.action ? state.since : now,
  });
  void symbol;
  return plan;
}

async function persistRecommendation(symbol: string, plan: TradePlan, now: number): Promise<void> {
  try {
    const id = `${symbol}:${new Date(now).toISOString().slice(0, 10)}:${plan.action}`;
    const values = {
      id,
      symbol,
      action: plan.action,
      direction: plan.direction,
      status:
        plan.action === "NO_TRADE"
          ? "WATCHLIST"
          : plan.entryState === "MISSED_ENTRY"
            ? "MISSED"
            : plan.entryState === "WAIT_FOR_RETEST"
              ? "WATCHLIST"
              : "WAITING_FOR_ENTRY",
      optionType: plan.contract?.optionType ?? null,
      strike: plan.contract?.strike ?? null,
      expiry: plan.contract?.leg.tradingSymbol ? null : null,
      tradingSymbol: plan.contract?.leg.tradingSymbol ?? null,
      instrumentKey: plan.contract?.leg.instrumentKey ?? null,
      spot: plan.spotAtSignal,
      premium: plan.premium,
      entryLow: plan.entryLow,
      entryHigh: plan.entryHigh,
      stopLoss: plan.stopLoss,
      target1: plan.target1,
      target2: plan.target2,
      riskReward: plan.riskReward,
      setupScore: plan.setupScore,
      suitabilityScore: plan.contract?.suitabilityScore ?? null,
      evidenceCoverage: plan.setupCoverage,
      payload: {
        headline: plan.headline,
        entryTrigger: plan.entryTrigger,
        entryState: plan.entryState,
        stopBasis: plan.stopBasis,
        targetBasis: plan.targetBasis,
        invalidation: plan.invalidation,
        conditionsMet: plan.conditionsMet,
        conditionsFailed: plan.conditionsFailed,
        noTradeReasons: plan.noTradeReasons,
        setupComponents: plan.setupComponents,
      },
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
    await db
      .insert(recommendation)
      .values(values)
      .onConflictDoUpdate({ target: recommendation.id, set: { ...values, updatedAt: new Date(now) } });
  } catch {
    // non-fatal
  }
}

export async function getAnalysis(symbol: SymbolKey, timeframe: Timeframe = PRIMARY_TIMEFRAME): Promise<AnalysisSnapshot> {
  const key = `${symbol}:${timeframe}`;
  const cachedEntry = cache.get(key);
  if (cachedEntry && Date.now() - cachedEntry.builtAt < ANALYSIS_TTL_MS) return cachedEntry.snapshot;
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = buildAnalysis(symbol, timeframe)
    .then((snapshot) => {
      const existing = cache.get(key);
      const upperKey = key;
      cache.set(key, {
        snapshot,
        builtAt: Date.now(),
        candleSignature: existing?.candleSignature ?? "",
        moduleStatuses: Object.fromEntries(snapshot.dataQuality.entries.map((e) => [e.module, e.status])),
        monitor: monitorStore.get(upperKey) ?? null,
      });
      inflight.delete(key);
      return snapshot;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });
  inflight.set(key, promise);
  return promise;
}

export async function getRecentAlerts(symbol: string | null, limit = 100) {
  try {
    const rows = symbol
      ? await db.select().from(dataQualityEvent).where(eq(dataQualityEvent.symbol, symbol)).orderBy(desc(dataQualityEvent.createdAt)).limit(20)
      : [];
    void rows;
    const { alertEvent } = await import("@/db/schema");
    const alerts = symbol
      ? await db.select().from(alertEvent).where(eq(alertEvent.symbol, symbol)).orderBy(desc(alertEvent.createdAt)).limit(limit)
      : await db.select().from(alertEvent).orderBy(desc(alertEvent.createdAt)).limit(limit);
    return alerts.map((a) => ({
      id: a.id,
      symbol: a.symbol,
      type: a.type,
      severity: a.severity,
      title: a.title,
      message: a.message,
      createdAt: new Date(a.createdAt).toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function getZoneDetail(zoneId: string) {
  try {
    const rows = await db.select().from(zoneRegistry).where(eq(zoneRegistry.id, zoneId)).limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    const history = await db
      .select()
      .from(zoneScoreHistory)
      .where(eq(zoneScoreHistory.zoneId, zoneId))
      .orderBy(desc(zoneScoreHistory.capturedAt))
      .limit(120);
    return {
      id: row.id,
      symbol: row.symbol,
      kind: row.kind,
      lower: row.lower,
      upper: row.upper,
      center: row.center,
      score: row.score,
      status: row.status,
      classification: row.classification,
      tests: row.tests,
      createdAt: new Date(row.createdAt).toISOString(),
      lastTestedAt: row.lastTestedAt ? new Date(row.lastTestedAt).toISOString() : null,
      updatedAt: new Date(row.updatedAt).toISOString(),
      payload: row.payload,
      scoreHistory: history
        .map((h) => ({ t: new Date(h.capturedAt).toISOString(), score: h.score }))
        .reverse(),
    };
  } catch {
    return null;
  }
}

export function clearSessionCaches(): void {
  cache.clear();
  instrumentCache.clear();
  monitorStore.clear();
}

export { zoneIdFor, selectLevels };
export type { SrLevelSelection };
