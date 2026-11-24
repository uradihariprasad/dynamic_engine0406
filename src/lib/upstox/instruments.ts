import { gunzipSync } from "node:zlib";

import { SYMBOL_CONFIGS, type SymbolKey } from "@/lib/config";
import { UpstoxError, upstoxRequest, failureToModuleStatus } from "@/lib/upstox/client";

/* ------------------------------------------------------------------ *
 * Instrument master
 * ------------------------------------------------------------------ */

export interface InstrumentRow {
  instrumentKey: string;
  tradingSymbol: string;
  name: string;
  /** Canonical underlying symbol (e.g. "NIFTY", "SENSEX") — used for exact matching. */
  underlyingSymbol: string;
  instrumentType: string;
  exchange: string;
  expiry: string | null;
  strike: number | null;
  lotSize: number | null;
  tickSize: number | null;
}

export interface MasterDownloadReport {
  exchange: string;
  url: string;
  ok: boolean;
  httpStatus: number | null;
  contentType: string | null;
  contentEncoding: string | null;
  bytes: number | null;
  gzipDecompressed: boolean;
  parseOk: boolean;
  totalRecords: number;
  parseError: string | null;
  at: number;
}

const masterCache = new Map<string, { rows: InstrumentRow[]; report: MasterDownloadReport; loadedAt: number }>();
const MASTER_TTL_MS = 12 * 60 * 60 * 1000;

function str(row: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
}

function num(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // The master publishes `expiry` as epoch milliseconds (e.g. 1796927399000).
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  }
  if (typeof value === "string") {
    if (!value) return null;
    if (/^\d{10,13}$/.test(value)) {
      const num = Number(value);
      const ms = num < 1e12 ? num * 1000 : num;
      const d = new Date(ms);
      return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Authoritative instrument master.
 *
 * Upstox publishes one full master containing every segment (equity, index,
 * futures, options, currency, commodity). Segment-specific files such as
 * `NSE_FO.json.gz` do NOT exist — they return HTTP 403 — so the full master is
 * the only correct source for futures and options.
 */
export const MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

/** Detects the gzip magic bytes (1f 8b) — the CDN serves the file as application/gzip WITHOUT a Content-Encoding header, so fetch does not auto-decompress it. */
function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * Downloads and parses one exchange instrument master.
 * Errors are ALWAYS reported through the returned report — never swallowed.
 */
export async function loadMaster(): Promise<{ rows: InstrumentRow[]; report: MasterDownloadReport }> {
  const cached = masterCache.get("complete");
  if (cached && Date.now() - cached.loadedAt < MASTER_TTL_MS) {
    return { rows: cached.rows, report: { ...cached.report, at: Date.now() } };
  }
  const url = MASTER_URL;
  const report: MasterDownloadReport = {
    exchange: "complete",
    url,
    ok: false,
    httpStatus: null,
    contentType: null,
    contentEncoding: null,
    bytes: null,
    gzipDecompressed: false,
    parseOk: false,
    totalRecords: 0,
    parseError: null,
    at: Date.now(),
  };

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(90000), cache: "no-store" });
    report.httpStatus = res.status;
    report.contentType = res.headers.get("content-type");
    report.contentEncoding = res.headers.get("content-encoding");
    if (!res.ok) {
      report.parseError = `HTTP ${res.status} downloading instrument master`;
      throw new UpstoxError({ kind: "SERVER", message: report.parseError, status: res.status });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    report.bytes = buf.byteLength;

    let text: string;
    if (isGzip(buf)) {
      try {
        text = gunzipSync(buf).toString("utf8");
        report.gzipDecompressed = true;
      } catch (err) {
        report.parseError = `gzip decompression failed: ${err instanceof Error ? err.message : String(err)}`;
        throw new UpstoxError({ kind: "BAD_RESPONSE", message: report.parseError });
      }
    } else {
      text = buf.toString("utf8");
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      report.parseError = `JSON parse failed (${text.length} chars, starts "${text.slice(0, 24)}"): ${err instanceof Error ? err.message : String(err)}`;
      throw new UpstoxError({ kind: "BAD_RESPONSE", message: report.parseError });
    }

    const list = Array.isArray(json)
      ? json
      : json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)
        ? ((json as { data: unknown[] }).data)
        : null;
    if (!list) {
      report.parseError = "Unexpected instrument master payload shape (expected an array)";
      throw new UpstoxError({ kind: "BAD_RESPONSE", message: report.parseError });
    }

    const rows: InstrumentRow[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const key = str(row, ["instrument_key", "instrumentToken", "instrument_token"]);
      if (!key) continue;
      const expiryRaw = row.expiry ?? row.expiry_date ?? row.expiryDate;
      rows.push({
        instrumentKey: key,
        tradingSymbol: str(row, ["trading_symbol", "tradingsymbol", "symbol"]),
        name: str(row, ["name", "underlying", "company_name"]),
        underlyingSymbol: str(row, ["underlying_symbol", "asset_symbol", "underlying"]),
        instrumentType: str(row, ["instrument_type", "instrumentType", "asset_class"]),
        exchange: str(row, ["exchange", "segment"]),
        expiry: toIsoDate(expiryRaw),
        strike: num(row, ["strike_price", "strike"]),
        lotSize: num(row, ["lot_size", "lot_quantity", "market_lot"]),
        tickSize: num(row, ["tick_size"]),
      });
    }
    report.ok = true;
    report.parseOk = true;
    report.totalRecords = rows.length;
    masterCache.set("complete", { rows, report, loadedAt: Date.now() });
    return { rows, report };
  } catch (err) {
    if (report.parseError === null) {
      report.parseError = err instanceof Error ? err.message : String(err);
    }
    throw new UpstoxError({
      kind: err instanceof UpstoxError ? err.kind : "NETWORK",
      message: `Instrument master (complete): ${report.parseError}`,
      status: report.httpStatus,
    });
  }
}

