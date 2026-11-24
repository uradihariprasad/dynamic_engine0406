import { SYMBOL_CONFIGS, TIMEFRAME_MINUTES, type SymbolKey, type Timeframe } from "@/lib/config";
import { UpstoxError, upstoxRequest, failureToModuleStatus } from "@/lib/upstox/client";
import { getToken, recordRequest, updateValidationTs } from "@/lib/upstox/session";

/* ------------------------------------------------------------------ *
 * Shared shapes
 * ------------------------------------------------------------------ */

export interface RawCandleRow {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  openInterest: number | null;
  volumeStatus: "VALID" | "UNAVAILABLE";
}

export interface CandleWindowDetail {
  from: string;
  to: string;
  endpoint: string;
  httpStatus: number | null;
  rowCount: number;
  ok: boolean;
  errorCode: string | null;
  error: string | null;
  /** True when the window contained no trading day (weekend/holiday) — not a failure. */
  nonTrading: boolean;
}

export interface CandleFetchResult {
  rows: RawCandleRow[];
  status: "LIVE" | "PARTIAL" | "STALE" | "UNAVAILABLE" | "INVALID" | "DISCONNECTED";
  message: string;
  source: string;
  invalidRows: number;
  duplicates: number;
  receivedAt: number;
  /** Per-window request outcome, so a partially successful multi-window fetch is visible. */
  windows: CandleWindowDetail[];
  /** Number of windows that produced rows. */
  windowsSucceeded: number;
  windowsFailed: number;
  windowsEmpty: number;
}

export interface SpotQuote {
  instrumentKey: string;
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  change: number | null;
  pctChange: number | null;
  volume: number | null;
  volumeStatus: "VALID" | "UNAVAILABLE";
  oi: number | null;
  netChange: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  bidQty: number | null;
  askQty: number | null;
  totalBuyQty: number | null;
  totalSellQty: number | null;
  /** Multi-level depth, only populated when Upstox actually returns it. */
  depthBuy: Array<{ price: number; quantity: number; orders: number | null }>;
  depthSell: Array<{ price: number; quantity: number; orders: number | null }>;
  avgPrice: number | null;
  lastQty: number | null;
  upperCircuit: number | null;
  lowerCircuit: number | null;
  sourceTs: number | null;
  receivedAt: number;
  freshnessMs: number | null;
  quoteVersion: "V3" | "V2";
  /** Which Upstox field supplied the previous close. */
  prevCloseSource: "prev_close_price" | "ohlc.close" | "none";
}

/* ------------------------------------------------------------------ *
 * Token validation — official endpoint is GET /v2/user/profile
 * ------------------------------------------------------------------ */

export type TokenStatus = "VALID" | "INVALID" | "EXPIRED" | "REVOKED" | "NETWORK_ERROR" | "UPSTOX_SERVICE_ERROR";

export interface TokenValidationResult {
  status: TokenStatus;
  valid: boolean;
  userName: string | null;
  userId: string | null;
  email: string | null;
  broker: string | null;
  isActive: boolean | null;
  exchanges: string[];
  httpStatus: number | null;
  errorCode: string | null;
  message: string;
}

