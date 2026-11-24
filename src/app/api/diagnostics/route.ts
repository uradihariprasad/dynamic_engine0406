import { SYMBOL_CONFIGS, SYMBOL_KEYS, type SymbolKey } from "@/lib/config";
import {
  breakerSnapshots,
  failureToModuleStatus,
  lastFailures,
  resetBreakers,
  upstoxRequest,
  UpstoxError,
} from "@/lib/upstox/client";
import {
  discoverExpiries,
  getMasterState,
  resolveFuturesDetailed,
  resolveIndexInstrument,
  type ExpiryDiscovery,
  type IndexInstrumentInfo,
} from "@/lib/upstox/instruments";
import {
  fetchHistoryCandles,
  fetchIntradayCandles,
  fetchOptionChain,
  getMarketStatus,
  getQuoteForKeys,
  getSpotQuote,
  parseRows,
  type OptionChainResult,
  type SpotQuoteResult,
} from "@/lib/upstox/market";
import { describeSession, ensureSessionLoaded, getMetrics, getToken, isConnected, processId } from "@/lib/upstox/session";
import { countFuturesSnapshots, countOiSnapshots, loadOiHistory, recentPersistenceLog, sanitizeDbError, persistOiSnapshots } from "@/lib/persistence";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { oiSnapshot } from "@/db/schema";
import { and, eq, gte, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

interface Check {
  id: string;
  /** Which symbol this check belongs to. "BOTH" for shared checks. */
  symbol: SymbolKey | "BOTH";
  /** Logical module under test, matching the required diagnostic matrix. */
  module: string;
  endpoint: string;
  instrumentKey: string | null;
  ok: boolean;
  status: string;
  httpStatus: number | null;
  errorCode: string | null;
  message: string;
  recordCount: number | null;
  latencyMs: number | null;
  correctiveAction: string | null;
  sample: Record<string, unknown> | null;
}

interface SymbolReport {
  symbol: SymbolKey;
  resolution: { ok: boolean; instrumentKey: string; masterInstrumentKey: string | null; tradingSymbol: string | null; segment: string | null; source: string; reason: string | null };
  expiryDiscovery: ExpiryDiscovery | null;
  selectedExpiry: string | null;
  chainStrikes: number | null;
  greeksAvailable: boolean | null;
  greeksFieldCoverage: Record<string, number> | null;
  oiReadOk: boolean | null;
  oiSnapshotCount: number | null;
  oldestOiAt: string | null;
  newestOiAt: string | null;
  futuresExpiry: string | null;
  checks: Check[];
}

const HISTORY_HINT = "Snapshots accumulate automatically each cycle; 5-minute values appear after ~5 minutes of observations and 15-minute after ~15 minutes. Keep the application running.";

function action(status: string, message: string): string | null {
  if (/UDAPI100050|401|Invalid token|token expired/i.test(message)) {
    return "Regenerate the access token at https://account.upstox.com/developer/apps (tokens expire daily ~03:30 IST) and reconnect in Settings.";
  }
  if (status === "DISCONNECTED") return "The server could not reach api.upstox.com. Verify outbound HTTPS access.";
  if (status === "STALE") return "Upstox rate limit or 5xx. The transport retries with backoff — reduce UPSTOX_MAX_RPS or retry shortly.";
  if (/Invalid Instrument key/i.test(message)) return "The instrument key was rejected by Upstox. Run this diagnostic to see which key was used and re-resolve it from the instrument master.";
  if (/Invalid Endpoint|Resource not Found|404/i.test(message)) return "The endpoint path is not registered with Upstox. Use the documented endpoint listed in the check.";
  if (/no contract rows|no strike rows|empty data object/i.test(message)) return "Upstox returned a valid response with zero records. Check that this underlying actually has listed contracts/expiry.";
  if (/market closed|no rows/i.test(message)) return "Likely outside market hours. Historical candles still work; re-run during a live session for intraday freshness.";
  return null;
}

function mk(args: Partial<Check> & Pick<Check, "id" | "symbol" | "module" | "endpoint" | "ok" | "message">): Check {
  const result: Check = {
    instrumentKey: null,
    status: args.ok ? "LIVE" : "UNAVAILABLE",
    httpStatus: null,
    errorCode: null,
    recordCount: null,
    latencyMs: null,
    correctiveAction: null,
    sample: null,
    ...args,
  };
  result.correctiveAction = args.correctiveAction ?? (args.ok ? null : action(result.status, args.message));
  return result;
}

function fail(id: string, symbol: SymbolKey | "BOTH", module: string, endpoint: string, err: unknown, extra?: Partial<Check>): Check {
  const f = failureToModuleStatus(err);
  const e = err as { status?: number | null; code?: string | null };
  return mk({
    id,
    symbol,
    module,
    endpoint,
    ok: false,
    status: f.status,
    httpStatus: e.status ?? null,
    errorCode: e.code ?? null,
    message: `${f.message}${f.code ? ` [${f.code}]` : ""}`,
    ...extra,
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = (url.searchParams.get("symbol") ?? "").toUpperCase();
  const symbols: SymbolKey[] = SYMBOL_KEYS.includes(requested as SymbolKey) ? [requested as SymbolKey] : [...SYMBOL_KEYS];

  // Reconcile with the encrypted shared store before declaring "no token".
  let hydrationNote = "session already present in this process";
  if (!isConnected()) {
    const ok = await ensureSessionLoaded();
    hydrationNote = ok ? "session restored from encrypted shared store" : "no session in this process and none in the encrypted store";
  }
  const token = getToken();
  const connected = isConnected();
  const metrics = getMetrics();
  const sessionInfo = describeSession();
  const checks: Check[] = [];

  /* ---------------- Layer 1: backend session ---------------- */
  checks.push(
    mk({
      id: "backend_session",
      symbol: "BOTH",
      module: "Backend session",
      endpoint: "runtime memory + AES-256-GCM shared store",
      ok: connected,
      status: connected ? "LIVE" : "UNAVAILABLE",
      message: connected
        ? `Token present in process ${sessionInfo.processId}. ${sessionInfo.restoredFromStore ? "Restored from encrypted store." : "Set in this process."}`
        : `No token in process ${processId()}. ${hydrationNote}.`,
      sample: {
        processId: processId(),
        sessionProcessId: sessionInfo.processId || null,
        restoredFromStore: sessionInfo.restoredFromStore,
        storeWritable: sessionInfo.storeWritable,
        storeError: sessionInfo.storeError,
        tokenFingerprint: sessionInfo.tokenFingerprint || null,
        lastRequestEndpoint: metrics.lastRequestEndpoint,
        lastRequestOk: metrics.lastRequestOk,
        lastError: metrics.lastError,
        totalRequests: metrics.totalRequests,
        totalFailures: metrics.totalFailures,
      },
    }),
  );

  if (!connected) {
    return Response.json({
      ok: true,
      connected,
      conclusion: "NO_DATA_BECAUSE_NO_TOKEN",
      checks,
      symbols: [],
      breakers: [],
      recentFailures: lastFailures(),
      fix: "Open Settings, paste a valid Upstox access token and press Connect. Validation uses GET /v2/user/profile; the token is only saved after Upstox confirms it.",
    });
  }

  /* ---------------- Layer 2: token validation ---------------- */
  {
    const started = Date.now();
    try {
      const res = await upstoxRequest<{ data?: Record<string, unknown> }>({ path: "/v2/user/profile", token, retries: 0, critical: false });
      const d = res.data?.data ?? {};
      checks.push(
        mk({
          id: "token_validation",
          symbol: "BOTH",
          module: "Token validation",
          endpoint: "GET /v2/user/profile",
          ok: true,
          status: "LIVE",
          httpStatus: res.status,
          latencyMs: Date.now() - started,
          message: `Upstox accepted the token (${res.elapsedMs}ms)`,
          sample: { user_id: d.user_id ?? null, user_name: d.user_name ?? null, broker: d.broker ?? null, is_active: d.is_active ?? null, exchanges: Array.isArray(d.exchanges) ? d.exchanges : [] },
        }),
      );
    } catch (err) {
      checks.push(fail("token_validation", "BOTH", "Token validation", "GET /v2/user/profile", err));
    }
  }

  /* ---------------- Layer 3: instrument master ---------------- */
  try {
    const state = await getMasterState();
    const gzip = state.reports.filter((r) => r.gzipDecompressed).length;
    const ok = state.rows > 0;
    checks.push(
      mk({
        id: "instrument_master",
        symbol: "BOTH",
        module: "Instrument master",
        endpoint: "assets.upstox.com/.../exchange/complete.json.gz",
        ok,
        status: ok ? "LIVE" : "INVALID",
        message: ok
          ? `${state.rows} records, gzip decompressed (${gzip}/${state.reports.length}). Segment-specific files (NSE_FO.json.gz) return HTTP 403 and are not used.`
          : state.errors.join(" | "),
        recordCount: state.rows,
        sample: { reports: state.reports.map((r) => ({ http: r.httpStatus, bytes: r.bytes, gzip: r.gzipDecompressed, records: r.totalRecords, error: r.parseError })) },
      }),
    );
  } catch (err) {
    checks.push(fail("instrument_master", "BOTH", "Instrument master", "complete.json.gz", err));
  }

  /* ---------------- Per-symbol matrix ---------------- */
  const reports: SymbolReport[] = [];

  for (const symbol of symbols) {
    const cfg = SYMBOL_CONFIGS[symbol];
    const rep: SymbolReport = {
      symbol,
      resolution: { ok: false, instrumentKey: cfg.indexKey, masterInstrumentKey: null, tradingSymbol: null, segment: null, source: "UNAVAILABLE", reason: null },
      expiryDiscovery: null,
      selectedExpiry: null,
      chainStrikes: null,
      greeksAvailable: null,
      greeksFieldCoverage: null,
      oiReadOk: null,
      oiSnapshotCount: null,
      oldestOiAt: null,
      newestOiAt: null,
      futuresExpiry: null,
      checks: [],
    };

    // 1. Instrument resolution
    const startedRes = Date.now();
    try {
      const r = await resolveIndexInstrument(symbol);
      rep.resolution = {
        ok: r.verified,
        instrumentKey: r.instrumentKey,
        masterInstrumentKey: r.masterInstrumentKey,
        tradingSymbol: r.tradingSymbol,
        segment: r.segment,
        source: r.source,
        reason: r.reason,
      };
      rep.checks.push(
        mk({
          id: "instrument_resolution",
          symbol,
          module: "Instrument resolution",
          endpoint: "instrument master → index row",
          instrumentKey: r.instrumentKey,
          ok: r.verified,
          status: r.verified ? "LIVE" : "UNAVAILABLE",
          latencyMs: Date.now() - startedRes,
          message: r.verified
            ? `Verified against master: ${r.tradingSymbol} / segment ${r.segment}${r.masterInstrumentKey && r.masterInstrumentKey !== r.instrumentKey ? ` (master publishes ${r.masterInstrumentKey})` : ""}`
            : (r.reason ?? "not verified"),
          sample: { canonical: r.canonicalSymbol, instrumentKey: r.instrumentKey, masterKey: r.masterInstrumentKey, tradingSymbol: r.tradingSymbol, segment: r.segment, probeKeys: r.probeKeys, candidates: r.candidates.slice(0, 5), source: r.source },
        }),
      );
    } catch (err) {
      rep.checks.push(fail("instrument_resolution", symbol, "Instrument resolution", "instrument master", err, { instrumentKey: cfg.indexKey }));
    }
    const key = rep.resolution.instrumentKey;

    // 2. Spot quote (V3 + V2 fallback)
    {
      const started = Date.now();
      try {
        const q: SpotQuoteResult = await getSpotQuote(symbol, key);
        rep.checks.push(
          mk({
            id: "spot_quote_v3",
            symbol,
            module: "Spot quote",
            endpoint: q.quoteResult?.endpoint ?? "/v3/market-quote/quotes",
            instrumentKey: q.resolvedKey,
            ok: q.quote !== null,
            status: q.status,
            httpStatus: q.quoteResult?.httpStatus ?? null,
            errorCode: q.quoteResult?.errorCode ?? null,
            latencyMs: Date.now() - started,
            recordCount: q.quote ? 1 : 0,
            message: q.message,
            correctiveAction: q.quote === null && q.attemptedKeys.length > 1 ? `Both ${q.attemptedKeys.join(" and ")} returned no entry — the key may not be quoteable for this index.` : null,
            sample: q.quote
              ? {
                  ltp: q.quote.ltp,
                  prev_close: q.quote.prevClose,
                  prev_close_source: q.quote.prevCloseSource,
                  open: q.quote.open,
                  high: q.quote.high,
                  low: q.quote.low,
                  change: q.quote.change,
                  pct_change: q.quote.pctChange,
                  net_change: q.quote.netChange,
                  quote_version: q.quote.quoteVersion,
                  depth_buy_levels: q.quote.depthBuy.length,
                  depth_sell_levels: q.quote.depthSell.length,
                  freshness_ms: q.quote.freshnessMs,
                }
              : { attemptedKeys: q.attemptedKeys, v3Error: q.quoteResult?.v3Error, v2Error: q.quoteResult?.v2Error },
          }),
        );
      } catch (err) {
        rep.checks.push(fail("spot_quote_v3", symbol, "Spot quote", "/v3/market-quote/quotes", err, { instrumentKey: key }));
      }
    }

    // 3. Historical candles
    {
      const started = Date.now();
      try {
        const c = await fetchHistoryCandles(symbol, "5m", 5);
        rep.checks.push(
          mk({
            id: "historical_candles",
            symbol,
            module: "Historical candles",
            endpoint: "/v3/historical-candle/{key}/minutes/5",
            instrumentKey: key,
            ok: c.rows.length > 0,
            status: c.status,
            latencyMs: Date.now() - started,
            recordCount: c.rows.length,
            message: c.message,
            sample: {
              rows: c.rows.length,
              invalidRows: c.invalidRows,
              duplicates: c.duplicates,
              source: c.source,
              first: c.rows.length ? new Date(c.rows[0].ts).toISOString() : null,
              last: c.rows.length ? new Date(c.rows[c.rows.length - 1].ts).toISOString() : null,
            },
          }),
        );
      } catch (err) {
        rep.checks.push(fail("historical_candles", symbol, "Historical candles", "/v3/historical-candle", err, { instrumentKey: key }));
      }
    }

    // 4. Intraday candles
    {
      const started = Date.now();
      try {
        const c = await fetchIntradayCandles(symbol, "5m");
        rep.checks.push(
          mk({
            id: "intraday_candles",
            symbol,
            module: "Intraday candles",
            endpoint: "/v3/historical-candle/intraday/{key}/minutes/5",
            instrumentKey: key,
            ok: c.rows.length > 0,
            status: c.status,
            latencyMs: Date.now() - started,
            recordCount: c.rows.length,
            message: c.message,
            sample: { rows: c.rows.length, last: c.rows.length ? new Date(c.rows[c.rows.length - 1].ts).toISOString() : null },
          }),
        );
      } catch (err) {
        rep.checks.push(fail("intraday_candles", symbol, "Intraday candles", "/v3/historical-candle/intraday", err, { instrumentKey: key }));
      }
    }

    // 5. Futures resolution + quote
    {
      const started = Date.now();
      try {
        const f = await resolveFuturesDetailed(symbol);
        if (f.contracts.length === 0) {
          rep.checks.push(
            mk({
              id: "futures_resolution",
              symbol,
              module: "Futures resolution",
              endpoint: "instrument master → FUT rows",
              instrumentKey: null,
              ok: false,
              status: "UNAVAILABLE",
              message: f.reason ?? "No futures contract resolved",
              sample: { totalFutRows: f.totalFuturesRows, underlying: cfg.underlyingName, segment: cfg.derivativesExchange },
            }),
          );
        } else {
          const first = f.contracts[0];
          rep.futuresExpiry = first.expiry;
          rep.checks.push(
            mk({
              id: "futures_resolution",
              symbol,
              module: "Futures resolution",
              endpoint: "instrument master → FUT rows",
              instrumentKey: first.instrumentKey,
              ok: true,
              status: "LIVE",
              latencyMs: Date.now() - started,
              recordCount: f.contracts.length,
              message: `${f.contracts.length} contract(s); nearest ${first.tradingSymbol} exp ${first.expiry} lot ${first.lotSize ?? "?"}`,
              sample: { contracts: f.contracts.slice(0, 4).map((c) => ({ key: c.instrumentKey, symbol: c.tradingSymbol, expiry: c.expiry, lot: c.lotSize })) },
            }),
          );
          // futures quote
          const startedQ = Date.now();
          try {
            const q = await getQuoteForKeys([first.instrumentKey]);
            const entry = q.entries[first.instrumentKey] ?? null;
            rep.checks.push(
              mk({
                id: "futures_quote",
                symbol,
                module: "Futures quote",
                endpoint: "/v3/market-quote/quotes",
                instrumentKey: first.instrumentKey,
                ok: entry !== null,
                status: entry ? q.status : "UNAVAILABLE",
                httpStatus: q.httpStatus,
                errorCode: q.errorCode,
                latencyMs: Date.now() - startedQ,
                recordCount: entry ? 1 : 0,
                message: entry ? q.message : `${q.message} — no entry for ${first.tradingSymbol}`,
                sample: entry
                  ? { ltp: entry.last_price ?? null, oi: entry.oi ?? null, previous_oi: entry.previous_oi ?? null, volume: entry.volume ?? null, quote_version: q.version }
                  : { missingKeys: q.missingKeys, v3Error: q.v3Error, v2Error: q.v2Error },
              }),
            );
          } catch (err) {
            rep.checks.push(fail("futures_quote", symbol, "Futures quote", "/v3/market-quote/quotes", err, { instrumentKey: first.instrumentKey }));
          }
        }
      } catch (err) {
        rep.checks.push(fail("futures_resolution", symbol, "Futures resolution", "instrument master", err));
      }
    }

    // 6. Option contract discovery + expiry selection
    {
      const started = Date.now();
      try {
        const d = await discoverExpiries(symbol, token);
        rep.expiryDiscovery = d;
        rep.selectedExpiry = d.selectedExpiry;
        rep.checks.push(
          mk({
            id: "option_contract_discovery",
            symbol,
            module: "Option contract discovery",
            endpoint: d.endpoint,
            instrumentKey: cfg.indexKey,
            ok: d.expiries.length > 0,
            status: d.status,
            httpStatus: d.httpStatus,
            errorCode: d.errorCode,
            latencyMs: Date.now() - started,
            recordCount: d.contractRowCount,
            message: d.message,
            sample: { contractRows: d.contractRowCount, distinctExpiries: d.expiryCount, nearest: d.expiries.slice(0, 5), allExpiries: d.allExpiries.slice(0, 8), reason: d.reason },
          }),
        );
        if (d.selectedExpiry) {
          rep.checks.push(
            mk({
              id: "expiry_selection",
              symbol,
              module: "Expiry selection",
              endpoint: d.endpoint,
              instrumentKey: cfg.indexKey,
              ok: true,
              status: "LIVE",
              message: `Nearest non-expired expiry: ${d.selectedExpiry}`,
              recordCount: 1,
              sample: { selected: d.selectedExpiry, available: d.expiries.length },
            }),
          );
        }
      } catch (err) {
        rep.checks.push(fail("option_contract_discovery", symbol, "Option contract discovery", "/v2/option/contract", err, { instrumentKey: cfg.indexKey }));
      }
    }

    // 7. Option chain + Greeks
    const expiry = rep.selectedExpiry;
    if (expiry) {
      const started = Date.now();
      try {
        const chain: OptionChainResult = await fetchOptionChain(symbol, expiry);
        rep.chainStrikes = chain.strikes.length;
        rep.greeksAvailable = chain.greeksAvailable;
        rep.checks.push(
          mk({
            id: "option_chain",
            symbol,
            module: "Option chain",
            endpoint: "/v2/option/chain",
            instrumentKey: cfg.indexKey,
            ok: chain.strikes.length > 0,
            status: chain.status,
            latencyMs: Date.now() - started,
            recordCount: chain.strikes.length,
            message: chain.message,
            sample: {
              strikes: chain.strikes.length,
              rawRows: chain.rawRowCount,
              expiry,
              spot: chain.strikes[0]?.spot ?? null,
              bidAskQtyAvailable: chain.bidAskQtyAvailable,
              atm: (() => {
                if (chain.strikes.length === 0) return null;
                const atm = chain.strikes.reduce((b, s) => (Math.abs(s.strike - (s.spot ?? 0)) < Math.abs(b.strike - (b.spot ?? 0)) ? s : b), chain.strikes[0]);
                return {
                  strike: atm.strike,
                  ce: { ltp: atm.ce.ltp, oi: atm.ce.oi, delta: atm.ce.delta, gamma: atm.ce.gamma, theta: atm.ce.theta, vega: atm.ce.vega, iv: atm.ce.iv, bid: atm.ce.bidPrice, ask: atm.ce.askPrice, bidQty: atm.ce.bidQty, askQty: atm.ce.askQty },
                  pe: { ltp: atm.pe.ltp, oi: atm.pe.oi, delta: atm.pe.delta, gamma: atm.pe.gamma, theta: atm.pe.theta, vega: atm.pe.vega, iv: atm.pe.iv },
                };
              })(),
            },
          }),
        );

        // Greeks field coverage per contract — never all-or-nothing.
        const fieldCounts = {
          delta: chain.strikes.filter((st) => st.ce.delta !== null || st.pe.delta !== null).length,
          gamma: chain.strikes.filter((st) => st.ce.gamma !== null || st.pe.gamma !== null).length,
          theta: chain.strikes.filter((st) => st.ce.theta !== null || st.pe.theta !== null).length,
          vega: chain.strikes.filter((st) => st.ce.vega !== null || st.pe.vega !== null).length,
          iv: chain.strikes.filter((st) => st.ce.iv !== null || st.pe.iv !== null).length,
          bidQty: chain.strikes.filter((st) => st.ce.bidQty !== null || st.pe.bidQty !== null).length,
          askQty: chain.strikes.filter((st) => st.ce.askQty !== null || st.pe.askQty !== null).length,
        };
        rep.greeksFieldCoverage = fieldCounts;
        rep.checks.push(
          mk({
            id: "greeks_field_coverage",
            symbol,
            module: "Greeks field coverage",
            endpoint: "/v2/option/chain (option_greeks)",
            instrumentKey: cfg.indexKey,
            ok: Object.values(fieldCounts).some((v) => v > 0),
            status: Object.values(fieldCounts).some((v) => v > 0) ? "LIVE" : "PARTIAL",
            recordCount: chain.strikes.length,
            message: `Contracts supplying each field (of ${chain.strikes.length} strikes): delta ${fieldCounts.delta}, gamma ${fieldCounts.gamma}, theta ${fieldCounts.theta}, vega ${fieldCounts.vega}, iv ${fieldCounts.iv}; bid/ask quantity ${fieldCounts.bidQty}/${fieldCounts.askQty}. Partial availability is preserved per contract — nothing is estimated.`,
          }),
        );
        rep.checks.push(
          mk({
            id: "executed_dominance",
            symbol,
            module: "Executed buyer/seller dominance",
            endpoint: "not available from current data source",
            instrumentKey: null,
            ok: false,
            status: "UNAVAILABLE",
            message: "NOT AVAILABLE FROM CURRENT DATA SOURCE. Requires trade-level execution data with aggressor-side classification; Upstox market data exposes option-chain snapshots only. CVD, footprint delta and executed volume delta are never manufactured from OI or displayed bid/ask quantities.",
          }),
        );
        rep.checks.push(
          mk({
            id: "greeks",
            symbol,
            module: "Greeks",
            endpoint: "/v2/option/chain (option_greeks object)",
            instrumentKey: cfg.indexKey,
            ok: chain.greeksAvailable,
            status: chain.greeksAvailable ? "LIVE" : "PARTIAL",
            recordCount: chain.strikes.length,
            message: chain.greeksAvailable
              ? "option_greeks present (delta/gamma/theta/vega/iv) for at least some strikes — partial availability is preserved per contract."
              : `option_greeks returned no usable values across ${chain.strikes.length} strikes. Nothing is estimated.`,
          }),
        );

        // 8. Database verification: write, read back, count, and report failures
        const startedOi = Date.now();
        try {
          // 8a. Live table connectivity probe (distinguishes DB-down from empty history)
          let dbOk = true;
          let dbError: string | null = null;
          try {
            await db.execute(sql`select 1`);
          } catch (err) {
            dbOk = false;
            dbError = sanitizeDbError(err);
          }

          if (!dbOk) {
            rep.checks.push(
              mk({
                id: "database_connectivity",
                symbol,
                module: "Database connectivity",
                endpoint: "PostgreSQL select 1",
                ok: false,
                status: "INVALID",
                message: `Database unreachable: ${dbError}`,
                correctiveAction: "Verify DATABASE_URL and that PostgreSQL is running. Run `npx drizzle-kit push` to create missing tables.",
              }),
            );
            rep.checks.push(
              mk({
                id: "oi_snapshot_persistence",
                symbol,
                module: "OI snapshot persistence",
                endpoint: "PostgreSQL oi_snapshot",
                instrumentKey: cfg.indexKey,
                ok: false,
                status: "FAILED",
                message: "Cannot verify persistence because the database is unreachable.",
              }),
            );
          } else {
            rep.checks.push(
              mk({
                id: "database_connectivity",
                symbol,
                module: "Database connectivity",
                endpoint: "PostgreSQL select 1",
                ok: true,
                status: "LIVE",
                latencyMs: Date.now() - startedOi,
                message: "PostgreSQL reachable.",
              }),
            );

            // 8b. Actual write test: persist the current chain rows (throttled/deduped internally).
            const writeResult = await persistOiSnapshots({ symbol, expiry, strikes: chain.strikes, now: Date.now(), force: false });
            rep.checks.push(
              mk({
                id: "oi_snapshot_persistence",
                symbol,
                module: "OI snapshot persistence",
                endpoint: "PostgreSQL oi_snapshot (INSERT)",
                instrumentKey: cfg.indexKey,
                ok: writeResult.ok,
                status: writeResult.ok ? "LIVE" : "FAILED",
                recordCount: writeResult.recordCount,
                latencyMs: writeResult.durationMs,
                message: writeResult.ok
                  ? writeResult.skipped
                    ? `Write skipped: ${writeResult.skipReason}`
                    : `Wrote ${writeResult.recordCount} OI/premium observations for expiry ${expiry}.`
                  : `INSERT FAILED: ${writeResult.error}`,
                correctiveAction: writeResult.ok ? null : "Check PostgreSQL connectivity and run `npx drizzle-kit push` to ensure the oi_snapshot table exists.",
                sample: { skipped: writeResult.skipped, skipReason: writeResult.skipReason, error: writeResult.error, at: writeResult.at },
              }),
            );

            // 8c. Read-back verification with history-window coverage.
            const read = await loadOiHistory({ symbol, expiry, sinceMs: Date.now() - 6 * 3600000, now: Date.now() });
            rep.oiReadOk = read.ok;
            rep.oiSnapshotCount = read.recordCount;
            rep.oldestOiAt = read.oldestAt;
            rep.newestOiAt = read.newestAt;
            rep.checks.push(
              mk({
                id: "oi_history_read",
                symbol,
                module: "OI history read",
                endpoint: "PostgreSQL oi_snapshot (SELECT)",
                instrumentKey: cfg.indexKey,
                ok: read.ok,
                status: read.ok ? "LIVE" : "FAILED",
                recordCount: read.recordCount,
                latencyMs: read.durationMs,
                message: read.ok
                  ? `Read ${read.recordCount} observations (${read.distinctObservations} distinct capture times). 5m window: ${read.has5m ? "AVAILABLE" : "PENDING"}. 15m window: ${read.has15m ? "AVAILABLE" : "PENDING"}. Baseline: ${read.hasBaseline ? "PRESENT" : "PENDING"}.`
                  : `SELECT FAILED: ${read.error} — this is a database problem, NOT an empty history.`,
                correctiveAction: read.ok ? (read.has5m ? null : HISTORY_HINT) : "Check PostgreSQL connectivity and permissions.",
                sample: { oldestAt: read.oldestAt, newestAt: read.newestAt, distinctObservations: read.distinctObservations, has5m: read.has5m, has15m: read.has15m, hasBaseline: read.hasBaseline, error: read.error },
              }),
            );

            const futCount = await countFuturesSnapshots({ symbol, expiry: rep.futuresExpiry ?? "" });
            rep.checks.push(
              mk({
                id: "futures_snapshot_count",
                symbol,
                module: "Futures snapshots",
                endpoint: "PostgreSQL futures_snapshot (SELECT)",
                ok: futCount.ok,
                status: futCount.ok ? "LIVE" : "FAILED",
                recordCount: futCount.count,
                message: futCount.ok
                  ? `${futCount.count} stored observations for expiry ${rep.futuresExpiry ?? "n/a"}. Positioning classification requires one within the 8-minute tolerance.`
                  : `SELECT FAILED: ${futCount.error}`,
                correctiveAction: futCount.ok ? null : "Check PostgreSQL connectivity and run `npx drizzle-kit push`.",
              }),
            );
          }
        } catch (err) {
          rep.checks.push(fail("oi_snapshot_persistence", symbol, "OI snapshot persistence", "PostgreSQL oi_snapshot", err));
        }
      } catch (err) {
        rep.checks.push(fail("option_chain", symbol, "Option chain", "/v2/option/chain", err, { instrumentKey: cfg.indexKey }));
      }
    } else {
      rep.checks.push(
        mk({
          id: "option_chain",
          symbol,
          module: "Option chain",
          endpoint: "/v2/option/chain",
          instrumentKey: cfg.indexKey,
          ok: false,
          status: "UNAVAILABLE",
          message: "Skipped: no expiry could be selected from contract discovery (see the option_contract_discovery check).",
        }),
      );
    }

    // 9. Market status (shared, reported per symbol for context)
    try {
      const m = await getMarketStatus(cfg.exchange);
      rep.checks.push(
        mk({
          id: "market_status",
          symbol,
          module: "Market status",
          endpoint: `/v2/market/status?exchange=${cfg.exchange}`,
          ok: m.status === "LIVE",
          status: m.status,
          message: `${m.message}${m.marketStatus ? ` — ${m.marketStatus}` : ""}`,
        }),
      );
    } catch (err) {
      rep.checks.push(fail("market_status", symbol, "Market status", "/v2/market/status", err));
    }

    checks.push(...rep.checks);
    reports.push(rep);
  }

  const failing = checks.filter((c) => !c.ok);
  const perSymbolOk = (s: SymbolKey, ids: string[]) =>
    ids.every((id) => {
      const c = checks.find((x) => x.id === id && x.symbol === s);
      return c ? c.ok : false;
    });

  const niftyReady = perSymbolOk("NIFTY", ["instrument_resolution", "spot_quote_v3", "historical_candles"]);
  const sensexReady = perSymbolOk("SENSEX", ["instrument_resolution", "spot_quote_v3", "historical_candles"]);

  const conclusion =
    !connected
      ? "NO_DATA_BECAUSE_NO_TOKEN"
      : !niftyReady && !sensexReady
        ? "NO_DATA_BECAUSE_MARKET_DATA_CALLS_FAILED"
        : failing.length > 0
          ? "PARTIAL_DATA_SOME_CALLS_FAILED"
          : "DATA_AVAILABLE";

  return Response.json({
    ok: true,
    connected,
    conclusion,
    checks,
    symbols: reports,
    breakers: breakerSnapshots(),
    recentFailures: lastFailures(),
    summary: { niftyCoreReady: niftyReady, sensexCoreReady: sensexReady, totalChecks: checks.length, failing: failing.length },
    fix:
      failing.length === 0
        ? null
        : failing
            .slice(0, 6)
            .map((f) => `${f.module} (${f.symbol}): ${f.message}${f.correctiveAction ? ` → ${f.correctiveAction}` : ""}`)
            .join(" | "),
  });
}

export async function POST() {
  resetBreakers();
  return Response.json({ ok: true, message: "Circuit breakers and failure records cleared." });
}