export interface MasterState {
  reports: MasterDownloadReport[];
  rows: number;
  errors: string[];
}

async function loadMasters(): Promise<{ rows: InstrumentRow[]; reports: MasterDownloadReport[]; errors: string[] }> {
  try {
    const r = await loadMaster();
    return { rows: r.rows, reports: [r.report], errors: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      rows: [],
      reports: [
        {
          exchange: "complete",
          url: MASTER_URL,
          ok: false,
          httpStatus: null,
          contentType: null,
          contentEncoding: null,
          bytes: null,
          gzipDecompressed: false,
          parseOk: false,
          totalRecords: 0,
          parseError: msg,
          at: Date.now(),
        },
      ],
      errors: [msg],
    };
  }
}

export async function getInstrumentRows(): Promise<InstrumentRow[]> {
  const { rows } = await loadMasters();
  return rows;
}

export async function getMasterState(): Promise<MasterState> {
  const { rows, reports, errors } = await loadMasters();
  return { reports, rows: rows.length, errors };
}

export interface IndexInstrumentInfo {
  /** Canonical application symbol (NIFTY | SENSEX). */
  canonicalSymbol: SymbolKey;
  /** Instrument key actually used for API calls. */
  instrumentKey: string;
  /** Key as published by the instrument master, when it differs. */
  masterInstrumentKey: string | null;
  /** trading_symbol from the master row. */
  tradingSymbol: string | null;
  /** name from the master row. */
  instrumentName: string | null;
  /** Exchange segment of the verified row (e.g. BSE_INDEX). */
  segment: string | null;
  verified: boolean;
  lotSize: number | null;
  tickSize: number | null;
  status: "LIVE" | "UNAVAILABLE";
  /** Where the key came from. */
  source: "INSTRUMENT_MASTER" | "DOCUMENTED_FALLBACK" | "UNAVAILABLE";
  /** Other candidate keys considered. */
  candidates: string[];
  /** All alternates that will be probed if the canonical key returns no quote. */
  probeKeys: string[];
  reason: string | null;
}

/**
 * Resolves and verifies the index instrument key against the downloaded master.
 * NIFTY and SENSEX are resolved completely independently — no shared state.
 */