export async function validateToken(token: string): Promise<TokenValidationResult> {
  try {
    const res = await upstoxRequest<{ data?: Record<string, unknown> }>({
      path: "/v2/user/profile",
      token,
      retries: 0,
      critical: false,
    });
    const data = res.data?.data ?? {};
    const exchanges = Array.isArray(data.exchanges) ? (data.exchanges as string[]) : [];
    updateValidationTs();
    return {
      status: "VALID",
      valid: true,
      userName: typeof data.user_name === "string" ? data.user_name : null,
      userId: typeof data.user_id === "string" ? data.user_id : null,
      email: typeof data.email === "string" ? data.email : null,
      broker: typeof data.broker === "string" ? data.broker : null,
      isActive: typeof data.is_active === "boolean" ? data.is_active : null,
      exchanges,
      httpStatus: res.status,
      errorCode: null,
      message: `Token accepted by GET /v2/user/profile (HTTP ${res.status}, ${res.elapsedMs}ms)`,
    };
  } catch (err) {
    const f = failureToModuleStatus(err);
    const e = err as { status?: number | null; code?: string | null; kind?: string };
    let status: TokenStatus = "INVALID";
    if (e.kind === "NETWORK" || e.kind === "TIMEOUT") status = "NETWORK_ERROR";
    else if (e.kind === "SERVER") status = "UPSTOX_SERVICE_ERROR";
    else if (e.kind === "RATE_LIMITED") status = "UPSTOX_SERVICE_ERROR";
    else if (e.kind === "EXPIRED_TOKEN") status = "EXPIRED";
    else if (e.kind === "REVOKED_TOKEN") status = "REVOKED";
    else if (e.kind === "NO_TOKEN") status = "INVALID";
    recordRequest("/v2/user/profile", false, e.code ?? null, f.message);
    return {
      status,
      valid: false,
      userName: null,
      userId: null,
      email: null,
      broker: null,
      isActive: null,
      exchanges: [],
      httpStatus: e.status ?? null,
      errorCode: e.code ?? null,
      message: f.message,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function n(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asNumber(v: unknown): number | null {
  // Upstox sometimes returns numeric strings; both are accepted, never invented.
  return n(v);
}

function parseTimestamp(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    if (/^\d+$/.test(v)) {
      const num = Number(v);
      return num > 1e12 ? num : num * 1000;
    }
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Spot quotes — v3 full market quote first (gives depth + prev close), v2 fallback
 * ------------------------------------------------------------------ */

function entryToken(entry: Record<string, unknown>): string | null {
  const t = entry.instrument_token ?? entry.instrumentToken ?? entry.token;
  if (typeof t === "string" && t) return t;
  if (typeof t === "number" && Number.isFinite(t)) return String(t);
  return null;
}

function entrySymbol(entry: Record<string, unknown>): string | null {
  for (const k of ["symbol", "trading_symbol", "tradingSymbol"]) {
    const v = entry[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

export interface QuoteMatch {
  entry: Record<string, unknown> | null;
  matchedBy: "MAP_KEY" | "INSTRUMENT_TOKEN" | "TRADING_SYMBOL" | null;
  responseKeys: string[];
  responseTokens: string[];
  responseSymbols: string[];
}

/**
 * Matches a returned quote record to a requested instrument.
 *
 * CRITICAL: the V3 and V2 full-market-quote responses key `data` by
 * `EXCHANGE:TRADING_SYMBOL` (e.g. "NSE_FO:NIFTY FUT 29 DEC 26"), NOT by the
 * instrument key "NSE_FO|58875". Matching only the map key therefore fails for
 * every futures and option contract. Identity is resolved in this order:
 *   1. exact normalized map key
 *   2. instrument_token (primary identity — returned by both V2 and V3)
 *   3. trading symbol   (secondary check, EXACT match only, never partial)
 * A partial-symbol match is never accepted, so one contract's quote can never be
 * attributed to a different expiry or a similarly named instrument.
 */
export function matchQuoteEntry(
  map: Record<string, Record<string, unknown>>,
  key: string,
  expectedSymbol?: string | null,
): QuoteMatch {
  const wanted = normalizeQuoteKey(key);
  const responseKeys = Object.keys(map);
  const responseTokens = [...new Set(responseKeys.map((k) => entryToken(map[k])).filter((t): t is string => t !== null))];
  const responseSymbols = [...new Set(responseKeys.map((k) => entrySymbol(map[k])).filter((sym): sym is string => sym !== null))];

  for (const [k, v] of Object.entries(map)) {
    if (normalizeQuoteKey(k) === wanted) return { entry: v, matchedBy: "MAP_KEY", responseKeys, responseTokens, responseSymbols };
  }
  for (const v of Object.values(map)) {
    const tok = entryToken(v);
    if (tok && normalizeQuoteKey(tok) === wanted) return { entry: v, matchedBy: "INSTRUMENT_TOKEN", responseKeys, responseTokens, responseSymbols };
  }
  if (expectedSymbol) {
    const ws = normalizeQuoteKey(expectedSymbol);
    for (const v of Object.values(map)) {
      const sym = entrySymbol(v);
      if (sym && normalizeQuoteKey(sym) === ws) return { entry: v, matchedBy: "TRADING_SYMBOL", responseKeys, responseTokens, responseSymbols };
    }
    // Some responses carry the trading symbol only in the map key
    // ("EXCHANGE:TRADING_SYMBOL"), so compare the key's symbol portion too.
    for (const k of responseKeys) {
      const symPortion = k.includes(":") ? k.slice(k.indexOf(":") + 1) : k;
      if (symPortion && normalizeQuoteKey(symPortion) === ws) {
        return { entry: map[k], matchedBy: "TRADING_SYMBOL", responseKeys, responseTokens, responseSymbols };
      }
    }
  }
  return { entry: null, matchedBy: null, responseKeys, responseTokens, responseSymbols };
}

function pickEntry(map: Record<string, Record<string, unknown>>, key: string): Record<string, unknown> | null {
  return matchQuoteEntry(map, key).entry;
}

function depthToList(raw: unknown): Array<{ price: number; quantity: number; orders: number | null }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((d) => {
      const o = (d ?? {}) as Record<string, unknown>;
      const price = asNumber(o.price);
      const qty = asNumber(o.quantity);
      if (price === null || qty === null) return null;
      return { price, quantity: qty, orders: asNumber(o.orders) };
    })
    .filter((d): d is { price: number; quantity: number; orders: number | null } => d !== null);
}

function buildQuoteFromV3(entry: Record<string, unknown>, cfg: { indexKey: string }, receivedAt: number): SpotQuote | null {
  const ohlc = (entry.ohlc ?? {}) as Record<string, unknown>;
  const depth = (entry.depth ?? {}) as Record<string, unknown>;
  const ltp = asNumber(entry.last_price);
  // The documented previous-close field is `prev_close_price`. `ohlc.close` is a
  // fallback. `net_change` is the exchange-computed absolute change and is used to
  // cross-check the calculation instead of being trusted blindly.
  const prevCloseDocumented = asNumber(entry.prev_close_price);
  const prevCloseOhlc = asNumber(ohlc.close);
  const prevClose = prevCloseDocumented ?? prevCloseOhlc;
  const prevCloseSource: SpotQuote["prevCloseSource"] = prevCloseDocumented !== null ? "prev_close_price" : prevCloseOhlc !== null ? "ohlc.close" : "none";
  const sourceTs = parseTimestamp(entry.last_trade_time) ?? parseTimestamp(entry.timestamp);
  const volume = asNumber(entry.volume);
  return {
    instrumentKey: cfg.indexKey,
    ltp,
    open: asNumber(ohlc.open),
    high: asNumber(ohlc.high),
    low: asNumber(ohlc.low),
    prevClose,
    change: ltp !== null && prevClose !== null ? ltp - prevClose : asNumber(entry.net_change),
    pctChange: ltp !== null && prevClose !== null && prevClose !== 0 ? ((ltp - prevClose) / prevClose) * 100 : null,
    volume,
    volumeStatus: volume !== null && volume > 0 ? "VALID" : "UNAVAILABLE",
    oi: asNumber(entry.oi),
    netChange: asNumber(entry.net_change),
    prevCloseSource,
    bidPrice: depthToList(depth.buy)[0]?.price ?? null,
    askPrice: depthToList(depth.sell)[0]?.price ?? null,
    bidQty: depthToList(depth.buy)[0]?.quantity ?? null,
    askQty: depthToList(depth.sell)[0]?.quantity ?? null,
    totalBuyQty: asNumber(entry.total_buy_quantity),
    totalSellQty: asNumber(entry.total_sell_quantity),
    depthBuy: depthToList(depth.buy),
    depthSell: depthToList(depth.sell),
    avgPrice: asNumber(entry.average_price),
    lastQty: null,
    upperCircuit: asNumber(entry.upper_circuit_limit),
    lowerCircuit: asNumber(entry.lower_circuit_limit),
    sourceTs,
    receivedAt,
    freshnessMs: sourceTs !== null ? receivedAt - sourceTs : null,
    quoteVersion: "V3",
  };
}

function buildQuoteFromV2(entry: Record<string, unknown>, cfg: { indexKey: string }, receivedAt: number): SpotQuote | null {
  const ohlc = (entry.ohlc ?? {}) as Record<string, unknown>;
  const ltp = asNumber(entry.last_price);
  const prevClose = asNumber(ohlc.close);
  const sourceTs = parseTimestamp(entry.timestamp) ?? parseTimestamp((entry as { last_updated_ts?: unknown }).last_updated_ts);
  const volume = asNumber(entry.volume);
  const depth = (entry.depth ?? {}) as Record<string, unknown>;
  return {
    instrumentKey: cfg.indexKey,
    ltp,
    open: asNumber(ohlc.open),
    high: asNumber(ohlc.high),
    low: asNumber(ohlc.low),
    prevClose,
    change: ltp !== null && prevClose !== null ? ltp - prevClose : null,
    pctChange: ltp !== null && prevClose !== null && prevClose !== 0 ? ((ltp - prevClose) / prevClose) * 100 : null,
    volume,
    volumeStatus: volume !== null && volume > 0 ? "VALID" : "UNAVAILABLE",
    oi: asNumber(entry.open_interest ?? entry.oi),
    netChange: null,
    bidPrice: asNumber(entry.bid_price) ?? depthToList(depth.buy)[0]?.price ?? null,
    askPrice: asNumber(entry.ask_price) ?? depthToList(depth.sell)[0]?.price ?? null,
    bidQty: asNumber(entry.bid_quantity) ?? depthToList(depth.buy)[0]?.quantity ?? null,
    askQty: asNumber(entry.ask_quantity) ?? depthToList(depth.sell)[0]?.quantity ?? null,
    totalBuyQty: asNumber(entry.total_buy_quantity),
    totalSellQty: asNumber(entry.total_sell_quantity),
    depthBuy: depthToList(depth.buy),
    depthSell: depthToList(depth.sell),
    avgPrice: asNumber(entry.average_price),
    lastQty: asNumber(entry.last_quantity),
    upperCircuit: asNumber(entry.upper_circuit_limit ?? entry.upper_circuit),
    lowerCircuit: asNumber(entry.lower_circuit_limit ?? entry.lower_circuit),
    sourceTs,
    receivedAt,
    freshnessMs: sourceTs !== null ? receivedAt - sourceTs : null,
    quoteVersion: "V2",
    prevCloseSource: prevClose !== null ? "ohlc.close" : "none",
  };
}

export interface QuoteMapResult {
  map: Record<string, Record<string, unknown>>;
  version: "V3" | "V2" | "NONE";
  status: "LIVE" | "PARTIAL" | "STALE" | "UNAVAILABLE" | "INVALID" | "DISCONNECTED";
  message: string;
  /** Keys that were requested but for which no record could be identified. */
  missingKeys: string[];
  /** How each requested key was identified in the response. */
  matchedBy: Record<string, string>;
  /** Endpoint that produced the returned map. */
  endpoint: string;
  httpStatus: number | null;
  errorCode: string | null;
  /** Failure detail for the V3 attempt, retained even when V2 succeeded. */
  v3Error: string | null;
  v3HttpStatus: number | null;
  v2Error: string | null;
  receivedAt: number;
}

/**
 * Normalises a response key so "NSE_INDEX|Nifty 50", "NSE_INDEX:Nifty 50" and
 * "NSE_INDEX: Nifty 50" all match. Whitespace is collapsed but never ignored:
 * "Nifty 50" and "Nifty500" remain distinct, so no index can be mismatched.
 */
function normalizeQuoteKey(k: string): string {
  // Upstox emits "NSE_INDEX: Nifty 50" (space after the colon) for indices while the
  // instrument master publishes "NSE_INDEX|Nifty 50". Separators and whitespace are
  // therefore both discarded. Alphanumerics still have to match exactly, so
  // "Nifty 50" → NIFTY50 can never collide with "Nifty 500" → NIFTY500, and
  // "SENSEX" ≠ "SENSEX50".
  return k.replace(/[|:\s]+/g, "").toUpperCase();
}

export async function fetchQuoteMap(keys: string[]): Promise<QuoteMapResult> {
  const receivedAt = Date.now();
  if (keys.length === 0) {
    return {
      map: {}, version: "NONE", status: "UNAVAILABLE",
      message: "No instrument keys supplied", missingKeys: [], matchedBy: {}, endpoint: "",
      httpStatus: null, errorCode: null, v3Error: null, v3HttpStatus: null, v2Error: null, receivedAt,
    };
  }

  const extractMap = (payload: unknown): Record<string, Record<string, unknown>> => {
    const out: Record<string, Record<string, unknown>> = {};
    const data = (payload as { data?: unknown } | null)?.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (v && typeof v === "object") out[k] = v as Record<string, unknown>;
      }
    }
    return out;
  };

  /** Resolves every requested key against a response map, using full identity matching. */
  const resolveAll = (map: Record<string, Record<string, unknown>>) => {
    const matched: Record<string, Record<string, unknown>> = {};
    const matchedBy: Record<string, string> = {};
    const unresolved: string[] = [];
    for (const k of keys) {
      const m = matchQuoteEntry(map, k);
      if (m.entry) {
        matched[k] = m.entry;
        matchedBy[k] = m.matchedBy as string;
      } else {
        unresolved.push(k);
      }
    }
    return { matched, matchedBy, unresolved, responseKeys: Object.keys(map) };
  };

  let v3Error: string | null = null;
  let v3HttpStatus: number | null = null;
  let v3Code: string | null = null;

  // ---- Attempt 1: GET /v3/market-quote/quotes ----
  try {
    const res = await upstoxRequest<{ data?: Record<string, Record<string, unknown>> }>({
      path: "/v3/market-quote/quotes",
      token: getToken(),
      query: { instrument_key: keys.join(",") },
      minIntervalMs: 1200,
      critical: false,
    });
    const map = extractMap(res.data);
    const { matched, matchedBy, unresolved, responseKeys } = resolveAll(map);
    if (Object.keys(matched).length === 0) {
      v3Error =
        `GET /v3/market-quote/quotes returned HTTP ${res.status} with ${responseKeys.length} response record(s) but none could be identified as the requested instrument(s). ` +
        `Requested: ${keys.join(", ")}. Response keys: ${responseKeys.slice(0, 5).join(" | ") || "none"}.`;
      v3HttpStatus = res.status;
      // fall through to V2
    } else {
      // Re-key the result by the REQUESTED key so callers can look up deterministically.
      return {
        map: matched,
        version: "V3",
        status: unresolved.length === 0 ? "LIVE" : "PARTIAL",
        message: `GET /v3/market-quote/quotes — ${Object.keys(matched).length}/${keys.length} instrument(s) identified${unresolved.length > 0 ? `, unmatched: ${unresolved.join(", ")}` : ""} (${res.elapsedMs}ms)`,
        missingKeys: unresolved,
        matchedBy,
        endpoint: "/v3/market-quote/quotes",
        httpStatus: res.status,
        errorCode: null,
        v3Error: null,
        v3HttpStatus: res.status,
        v2Error: null,
        receivedAt: res.receivedAt,
      };
    }
  } catch (err) {
    const f = failureToModuleStatus(err);
    const e = err as { status?: number | null; code?: string | null };
    v3Error = f.message;
    v3HttpStatus = e.status ?? null;
    v3Code = e.code ?? null;
  }

  // ---- Attempt 2: GET /v2/market-quote/quotes ----
  try {
    const res = await upstoxRequest<{ data?: Record<string, Record<string, unknown>> }>({
      path: "/v2/market-quote/quotes",
      token: getToken(),
      query: { instrument_key: keys.join(",") },
      minIntervalMs: 1200,
      critical: false,
    });
    const map = extractMap(res.data);
    const { matched, matchedBy, unresolved, responseKeys } = resolveAll(map);
    if (Object.keys(matched).length === 0) {
      return {
        map: {},
        version: "NONE",
        status: "UNAVAILABLE",
        message: `Both quote endpoints failed to identify the requested instrument(s). V3: ${v3Error} V2: HTTP ${res.status} with ${responseKeys.length} record(s) — keys: ${responseKeys.slice(0, 5).join(" | ") || "none"}.`,
        missingKeys: keys,
        matchedBy: {},
        endpoint: "/v2/market-quote/quotes",
        httpStatus: res.status,
        errorCode: null,
        v3Error,
        v3HttpStatus,
        v2Error: `HTTP ${res.status} with ${responseKeys.length} record(s) but no identity match`,
        receivedAt: res.receivedAt,
      };
    }
    return {
      map: matched,
      version: "V2",
      status: unresolved.length === 0 ? "LIVE" : "PARTIAL",
      message: `V3 failed (${v3Error}); GET /v2/market-quote/quotes identified ${Object.keys(matched).length}/${keys.length} instrument(s)${unresolved.length > 0 ? `, unmatched: ${unresolved.join(", ")}` : ""}`,
      missingKeys: unresolved,
      matchedBy,
      endpoint: "/v2/market-quote/quotes",
      httpStatus: res.status,
      errorCode: null,
      v3Error,
      v3HttpStatus,
      v2Error: null,
      receivedAt: res.receivedAt,
    };
  } catch (errV2) {
    const f = failureToModuleStatus(errV2);
    const e = errV2 as { status?: number | null; code?: string | null };
    return {
      map: {},
      version: "NONE",
      status: f.status as "UNAVAILABLE",
      message: `V3 failed: ${v3Error}${v3Code ? ` [${v3Code}]` : ""} | V2 failed: ${f.message}${f.code ? ` [${f.code}]` : ""}`,
      missingKeys: keys,
      matchedBy: {},
      endpoint: "/v2/market-quote/quotes",
      httpStatus: e.status ?? null,
      errorCode: e.code ?? null,
      v3Error,
      v3HttpStatus,
      v2Error: f.message,
      receivedAt,
    };
  }
}

export interface SpotQuoteResult {
  quote: SpotQuote | null;
  status: "LIVE" | "PARTIAL" | "STALE" | "UNAVAILABLE" | "INVALID" | "DISCONNECTED";
  message: string;
  depthAvailable: boolean;
  /** Instrument key that actually produced the quote. */
  resolvedKey: string | null;
  /** Previous-close source actually used. */
  prevCloseSource: "prev_close_price" | "ohlc.close" | "none";
  /** Keys that were probed but returned no entry. */
  attemptedKeys: string[];
  quoteResult: QuoteMapResult | null;
}

export async function getSpotQuote(symbol: SymbolKey, overrideKey?: string): Promise<SpotQuoteResult> {
  const cfg = SYMBOL_CONFIGS[symbol];
  // Probe the canonical key first, then the documented alternates. This handles the
  // case where Upstox's quote service keys an index differently from its master.
  const keys = overrideKey ? [overrideKey] : Array.from(new Set([cfg.indexKey, ...cfg.alternateIndexKeys]));

  let last: QuoteMapResult | null = null;
  const attempted: string[] = [];

  for (const key of keys) {
    attempted.push(key);
    last = await fetchQuoteMap([key]);
    const entry = pickEntry(last.map, key);
    if (!entry) continue;

    const quote =
      last.version === "V3"
        ? buildQuoteFromV3(entry, { indexKey: key }, Date.now())
        : buildQuoteFromV2(entry, { indexKey: key }, Date.now());
    if (!quote || quote.ltp === null) continue;

    const depthAvailable = quote.depthBuy.length > 0 || quote.depthSell.length > 0;
    const suffix = last.version === "V2" ? ` (V3 unavailable: ${last.v3Error ?? "n/a"})` : "";
    return {
      quote,
      status: depthAvailable || quote.open !== null ? "LIVE" : "PARTIAL",
      message: `${last.message}${suffix} — key "${key}"${quote.prevCloseSource === "none" ? " ⚠ previous close unavailable, percentage change cannot be computed" : ""}`,
      depthAvailable,
      resolvedKey: key,
      prevCloseSource: quote.prevCloseSource,
      attemptedKeys: attempted,
      quoteResult: last,
    };
  }

  return {
    quote: null,
    status: last?.status ?? "UNAVAILABLE",
    message: `${last?.message ?? "No quote response"} — tried key(s): ${attempted.join(", ")}`,
    depthAvailable: false,
    resolvedKey: null,
    prevCloseSource: "none",
    attemptedKeys: attempted,
    quoteResult: last,
  };
}

export async function getQuoteForKeys(keys: string[]): Promise<{
  entries: Record<string, Record<string, unknown>>;
  version: "V3" | "V2" | "NONE";
  message: string;
  status: "LIVE" | "PARTIAL" | "STALE" | "UNAVAILABLE" | "INVALID" | "DISCONNECTED";
  missingKeys: string[];
  httpStatus: number | null;
  errorCode: string | null;
  v3Error: string | null;
  v2Error: string | null;
}> {
  const r = await fetchQuoteMap(keys);
  return {
    entries: r.map,
    version: r.version,
    message: r.message,
    status: r.status,
    missingKeys: r.missingKeys,
    httpStatus: r.httpStatus,
    errorCode: r.errorCode,
    v3Error: r.v3Error,
    v2Error: r.v2Error,
  };
}

export async function getMarketStatus(exchange: "NSE" | "BSE"): Promise<{
  status: string;
  message: string;
  marketStatus: string | null;
  graph: string | null;
}> {
  const token = getToken();
  try {
    const res = await upstoxRequest<{ data?: Record<string, unknown> }>({
      path: "/v2/market/status",
      token,
      query: { exchange },
      minIntervalMs: 20000,
      retries: 1,
      critical: false,
    });
    const arr = res.data?.data?.[exchange] as unknown;
    const first = Array.isArray(arr) ? (arr[0] as Record<string, unknown> | undefined) : undefined;
    const marketStatus = first ? String(first.market_status ?? first.status ?? "") : null;
    if (marketStatus === null) {
      return { status: "PARTIAL", message: `GET /v2/market/status returned no entry for ${exchange}`, marketStatus: null, graph: null };
    }
    return { status: "LIVE", message: "GET /v2/market/status", marketStatus, graph: first ? String(first.graph ?? "") : null };
  } catch (err) {
    const f = failureToModuleStatus(err);
    return { status: f.status, message: f.message, marketStatus: null, graph: null };
  }
}

/* ------------------------------------------------------------------ *
 * Candles (v3 native, v2 fallback + aggregation, range splitting)
 * ------------------------------------------------------------------ */

export function parseRows(payload: unknown): { rows: RawCandleRow[]; invalidRows: number; duplicates: number } {
  let candles: unknown[] = [];
  if (payload && typeof payload === "object" && "data" in (payload as Record<string, unknown>)) {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) {
      candles = data.every((r) => Array.isArray(r)) ? data : [];
    } else if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      if (Array.isArray(d.candles)) candles = d.candles;
      else if (d.candles && typeof d.candles === "object") {
        const inner = d.candles as Record<string, unknown>;
        if (Array.isArray(inner.candles)) candles = inner.candles;
      }
    }
  } else if (Array.isArray(payload)) {
    candles = payload;
  }

  const rows: RawCandleRow[] = [];
  let invalidRows = 0;
  const seen = new Set<number>();
  let duplicates = 0;

  for (const raw of candles) {
    if (!Array.isArray(raw) || raw.length < 5) {
      invalidRows += 1;
      continue;
    }
    const tsMs = parseTimestamp(raw[0]);
    const open = asNumber(raw[1]);
    const high = asNumber(raw[2]);
    const low = asNumber(raw[3]);
    const close = asNumber(raw[4]);
    const volume = raw.length > 5 ? asNumber(raw[5]) : null;
    const oi = raw.length > 6 ? asNumber(raw[6]) : null;

    if (
      tsMs === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      open <= 0 ||
      close <= 0 ||
      low <= 0 ||
      high < low ||
      high < Math.max(open, close) ||
      low > Math.min(open, close)
    ) {
      invalidRows += 1;
      continue;
    }
    if (volume !== null && volume < 0) {
      invalidRows += 1;
      continue;
    }
    if (seen.has(tsMs)) {
      duplicates += 1;
      continue;
    }
    seen.add(tsMs);
    rows.push({
      ts: tsMs,
      open,
      high,
      low,
      close,
      volume,
      openInterest: oi,
      volumeStatus: volume !== null && volume > 0 ? "VALID" : "UNAVAILABLE",
    });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return { rows, invalidRows, duplicates };
}

function v3Interval(tf: Timeframe): { unit: string; interval: string } {
  const minutes = TIMEFRAME_MINUTES[tf];
  return minutes >= 60 ? { unit: "hours", interval: String(minutes / 60) } : { unit: "minutes", interval: String(minutes) };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** IST parts for a timestamp (IST = UTC+05:30, no DST). */
export function istParts(ts: number): { date: string; minutes: number; weekday: number } {
  const shifted = new Date(ts + 5.5 * 3600000);
  const date = shifted.toISOString().slice(0, 10);
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const weekday = shifted.getUTCDay(); // 0=Sun … 6=Sat
  return { date, minutes, weekday };
}

/**
 * Whether the Indian regular session (09:15–15:30 IST, Mon–Fri) is open.
 * Used to distinguish "market closed" from a genuine data failure.
 */
export function isMarketOpenNow(ts = Date.now()): boolean {
  const { minutes, weekday } = istParts(ts);
  if (weekday === 0 || weekday === 6) return false;
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

/** Upstox caps 1–15 minute history at one month per request; windows are split into <=10 day chunks. */
function dateChunks(fromDate: Date, toDate: Date, maxDays: number): Array<{ from: Date; to: Date }> {
  const chunks: Array<{ from: Date; to: Date }> = [];
  let cursor = new Date(fromDate);
  while (cursor <= toDate) {
    const to = new Date(Math.min(cursor.getTime() + (maxDays - 1) * 86400000, toDate.getTime()));
    chunks.push({ from: new Date(cursor), to });
    cursor = new Date(to.getTime() + 86400000);
  }
  return chunks;
}

export async function fetchHistoryCandles(symbol: SymbolKey, tf: Timeframe, days: number): Promise<CandleFetchResult> {
  const cfg = SYMBOL_CONFIGS[symbol];
  const token = getToken();
  const { unit, interval } = v3Interval(tf);
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const minutes = TIMEFRAME_MINUTES[tf];
  const maxChunkDays = minutes <= 15 ? 10 : 60;
  const chunks = dateChunks(from, to, maxChunkDays);

  const windowRows: RawCandleRow[] = [];
  let windowInvalid = 0;
  let windowDupes = 0;
  const windowDetails: CandleWindowDetail[] = [];

  // Every window is requested independently and IN PARALLEL, and its outcome recorded.
  // A window with no candles is recorded as EMPTY (weekend/holiday), NOT as a failure,
  // so 450 good candles are never discarded because one window had no trading day.
  // Serialising these windows added a full round-trip of latency per extra window.
  await Promise.all(
    chunks.map(async (chunk) => {
      const path = `/v3/historical-candle/${encodeURIComponent(cfg.indexKey)}/${unit}/${interval}/${isoDate(chunk.to)}/${isoDate(chunk.from)}`;
      const detail: CandleWindowDetail = {
        from: isoDate(chunk.from),
        to: isoDate(chunk.to),
        endpoint: path,
        httpStatus: null,
        rowCount: 0,
        ok: false,
        errorCode: null,
        error: null,
        nonTrading: false,
      };
      try {
        const res = await upstoxRequest<unknown>({ path, token, minIntervalMs: 250, critical: false });
        detail.httpStatus = res.status;
        const parsed = parseRows(res.data);
        detail.rowCount = parsed.rows.length;
        windowRows.push(...parsed.rows);
        windowInvalid += parsed.invalidRows;
        windowDupes += parsed.duplicates;
        if (parsed.rows.length === 0) {
          detail.nonTrading = true;
          detail.ok = true;
          detail.error = "window contained no candles (non-trading day, or no data published for this interval)";
        } else {
          detail.ok = true;
        }
      } catch (err) {
        const f = failureToModuleStatus(err);
        detail.ok = false;
        detail.errorCode = (err as { code?: string | null }).code ?? null;
        detail.error = `${f.message}${f.code ? ` [${f.code}]` : ""}`;
      }
      windowDetails.push(detail);
    }),
  );

  const windows = windowDetails;
  const invalidRows = windowInvalid;
  const duplicates = windowDupes;
  const rows = windowRows;

  const windowsSucceeded = windows.filter((w) => w.ok && w.rowCount > 0).length;
  const windowsFailed = windows.filter((w) => !w.ok).length;
  const windowsEmpty = windows.filter((w) => w.ok && w.rowCount === 0).length;

  if (rows.length === 0) {
    // Every window failed → propagate the real error; every window was empty → report as such.
    if (windowsFailed > 0) {
      return {
        rows: [],
        status: "UNAVAILABLE",
        message: `GET /v3/historical-candle ${unit}/${interval} failed in all ${windows.length} window(s): ${windows.map((w) => `${w.from}..${w.to} → ${w.error}`).join("; ")}`,
        source: "none",
        invalidRows: 0,
        duplicates: 0,
        receivedAt: Date.now(),
        windows,
        windowsSucceeded: 0,
        windowsFailed,
        windowsEmpty,
      };
    }
  }

  const seen = new Set<number>();
  const deduped = rows.filter((r) => (seen.has(r.ts) ? false : (seen.add(r.ts), true))).sort((a, b) => a.ts - b.ts);
  const windowSummary = windows
    .map((w) => `${w.from}..${w.to}: ${w.ok ? (w.rowCount > 0 ? `${w.rowCount} rows` : `EMPTY${w.error ? ` (${w.error})` : ""}`) : `FAILED ${w.error}`}`)
    .join("; ");

  return {
    rows: deduped,
    status: windowsFailed > 0 || invalidRows > 0 ? "PARTIAL" : deduped.length > 0 ? "LIVE" : "UNAVAILABLE",
    message:
      `GET /v3/historical-candle ${unit}/${interval} — ${deduped.length} candles from ${windowsSucceeded} successful window(s)` +
      `${windowsEmpty > 0 ? `, ${windowsEmpty} empty (non-trading)` : ""}` +
      `${windowsFailed > 0 ? `, ${windowsFailed} FAILED: ${windows.filter((w) => !w.ok).map((w) => `${w.from}..${w.to} ${w.error}`).join("; ")}` : ""}` +
      ` [${windowSummary}]`,
    source: "upstox_v3",
    invalidRows,
    duplicates,
    receivedAt: Date.now(),
    windows,
    windowsSucceeded,
    windowsFailed,
    windowsEmpty,
  };
}

export async function fetchIntradayCandles(symbol: SymbolKey, tf: Timeframe): Promise<CandleFetchResult> {
  const cfg = SYMBOL_CONFIGS[symbol];
  const token = getToken();
  const { unit, interval } = v3Interval(tf);
  const path = `/v3/historical-candle/intraday/${encodeURIComponent(cfg.indexKey)}/${unit}/${interval}`;
  const detail: CandleWindowDetail = { from: "today", to: "today", endpoint: path, httpStatus: null, rowCount: 0, ok: false, errorCode: null, error: null, nonTrading: false };
  try {
    const res = await upstoxRequest<unknown>({ path, token, minIntervalMs: 1200, critical: false });
    detail.httpStatus = res.status;
    const parsed = parseRows(res.data);
    detail.rowCount = parsed.rows.length;
    if (parsed.rows.length === 0) {
      // An empty intraday response AFTER the session has ended is expected and is
      // NOT a data failure. Historical candles remain authoritative.
      const open = isMarketOpenNow();
      detail.ok = true;
      detail.nonTrading = !open;
      detail.error = open ? "no intraday candles published yet for this interval" : "market closed — no current-session intraday candles";
      return {
        rows: [],
        status: open ? "UNAVAILABLE" : "STALE",
        message: open
          ? `GET /v3/historical-candle/intraday ${unit}/${interval} returned 0 rows while the market is open — the exchange has not published this interval yet.`
          : `GET /v3/historical-candle/intraday ${unit}/${interval} returned 0 rows because the market is closed (session 09:15–15:30 IST). Last completed candle comes from the historical endpoint. This is expected, not a failure.`,
        source: "upstox_v3_intraday",
        invalidRows: parsed.invalidRows,
        duplicates: parsed.duplicates,
        receivedAt: Date.now(),
        windows: [detail],
        windowsSucceeded: 0,
        windowsFailed: 0,
        windowsEmpty: 1,
      };
    }
    detail.ok = true;
    return {
      rows: parsed.rows,
      status: "LIVE",
      message: `GET /v3/historical-candle/intraday ${unit}/${interval} — ${parsed.rows.length} candles`,
      source: "upstox_v3_intraday",
      invalidRows: parsed.invalidRows,
      duplicates: parsed.duplicates,
      receivedAt: Date.now(),
      windows: [detail],
      windowsSucceeded: 1,
      windowsFailed: 0,
      windowsEmpty: 0,
    };
  } catch (err) {
    const f = failureToModuleStatus(err);
    detail.ok = false;
    detail.error = f.message;
    detail.errorCode = (err as { code?: string | null }).code ?? null;
    return {
      rows: [],
      status: f.status as "UNAVAILABLE",
      message: `${f.message}${f.code ? ` [${f.code}]` : ""} (intraday candles are optional context — historical candles remain authoritative)`,
      source: "none",
      invalidRows: 0,
      duplicates: 0,
      receivedAt: Date.now(),
      windows: [detail],
      windowsSucceeded: 0,
      windowsFailed: 1,
      windowsEmpty: 0,
    };
  }
}

/** Session-anchored aggregation (anchor = first candle of the session). */
export function aggregateCandles(rows: RawCandleRow[], minutes: number): RawCandleRow[] {
  if (minutes <= 1 || rows.length === 0) return rows;
  const bucketMs = minutes * 60000;
  const out: RawCandleRow[] = [];
  let bucketStart: number | null = null;
  let current: RawCandleRow | null = null;
  for (const row of rows) {
    if (bucketStart === null || current === null || row.ts >= bucketStart + bucketMs) {
      bucketStart = row.ts;
      current = { ...row };
      out.push(current);
    } else {
      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.volume = current.volume !== null && row.volume !== null ? current.volume + row.volume : null;
      current.openInterest = row.openInterest ?? current.openInterest;
      current.volumeStatus = current.volumeStatus === "VALID" || row.volumeStatus === "VALID" ? "VALID" : "UNAVAILABLE";
    }
  }
  return out;
}

/** Merge history + intraday, deduplicate, keep chronological order. */
export function mergeCandleSets(...sets: CandleFetchResult[]): {
  rows: RawCandleRow[];
  invalidRows: number;
  duplicates: number;
  sources: string[];
  messages: string[];
} {
  const seen = new Set<number>();
  const rows: RawCandleRow[] = [];
  let invalidRows = 0;
  let duplicates = 0;
  const sources: string[] = [];
  const messages: string[] = [];
  for (const set of sets) {
    if (set.source !== "none") sources.push(set.source);
    messages.push(set.message);
    invalidRows += set.invalidRows;
    duplicates += set.duplicates;
    for (const row of set.rows) {
      if (seen.has(row.ts)) {
        duplicates += 1;
        continue;
      }
      seen.add(row.ts);
      rows.push(row);
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  return { rows, invalidRows, duplicates, sources: Array.from(new Set(sources)), messages };
}

/* ------------------------------------------------------------------ *
 * Option chain
 * ------------------------------------------------------------------ */

export interface OptionChainLeg {
  instrumentKey: string | null;
  ltp: number | null;
  prevClose: number | null;
  volume: number | null;
  oi: number | null;
  prevOi: number | null;
  bidPrice: number | null;
  bidQty: number | null;
  askPrice: number | null;
  askQty: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  pop: number | null;
}

export interface OptionChainStrike {
  strike: number;
  expiry: string;
  pcr: number | null;
  spot: number | null;
  ce: OptionChainLeg;
  pe: OptionChainLeg;
}

export interface OptionChainDiagnostics {
  underlyingKey: string;
  expiry: string;
  /** Endpoint actually used. */
  endpoint: string;
  httpStatus: number | null;
  /** Upstox `status` field from the response body. */
  apiStatus: string | null;
  /** Raw number of rows in the response `data` container. */
  rawRowCount: number;
  /** Parsed strike count. */
  strikeCount: number;
  firstStrike: number | null;
  lastStrike: number | null;
  ceContractCount: number;
  peContractCount: number;
  /** Distinct field-availability counts across the parsed chain. */
  fieldAvailability: {
    ltp: number; oi: number; prevOi: number; volume: number;
    bidPrice: number; askPrice: number; bidQty: number; askQty: number;
    delta: number; gamma: number; theta: number; vega: number; iv: number; pop: number;
  };
  /** Response shape detected, for diagnosing mapping problems. */
  responseShape: string;
  errorCode: string | null;
  error: string | null;
}

export interface OptionChainResult {
  strikes: OptionChainStrike[];
  status: "LIVE" | "PARTIAL" | "STALE" | "UNAVAILABLE" | "INVALID" | "DISCONNECTED";
  message: string;
  greeksAvailable: boolean;
  bidAskQtyAvailable: boolean;
  receivedAt: number;
  rawRowCount: number;
  diagnostics: OptionChainDiagnostics;
}

function parseLeg(raw: unknown): OptionChainLeg {
  const leg = (raw ?? {}) as Record<string, unknown>;
  const md = (leg.market_data ?? {}) as Record<string, unknown>;
  const greeks = (leg.option_greeks ?? {}) as Record<string, unknown>;
  return {
    instrumentKey: typeof leg.instrument_key === "string" ? leg.instrument_key : null,
    ltp: asNumber(md.ltp),
    prevClose: asNumber(md.close_price),
    volume: asNumber(md.volume),
    oi: asNumber(md.oi),
    prevOi: asNumber(md.prev_oi),
    bidPrice: asNumber(md.bid_price),
    bidQty: asNumber(md.bid_qty),
    askPrice: asNumber(md.ask_price),
    askQty: asNumber(md.ask_qty),
    delta: asNumber(greeks.delta),
    gamma: asNumber(greeks.gamma),
    theta: asNumber(greeks.theta),
    vega: asNumber(greeks.vega),
    iv: asNumber(greeks.iv),
    pop: asNumber(greeks.pop),
  };
}

export async function fetchOptionChain(symbol: SymbolKey, expiry: string, underlyingKeyOverride?: string): Promise<OptionChainResult> {
  const cfg = SYMBOL_CONFIGS[symbol];
  const underlyingKey = underlyingKeyOverride ?? cfg.indexKey;
  const token = getToken();
  const endpoint = "/v2/option/chain";
  const startedAt = Date.now();

  const diag: OptionChainDiagnostics = {
    underlyingKey,
    expiry,
    endpoint,
    httpStatus: null,
    apiStatus: null,
    rawRowCount: 0,
    strikeCount: 0,
    firstStrike: null,
    lastStrike: null,
    ceContractCount: 0,
    peContractCount: 0,
    fieldAvailability: { ltp: 0, oi: 0, prevOi: 0, volume: 0, bidPrice: 0, askPrice: 0, bidQty: 0, askQty: 0, delta: 0, gamma: 0, theta: 0, vega: 0, iv: 0, pop: 0 },
    responseShape: "unknown",
    errorCode: null,
    error: null,
  };

  /**
   * Extracts the strike array from the response.
   *
   * DOCUMENTED SHAPE: `{ status, data: [ { strike_price, call_options, put_options }, ... ] }`
   * — `data` IS the strike array. The previous implementation read `data.data`,
   * which does not exist in this response, so every real chain was discarded as
   * "no strike rows" despite HTTP 200. Both shapes are tolerated here.
   */
  const extractStrikes = (payload: unknown): { rows: unknown[]; shape: string; apiStatus: string | null } => {
    if (!payload || typeof payload !== "object") return { rows: [], shape: "non-object", apiStatus: null };
    const body = payload as Record<string, unknown>;
    const apiStatus = typeof body.status === "string" ? body.status : null;
    const data = body.data;
    if (Array.isArray(data)) return { rows: data, shape: "data:[] (documented)", apiStatus };
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      for (const k of ["data", "strikes", "chain"]) {
        if (Array.isArray(d[k])) return { rows: d[k] as unknown[], shape: `data.${k}:[]`, apiStatus };
      }
      // Some responses return a strike-keyed map rather than an array.
      const vals = Object.values(d).filter((v) => v && typeof v === "object");
      if (vals.length > 0) return { rows: vals, shape: "data:{strike-map}", apiStatus };
    }
    return { rows: [], shape: "unrecognized", apiStatus };
  };

  try {
    const res = await upstoxRequest<unknown>({
      path: endpoint,
      token,
      query: { instrument_key: underlyingKey, expiry_date: expiry },
      minIntervalMs: 1500,
      critical: false,
    });
    diag.httpStatus = res.status;

    const { rows, shape, apiStatus } = extractStrikes(res.data);
    diag.responseShape = shape;
    diag.apiStatus = apiStatus;
    diag.rawRowCount = rows.length;

    if (rows.length === 0) {
      diag.error = `HTTP ${res.status} (api status: ${apiStatus ?? "n/a"}, shape ${shape}) contained 0 strike rows for underlying ${underlyingKey} expiry ${expiry}`;
      return {
        strikes: [],
        status: "UNAVAILABLE",
        message: `${endpoint} returned HTTP ${res.status} for expiry ${expiry} with 0 strike rows (response shape ${shape}, api status ${apiStatus ?? "n/a"}). Underlying key sent: ${underlyingKey}.`,
        greeksAvailable: false,
        bidAskQtyAvailable: false,
        receivedAt: res.receivedAt,
        rawRowCount: 0,
        diagnostics: diag,
      };
    }

    const strikes: OptionChainStrike[] = [];
    let greeksAvailable = false;
    let bidAskQtyAvailable = false;
    let malformedRows = 0;

    for (const raw of rows) {
      const row = (raw ?? {}) as Record<string, unknown>;
      const strike = asNumber(row.strike_price) ?? asNumber(row.strike);
      if (strike === null) {
        malformedRows += 1;
        continue;
      }
      const ceRaw = (row.call_options ?? row.ce ?? null) as unknown;
      const peRaw = (row.put_options ?? row.pe ?? null) as unknown;
      const ce = parseLeg(ceRaw);
      const pe = parseLeg(peRaw);
      // Greeks are mapped strictly to their own side: CE Greeks never populate PE.
      if (ce.delta !== null || ce.iv !== null || ce.gamma !== null) greeksAvailable = true;
      if (pe.delta !== null || pe.iv !== null || pe.gamma !== null) greeksAvailable = true;
      if (ce.bidQty !== null || ce.askQty !== null || pe.bidQty !== null || pe.askQty !== null) bidAskQtyAvailable = true;

      // Field availability counts (per contract, so CE and PE are tracked separately).
      const fa = diag.fieldAvailability;
      for (const [leg, side] of [[ce, "ce"], [pe, "pe"]] as const) {
        void side;
        if (leg.ltp !== null) fa.ltp += 1;
        if (leg.oi !== null) fa.oi += 1;
        if (leg.prevOi !== null) fa.prevOi += 1;
        if (leg.volume !== null) fa.volume += 1;
        if (leg.bidPrice !== null) fa.bidPrice += 1;
        if (leg.askPrice !== null) fa.askPrice += 1;
        if (leg.bidQty !== null) fa.bidQty += 1;
        if (leg.askQty !== null) fa.askQty += 1;
        if (leg.delta !== null) fa.delta += 1;
        if (leg.gamma !== null) fa.gamma += 1;
        if (leg.theta !== null) fa.theta += 1;
        if (leg.vega !== null) fa.vega += 1;
        if (leg.iv !== null) fa.iv += 1;
        if (leg.pop !== null) fa.pop += 1;
      }
      if (ce.instrumentKey) diag.ceContractCount += 1;
      if (pe.instrumentKey) diag.peContractCount += 1;

      strikes.push({
        strike,
        expiry: typeof row.expiry === "string" ? row.expiry.slice(0, 10) : expiry,
        pcr: asNumber(row.pcr),
        spot: asNumber(row.underlying_spot_price) ?? asNumber(row.underlying_spot),
        ce,
        pe,
      });
    }

    strikes.sort((a, b) => a.strike - b.strike);
    diag.strikeCount = strikes.length;
    diag.firstStrike = strikes.length > 0 ? strikes[0].strike : null;
    diag.lastStrike = strikes.length > 0 ? strikes[strikes.length - 1].strike : null;
    diag.error = malformedRows > 0 ? `${malformedRows} row(s) had no strike_price and were skipped` : null;

    const pricedStrikes = strikes.filter((st) => st.ce.ltp !== null || st.pe.ltp !== null).length;
    if (strikes.length === 0) {
      return {
        strikes: [],
        status: "INVALID",
        message: `${endpoint} returned ${diag.rawRowCount} row(s) for expiry ${expiry} but none contained a strike_price (shape ${shape}).`,
        greeksAvailable: false,
        bidAskQtyAvailable: false,
        receivedAt: res.receivedAt,
        rawRowCount: diag.rawRowCount,
        diagnostics: diag,
      };
    }

    return {
      strikes,
      status: pricedStrikes === 0 ? "PARTIAL" : greeksAvailable ? "LIVE" : "PARTIAL",
      message:
        `${endpoint} — ${strikes.length} strikes for expiry ${expiry} (CE keys ${diag.ceContractCount}, PE keys ${diag.peContractCount}, priced ${pricedStrikes}). ` +
        (greeksAvailable
          ? `Greeks present (${diag.fieldAvailability.delta} delta values across CE+PE).`
          : `No option_greeks values returned — option data is shown, Greeks are NOT estimated.`),
      greeksAvailable,
      bidAskQtyAvailable,
      receivedAt: res.receivedAt,
      rawRowCount: diag.rawRowCount,
      diagnostics: diag,
    };
  } catch (err) {
    const f = failureToModuleStatus(err);
    const e = err as { status?: number | null; code?: string | null };
    diag.error = f.message;
    diag.errorCode = e.code ?? null;
    return {
      strikes: [],
      status: f.status as "UNAVAILABLE",
      message: `${f.message}${f.code ? ` [${f.code}]` : ""} — underlying ${underlyingKey}, expiry ${expiry}`,
      greeksAvailable: false,
      bidAskQtyAvailable: false,
      receivedAt: startedAt,
      rawRowCount: 0,
      diagnostics: diag,
    };
  }
}

export { UpstoxError };