export async function resolveIndexInstrument(symbol: SymbolKey): Promise<IndexInstrumentInfo> {
  const cfg = SYMBOL_CONFIGS[symbol];
  let rows: InstrumentRow[] = [];
  let masterError: string | null = null;
  try {
    rows = await getInstrumentRows();
  } catch (err) {
    masterError = err instanceof Error ? err.message : String(err);
  }

  const indexRows = rows.filter((r) => r.instrumentType.toUpperCase() === "INDEX");
  const wanted = cfg.indexName.toLowerCase();

  // Exact identity only. Prefix matching must never be used: "SENSEX50" is a
  // different index from "SENSEX".
  const exact =
    indexRows.find((r) => r.instrumentKey === cfg.indexKey) ??
    indexRows.find((r) => r.underlyingSymbol.toUpperCase() === cfg.underlyingName && r.instrumentKey.startsWith(`${cfg.exchange}_INDEX|`)) ??
    indexRows.find((r) => r.name.toLowerCase() === wanted) ??
    indexRows.find((r) => r.tradingSymbol.toUpperCase() === cfg.underlyingName);

  const candidates = indexRows
    .filter((r) => r.name.toLowerCase().includes(wanted.split(" ")[0]) || r.tradingSymbol.toUpperCase().includes(cfg.underlyingName))
    .map((r) => `${r.instrumentKey} (${r.tradingSymbol} / ${r.name})`)
    .slice(0, 12);

  const probeKeys = Array.from(new Set([cfg.indexKey, ...cfg.alternateIndexKeys]));

  if (!exact) {
    return {
      canonicalSymbol: symbol,
      instrumentKey: cfg.indexKey,
      masterInstrumentKey: null,
      tradingSymbol: null,
      instrumentName: null,
      segment: null,
      verified: false,
      lotSize: null,
      tickSize: null,
      status: "UNAVAILABLE",
      source: "DOCUMENTED_FALLBACK",
      candidates,
      probeKeys,
      reason:
        masterError
          ? `Instrument master unavailable: ${masterError}. Using documented key as fallback.`
          : `No INDEX row exactly matching key "${cfg.indexKey}" or underlying "${cfg.underlyingName}" in the master. Using documented key as fallback.`,
    };
  }

  return {
    canonicalSymbol: symbol,
    // API calls use the verified master key.
    instrumentKey: exact.instrumentKey,
    masterInstrumentKey: exact.instrumentKey,
    tradingSymbol: exact.tradingSymbol,
    instrumentName: exact.name,
    segment: exact.exchange,
    verified: true,
    lotSize: exact.lotSize,
    tickSize: exact.tickSize,
    status: "LIVE",
    source: "INSTRUMENT_MASTER",
    candidates,
    probeKeys: Array.from(new Set([exact.instrumentKey, ...cfg.alternateIndexKeys])),
    reason: null,
  };
}

/** Back-compat wrapper. */
export async function resolveIndexKey(symbol: SymbolKey): Promise<string> {
  return (await resolveIndexInstrument(symbol)).instrumentKey;
}

export interface FutureInstrumentInfo {
  instrumentKey: string;
  tradingSymbol: string;
  expiry: string;
  lotSize: number | null;
  tickSize: number | null;
}

export interface FuturesResolution {
  contracts: FutureInstrumentInfo[];
  status: "LIVE" | "UNAVAILABLE";
  reason: string | null;
  totalFuturesRows: number;
}

/** Nearest / expiry-specific index futures contract (NSE_FO for NIFTY, BSE_FO for SENSEX). */
export async function resolveFuturesDetailed(symbol: SymbolKey): Promise<FuturesResolution> {
  const cfg = SYMBOL_CONFIGS[symbol];
  let rows: InstrumentRow[] = [];
  let reason: string | null = null;
  try {
    rows = await getInstrumentRows();
  } catch (err) {
    reason = `Instrument master unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }

  const today = new Date().toISOString().slice(0, 10);
  const underlying = cfg.underlyingName.toUpperCase();
  // Futures rows live in the full master keyed by segment prefix in instrument_key.
  const futuresRows = rows.filter(
    (r) => r.instrumentType.toUpperCase() === "FUT" && r.instrumentKey.toUpperCase().startsWith(`${cfg.derivativesExchange}|`),
  );
  // Exact underlying identity only: "SENSEX50" must never match "SENSEX".
  const matched = futuresRows.filter((r) => {
    const candidates = [r.underlyingSymbol, r.name, r.tradingSymbol].map((v) => v.toUpperCase());
    return candidates.includes(underlying);
  });

  const contracts = matched
    .filter((r) => r.expiry !== null && r.expiry >= today)
    .map((r) => ({
      instrumentKey: r.instrumentKey,
      tradingSymbol: r.tradingSymbol,
      expiry: r.expiry as string,
      lotSize: r.lotSize,
      tickSize: r.tickSize,
    }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry));

  const seen = new Set<string>();
  const deduped = contracts.filter((f) => (seen.has(f.expiry) ? false : (seen.add(f.expiry), true)));

  if (deduped.length === 0) {
    return {
      contracts: [],
      status: "UNAVAILABLE",
      reason:
        reason ??
        (futuresRows.length === 0
          ? `No FUT rows found for ${cfg.derivativesExchange} in the instrument master.`
          : matched.length === 0
            ? `${futuresRows.length} futures rows exist for ${cfg.derivativesExchange} but none match underlying "${underlying}" exactly.`
            : `All ${matched.length} matching futures contracts are expired (today ${today}).`),
      totalFuturesRows: futuresRows.length,
    };
  }
  return { contracts: deduped, status: "LIVE", reason: null, totalFuturesRows: futuresRows.length };
}

export async function resolveFutures(symbol: SymbolKey): Promise<FutureInstrumentInfo[]> {
  return (await resolveFuturesDetailed(symbol)).contracts;
}

export interface OptionContractInfo {
  instrumentKey: string;
  tradingSymbol: string;
  strike: number;
  optionType: "CE" | "PE";
  expiry: string;
  lotSize: number | null;
  tickSize: number | null;
}

/** Official /v2/option/contract mapping for one expiry (used for lot size + trading symbol). */
export async function getOptionContracts(
  symbol: SymbolKey,
  expiry: string,
  token: string | null,
): Promise<OptionContractInfo[]> {
  const cfg = SYMBOL_CONFIGS[symbol];
  const res = await upstoxRequest<{ data?: unknown }>({
    path: "/v2/option/contract",
    token,
    query: { instrument_key: cfg.indexKey, expiry_date: expiry },
    minIntervalMs: 2500,
    critical: false,
  });
  const arr = (res.data?.data ?? null) as unknown;
  if (!Array.isArray(arr)) return [];
  const out: OptionContractInfo[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const type = str(row, ["instrument_type", "option_type"]).toUpperCase();
    if (type !== "CE" && type !== "PE") continue;
    const strike = num(row, ["strike_price", "strike"]);
    const key = str(row, ["instrument_key"]);
    if (strike === null || !key) continue;
    out.push({
      instrumentKey: key,
      tradingSymbol: str(row, ["tradingsymbol", "trading_symbol"]),
      strike,
      optionType: type,
      expiry: toIsoDate(str(row, ["expiry", "expiry_date"])) ?? expiry,
      lotSize: num(row, ["lot_size", "lot_quantity", "market_lot"]),
      tickSize: num(row, ["tick_size"]),
    });
  }
  return out;
}

/** Reads the CE/PE type from a contract row without building the full map entry. */
function contractMapEntryType(row: Record<string, unknown>): string {
  return str(row, ["instrument_type", "option_type"]).toUpperCase();
}

export interface ExpiryDiscovery {
  /** Chronologically sorted, non-expired expiries. */
  expiries: string[];
  /** Every distinct expiry seen, including past ones (for diagnostics). */
  allExpiries: string[];
  /** CE contract count per expiry (from contract discovery). */
  ceCounts: Record<string, number>;
  /** PE contract count per expiry (from contract discovery). */
  peCounts: Record<string, number>;
  /** Expiries that have BOTH CE and PE contracts — the only ones usable for a chain. */
  usableExpiries: string[];
  /** Source that produced the expiry list. */
  source: "INSTRUMENT_MASTER" | "OPTION_CONTRACT" | "EXPIRED_INSTRUMENTS_EXPIRIES" | "NONE";
  /** Entitlement restriction reported by Upstox, if any. */
  entitlementError: string | null;
  selectedExpiry: string | null;
  status: "LIVE" | "UNAVAILABLE";
  /** Endpoint actually used. */
  endpoint: string;
  /** Number of contract rows returned by Upstox. */
  contractRowCount: number;
  /** Distinct expiries found in those rows. */
  expiryCount: number;
  httpStatus: number | null;
  errorCode: string | null;
  message: string;
  reason: string | null;
  receivedAt: number;
}

/**
 * Expiry discovery via the DOCUMENTED endpoint GET /v2/option/contract.
 *
 * IMPORTANT: `/v2/option/expiry` is NOT a documented Upstox endpoint and must not
 * be used. The documented contract endpoint returns `data` as an ARRAY of contract
 * rows, each carrying an ISO `expiry` string. Omitting `expiry_date` returns all
 * listed contracts for the underlying, which is how we enumerate expiries.
 */
/**
 * Secondary, separately-documented expiry source: GET /v2/expired-instruments/expiries.
 * Upstox documents a UDAPI1149 response when an Upstox Plus subscription is required;
 * that entitlement failure is reported explicitly rather than hidden.
 */
async function discoverExpiriesViaExpiredEndpoint(
  symbol: SymbolKey,
  token: string | null,
): Promise<{ expiries: string[]; status: "LIVE" | "UNAVAILABLE"; message: string; entitlementError: string | null; errorCode: string | null; httpStatus: number | null }> {
  const cfg = SYMBOL_CONFIGS[symbol];
  const endpoint = "/v2/expired-instruments/expiries";
  try {
    const res = await upstoxRequest<{ data?: unknown }>({
      path: endpoint,
      token,
      query: { instrument_key: cfg.indexKey },
      minIntervalMs: 2000,
      critical: false,
    });
    const data = (res.data as { data?: unknown } | null)?.data;
    const rows: unknown[] = Array.isArray(data) ? data : Array.isArray((data as { expiries?: unknown[] })?.expiries) ? ((data as { expiries: unknown[] }).expiries) : [];
    const list = rows
      .map((r) => toIsoDate(typeof r === "string" ? r : (r as Record<string, unknown>)?.expiry ?? (r as Record<string, unknown>)?.date))
      .filter((v): v is string => v !== null);
    if (list.length === 0) {
      return { expiries: [], status: "UNAVAILABLE", message: `${endpoint} returned no parsable expiries for ${cfg.indexKey}`, entitlementError: null, errorCode: null, httpStatus: res.status };
    }
    const today = new Date().toISOString().slice(0, 10);
    return { expiries: [...new Set(list)].filter((e) => e >= today).sort(), status: "LIVE", message: `${endpoint} → ${list.length} expiries`, entitlementError: null, errorCode: null, httpStatus: res.status };
  } catch (err) {
    const f = failureToModuleStatus(err);
    const e = err as { status?: number | null; code?: string | null };
    const entitlement = e.code === "UDAPI1149" ? "Upstox Plus subscription required for this endpoint (UDAPI1149)" : null;
    return {
      expiries: [],
      status: "UNAVAILABLE",
      message: entitlement ? `${entitlement}` : f.message,
      entitlementError: entitlement,
      errorCode: e.code ?? null,
      httpStatus: e.status ?? null,
    };
  }
}

/**
 * Derives the expiry list and contract metadata from the ALREADY-DOWNLOADED instrument
 * master, at zero API cost.
 *
 * WHY THIS IS FIRST: calling GET /v2/option/contract WITHOUT an expiry filter returns
 * every listed contract for the underlying (~2,000 rows for NIFTY, ~3,700 for SENSEX)
 * across all expiries — a multi-megabyte payload that dominated the first-scan latency.
 * The instrument master already contains the identical information (strike, lot size,
 * trading symbol, instrument type, expiry) and is downloaded once and cached.
 */
async function discoverExpiriesFromMaster(symbol: SymbolKey): Promise<Omit<ExpiryDiscovery, "httpStatus" | "errorCode" | "receivedAt"> & { receivedAt: number }> {
  const cfg = SYMBOL_CONFIGS[symbol];
  const rows = await getInstrumentRows();
  const today = new Date().toISOString().slice(0, 10);
  const expiries = new Map<string, { ce: number; pe: number }>();
  const contractMap = new Map<string, { tradingSymbol: string; lotSize: number | null; instrumentType: string; strike: number | null }>();
  let malformed = 0;

  for (const r of rows) {
    if (!["CE", "PE"].includes(r.instrumentType.toUpperCase())) continue;
    if (r.underlyingSymbol.toUpperCase() !== cfg.underlyingName) continue;
    if (r.instrumentKey.toUpperCase().startsWith(`${cfg.derivativesExchange}|`) === false) continue;
    if (!r.expiry) { malformed += 1; continue; }
    const bucket = expiries.get(r.expiry) ?? { ce: 0, pe: 0 };
    if (r.instrumentType.toUpperCase() === "CE") bucket.ce += 1; else bucket.pe += 1;
    expiries.set(r.expiry, bucket);
    // Build the contract metadata map in the same pass — no extra API call.
    if (!contractMap.has(r.instrumentKey)) {
      contractMap.set(r.instrumentKey, {
        tradingSymbol: r.tradingSymbol,
        lotSize: r.lotSize,
        instrumentType: r.instrumentType.toUpperCase(),
        strike: r.strike,
      });
    }
  }

  contractMapCache.set(`${symbol}:${cfg.indexKey}`, { map: contractMap, at: Date.now() });

  const all = [...expiries.keys()].sort();
  const future = all.filter((e) => e >= today);
  const usable = future.filter((e) => (expiries.get(e)?.ce ?? 0) > 0 && (expiries.get(e)?.pe ?? 0) > 0);
  const selected = usable.length > 0 ? usable[0] : future.length > 0 ? future[0] : null;

  return {
    expiries: future,
    allExpiries: all,
    ceCounts: Object.fromEntries([...expiries.entries()].map(([e, v]) => [e, v.ce])),
    peCounts: Object.fromEntries([...expiries.entries()].map(([e, v]) => [e, v.pe])),
    usableExpiries: usable,
    source: "INSTRUMENT_MASTER",
    entitlementError: null,
    selectedExpiry: selected,
    status: future.length > 0 ? "LIVE" : "UNAVAILABLE",
    endpoint: "instrument master (complete.json.gz)",
    contractRowCount: contractMap.size,
    expiryCount: future.length,
    message:
      `Instrument master → ${contractMap.size} option contracts, ${future.length} future expiries, ${usable.length} with both CE and PE; selected ${selected}. Zero API calls required.`,
    reason: malformed > 0 ? `${malformed} rows had no expiry and were skipped.` : null,
    receivedAt: Date.now(),
  };
}

export async function discoverExpiries(symbol: SymbolKey, token: string | null): Promise<ExpiryDiscovery> {
  const cfg = SYMBOL_CONFIGS[symbol];
  const startedAt = Date.now();

  // ---- FAST PATH: derive from the already-downloaded instrument master. ----
  // This avoids GET /v2/option/contract without an expiry filter, which returns every
  // listed contract (~2,000 NIFTY / ~3,700 SENSEX rows) as a multi-megabyte payload and
  // was the dominant cost of the first scan.
  try {
    const fromMaster = await discoverExpiriesFromMaster(symbol);
    if (fromMaster.expiries.length > 0) {
      return { ...fromMaster, httpStatus: null, errorCode: null };
    }
    // The master had no usable rows: fall through to the documented API endpoint.
  } catch {
    // Master unavailable or not yet warm — fall through to the API path below.
  }

  // ---- SLOW PATH: documented API endpoint. ----
  const endpoint = "/v2/option/contract";
  try {
    const res = await upstoxRequest<{ data?: unknown }>({
      path: endpoint,
      token,
      query: { instrument_key: cfg.indexKey },
      minIntervalMs: 2000,
      critical: false,
      validate: (raw) => {
        const arr = (raw as { data?: unknown } | null)?.data;
        const count = Array.isArray(arr) ? arr.length : 0;
        return { ok: count > 0, recordCount: count, problem: `no contract rows returned for ${cfg.indexKey}` };
      },
    });

    const arr = (res.data?.data ?? null) as unknown;
    if (!Array.isArray(arr)) {
      return {
        expiries: [],
        allExpiries: [],
        ceCounts: {},
        peCounts: {},
        usableExpiries: [],
        source: "NONE",
        entitlementError: null,
        selectedExpiry: null,
        status: "UNAVAILABLE",
        endpoint,
        contractRowCount: 0,
        expiryCount: 0,
        httpStatus: res.status,
        errorCode: null,
        message: `${endpoint} returned a non-array payload for ${cfg.indexKey}`,
        reason: `Unexpected response shape: expected data[] but got ${Array.isArray(arr) ? "array" : typeof arr}`,
        receivedAt: res.receivedAt,
      };
    }

    const allExpiries = new Set<string>();
    const ceCounts: Record<string, number> = {};
    const peCounts: Record<string, number> = {};
    const contractMap = new Map<string, { tradingSymbol: string; lotSize: number | null; instrumentType: string; strike: number | null }>();
    let malformedRows = 0;

    for (const raw of arr) {
      if (!raw || typeof raw !== "object") {
        malformedRows += 1;
        continue;
      }
      const row = raw as Record<string, unknown>;
      const expiryRaw = row.expiry ?? row.expiry_date;
      const expiry =
        typeof expiryRaw === "string" && /^\d{4}-\d{2}-\d{2}/.test(expiryRaw)
          ? expiryRaw.slice(0, 10)
          : toIsoDate(expiryRaw);
      const key = typeof row.instrument_key === "string" ? row.instrument_key : null;
      if (!expiry || !key) {
        malformedRows += 1;
        continue;
      }
      allExpiries.add(expiry);
      // Count CE and PE contracts per expiry so the chain step can verify that an
      // expiry is actually tradeable on both sides before requesting it.
      if (contractMapEntryType(row) === "CE") ceCounts[expiry] = (ceCounts[expiry] ?? 0) + 1;
      else if (contractMapEntryType(row) === "PE") peCounts[expiry] = (peCounts[expiry] ?? 0) + 1;
      if (!contractMap.has(key)) {
        contractMap.set(key, {
          tradingSymbol: typeof row.trading_symbol === "string" ? row.trading_symbol : str(row, ["tradingsymbol"]),
          lotSize: num(row, ["lot_size", "lot_quantity", "market_lot"]),
          instrumentType: str(row, ["instrument_type", "option_type"]).toUpperCase(),
          strike: num(row, ["strike_price", "strike"]),
        });
      }
    }

    // Cache the contract map for chain display (symbol + lot size).
    contractMapCache.set(`${symbol}:${cfg.indexKey}`, { map: contractMap, at: Date.now() });

    const today = new Date().toISOString().slice(0, 10);
    const all = [...allExpiries].sort();
    const future = all.filter((e) => e >= today);
    const selected = future.length > 0 ? future[0] : null;

    const usable = future.filter((e) => (ceCounts[e] ?? 0) > 0 && (peCounts[e] ?? 0) > 0);
    // Prefer an expiry that has BOTH CE and PE contracts; fall back to the first future expiry.
    const preferred = usable.length > 0 ? usable[0] : future.length > 0 ? future[0] : null;

    if (future.length === 0) {
      return {
        expiries: [],
        allExpiries: all,
        ceCounts,
        peCounts,
        usableExpiries: [],
        source: "OPTION_CONTRACT",
        entitlementError: null,
        selectedExpiry: null,
        status: "UNAVAILABLE",
        endpoint,
        contractRowCount: arr.length,
        expiryCount: all.length,
        httpStatus: res.status,
        errorCode: null,
        message: `${endpoint} returned ${arr.length} contract rows with ${all.length} distinct expiries, but none are on or after ${today} (IST)`,
        reason: all.length === 0 ? "No expiry values could be parsed from the contract rows." : "All listed contracts are expired.",
        receivedAt: res.receivedAt,
      };
    }

    return {
      expiries: future,
      allExpiries: all,
      ceCounts,
      peCounts,
      usableExpiries: usable,
      source: "OPTION_CONTRACT",
      entitlementError: null,
      selectedExpiry: preferred,
      status: "LIVE",
      endpoint,
      contractRowCount: arr.length,
      expiryCount: future.length,
      httpStatus: res.status,
      errorCode: null,
      message:
        `${endpoint} (no expiry filter) → ${arr.length} contract rows, ${future.length} future expiries, ${usable.length} with both CE and PE contracts; selected ${preferred}` +
        (usable.length === 0 ? " ⚠ no expiry has both CE and PE contracts" : ""),
      reason: malformedRows > 0 ? `${malformedRows} malformed rows were skipped.` : usable.length === 0 ? "No expiry carries both CE and PE contracts — the option chain cannot be built." : null,
      receivedAt: res.receivedAt,
    };
  } catch (err) {
    const f = failureToModuleStatus(err);
    const e = err as { status?: number | null; code?: string | null };
    return {
      expiries: [],
      allExpiries: [],
      ceCounts: {},
      peCounts: {},
      usableExpiries: [],
      source: "NONE",
      entitlementError: e.code === "UDAPI1149" ? "Upstox Plus subscription required (UDAPI1149)" : null,
      selectedExpiry: null,
      status: "UNAVAILABLE",
      endpoint,
      contractRowCount: 0,
      expiryCount: 0,
      httpStatus: e.status ?? null,
      errorCode: e.code ?? null,
      message: f.message,
      reason: f.message,
      receivedAt: startedAt,
    };
  }
}

/** Contract metadata cache keyed by symbol, populated during expiry discovery. */
const contractMapCache = new Map<string, { map: Map<string, { tradingSymbol: string; lotSize: number | null; instrumentType: string; strike: number | null }>; at: number }>();

export async function getContractMap(
  symbol: SymbolKey,
  expiry: string,
  token: string | null,
): Promise<Map<string, { tradingSymbol: string; lotSize: number | null }>> {
  const cfg = SYMBOL_CONFIGS[symbol];
  const cached = contractMapCache.get(`${symbol}:${cfg.indexKey}`);
  if (cached && Date.now() - cached.at < 30 * 60000) {
    const out = new Map<string, { tradingSymbol: string; lotSize: number | null }>();
    for (const [k, v] of cached.map) out.set(k, { tradingSymbol: v.tradingSymbol, lotSize: v.lotSize });
    return out;
  }
  // Build from the cached instrument master — no API call, no multi-megabyte payload.
  await discoverExpiriesFromMaster(symbol);
  const out = new Map<string, { tradingSymbol: string; lotSize: number | null }>();
  for (const [k, v] of contractMapCache.get(`${symbol}:${cfg.indexKey}`)?.map ?? []) {
    out.set(k, { tradingSymbol: v.tradingSymbol, lotSize: v.lotSize });
  }
  return out;
}

export async function getOptionExpiriesDetailed(symbol: SymbolKey, token: string | null) {
  const d = await discoverExpiries(symbol, token);
  return {
    expiries: d.expiries.length > 0 ? d.expiries : null,
    status: d.status,
    reason: d.reason ?? d.message,
    discovery: d,
  };
}

export async function getOptionExpiries(symbol: SymbolKey, token: string | null): Promise<string[] | null> {
  return (await discoverExpiries(symbol, token)).expiries;
}

export function pickNearestExpiry(expiries: string[]): string | null {
  return expiries.length > 0 ? expiries[0] : null;
}

/** Resolves trading symbol + lot size for chain instrument keys (used for display + tradability). */
export async function buildContractMap(
  symbol: SymbolKey,
  expiry: string,
  token: string | null,
): Promise<Map<string, { tradingSymbol: string; lotSize: number | null }>> {
  const fromDiscovery = await getContractMap(symbol, expiry, token);
  if (fromDiscovery.size > 0) return fromDiscovery;

  // Fallback: derive symbols from the instrument master (CE/PE rows for this expiry).
  const map = new Map<string, { tradingSymbol: string; lotSize: number | null }>();
  const cfg = SYMBOL_CONFIGS[symbol];
  try {
    const rows = await getInstrumentRows();
    for (const r of rows) {
      if (
        ["CE", "PE"].includes(r.instrumentType.toUpperCase()) &&
        r.instrumentKey.toUpperCase().startsWith(`${cfg.derivativesExchange}|`) &&
        r.expiry === expiry
      ) {
        map.set(r.instrumentKey, { tradingSymbol: r.tradingSymbol, lotSize: r.lotSize });
      }
    }
  } catch {
    // leave empty; UI shows symbol unavailable
  }
  return map;
}
