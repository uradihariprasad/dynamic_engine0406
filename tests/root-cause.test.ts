import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";

import { matchQuoteEntry, parseRows, isMarketOpenNow, istParts } from "@/lib/upstox/market";

/** Mirrors normalizeQuoteKey in src/lib/upstox/market.ts. */
function normalizeQuoteKeyTestHelper(k: string): string {
  return k.replace(/[|:\s]+/g, "").toUpperCase();
}
import { parseLegTestHelper } from "./helpers/chain-leg";

/* ------------------------------------------------------------------ *
 * PRIORITY 1 — futures quote identity mapping
 * ------------------------------------------------------------------ */

test("V3 response keys are EXCHANGE:TRADING_SYMBOL, so map-key matching alone must fail", () => {
  const map = { "NSE_FO:NIFTY FUT 29 DEC 26": { last_price: 25390, instrument_token: "NSE_FO|58875" } };
  const byKeyOnly = matchQuoteEntry(map, "NSE_FO|58875");
  assert.equal(byKeyOnly.matchedBy, "INSTRUMENT_TOKEN", "identity must be recovered from instrument_token");
  assert.equal(byKeyOnly.entry?.last_price, 25390);
});

test("instrument_token is the primary identity check for futures", () => {
  const map = {
    "NSE_FO:NIFTY FUT 29 DEC 26": { last_price: 100, instrument_token: "NSE_FO|58875" },
    "NSE_FO:NIFTY FUT 25 JAN 27": { last_price: 200, instrument_token: "NSE_FO|54749" },
  };
  const a = matchQuoteEntry(map, "NSE_FO|58875");
  const b = matchQuoteEntry(map, "NSE_FO|54749");
  assert.equal(a.entry?.last_price, 100, "each contract must match its own quote");
  assert.equal(b.entry?.last_price, 200, "each contract must match its own quote");
  assert.notEqual(a.entry?.last_price, b.entry?.last_price, "quotes must never be cross-assigned between expiries");
});

test("V2 response shape is matched independently via instrument_token", () => {
  const v2 = { "NSE_FO:NIFTY FUT 29 DEC 26": { last_price: 101, instrument_token: "NSE_FO|58875", volume: 5000, oi: 12000000 } };
  const m = matchQuoteEntry(v2, "NSE_FO|58875");
  assert.equal(m.entry?.oi, 12000000);
  assert.equal(m.entry?.volume, 5000);
});

test("trading symbol is an EXACT secondary check — never partial", () => {
  const map = { "BSE_FO:SENSEX FUT 26 NOV 26": { last_price: 81000 } };
  const exact = matchQuoteEntry(map, "BSE_FO|1100929", "SENSEX FUT 26 NOV 26");
  assert.equal(exact.entry?.last_price, 81000);
  const partial = matchQuoteEntry(map, "BSE_FO|9999999", "SENSEX");
  assert.equal(partial.entry, null, "a partial symbol must never match");
  const wrongIndex = matchQuoteEntry(map, "BSE_FO|9999999", "SENSEX50");
  assert.equal(wrongIndex.entry, null, "SENSEX50 is a different instrument and must never match");
});

test("wrong-expiry quotes are never attributed to the requested contract", () => {
  const map = {
    "NSE_FO:NIFTY FUT 25 JAN 27": { last_price: 999, instrument_token: "NSE_FO|54749" },
  };
  const m = matchQuoteEntry(map, "NSE_FO|58875");
  assert.equal(m.entry, null, "a different expiry's quote must not be used");
  assert.deepEqual(m.responseTokens, ["NSE_FO|54749"], "diagnostics must expose what was actually returned");
});

test("mismatch diagnostics expose response keys, tokens and symbols", () => {
  const map = { "NSE_EQ:TECHM": { last_price: 1, instrument_token: "NSE_EQ|3499" } };
  const m = matchQuoteEntry(map, "NSE_FO|58875");
  assert.deepEqual(m.responseKeys, ["NSE_EQ:TECHM"]);
  assert.deepEqual(m.responseTokens, ["NSE_EQ|3499"]);
  assert.equal(m.matchedBy, null);
});

test("index quotes still match by map key", () => {
  const map = { "NSE_INDEX:Nifty 50": { last_price: 25349.65, instrument_token: "NSE_INDEX|Nifty 50" } };
  const m = matchQuoteEntry(map, "NSE_INDEX|Nifty 50");
  assert.equal(m.entry?.last_price, 25349.65);
  assert.equal(m.matchedBy, "MAP_KEY");
});

test("response key normalization is whitespace tolerant but never loose", () => {
  assert.equal(normalizeQuoteKeyTestHelper("NSE_INDEX|Nifty 50"), normalizeQuoteKeyTestHelper("NSE_INDEX: Nifty 50"));
  assert.notEqual(normalizeQuoteKeyTestHelper("NSE_INDEX|Nifty 50"), normalizeQuoteKeyTestHelper("NSE_INDEX|Nifty 500"));
});

/* ------------------------------------------------------------------ *
 * PRIORITY 3/4 — option chain parser and Greeks
 * ------------------------------------------------------------------ */

test("the documented option-chain shape (data as an array) must yield strike rows", () => {
  // This is the exact shape that the previous parser mis-read as data.data → 0 rows.
  const payload = {
    status: "success",
    data: [
      {
        expiry: "2026-12-24",
        pcr: 0.9,
        strike_price: 25350,
        underlying_spot_price: 25349.65,
        call_options: {
          instrument_key: "NSE_FO|12345",
          market_data: { ltp: 150.5, volume: 1000, oi: 1000000, close_price: 145, bid_price: 150, bid_qty: 100, ask_price: 151, ask_qty: 120, prev_oi: 950000 },
          option_greeks: { delta: 0.52, gamma: 0.0011, theta: -18.2, vega: 12.4, iv: 10.5, pop: 42.1 },
        },
        put_options: {
          instrument_key: "NSE_FO|12346",
          market_data: { ltp: 120.25, volume: 800, oi: 900000, close_price: 128, bid_price: 120, bid_qty: 90, ask_price: 121, ask_qty: 95, prev_oi: 910000 },
          option_greeks: { delta: -0.48, gamma: 0.001, theta: -17.9, vega: 12.1, iv: 11.2, pop: 57.9 },
        },
      },
    ],
  };
  const leg = parseLegTestHelper(payload.data[0].call_options);
  assert.equal(leg.ltp, 150.5, "market_data.ltp must map");
  assert.equal(leg.oi, 1000000, "market_data.oi must map");
  assert.equal(leg.prevOi, 950000, "market_data.prev_oi must map");
  assert.equal(leg.delta, 0.52, "option_greeks.delta must map to the CE leg");
  assert.equal(leg.iv, 10.5);
  const pe = parseLegTestHelper(payload.data[0].put_options);
  assert.equal(pe.delta, -0.48, "PE Greeks must map to the PE leg independently");
  assert.notEqual(pe.delta, leg.delta, "CE and PE Greeks must never be cross-mapped");
});

test("a missing optional Greek does not reject the strike row", () => {
  const leg = parseLegTestHelper({
    instrument_key: "NSE_FO|1",
    market_data: { ltp: 10, volume: 5, oi: 100 },
    option_greeks: { delta: 0.3 },
  });
  assert.equal(leg.delta, 0.3, "available Greeks are preserved");
  assert.equal(leg.gamma, null, "missing Greeks are null, never zero");
  assert.equal(leg.theta, null);
});

test("missing market-data fields are null, never zero", () => {
  const leg = parseLegTestHelper({ instrument_key: "NSE_FO|2", market_data: {} });
  assert.equal(leg.ltp, null);
  assert.equal(leg.oi, null);
  assert.equal(leg.volume, null);
  assert.equal(leg.bidPrice, null);
});

/* ------------------------------------------------------------------ *
 * PRIORITY 7 — candles
 * ------------------------------------------------------------------ */

test("a candle window with no rows parses to an empty, non-invalid result", () => {
  const parsed = parseRows({ status: "success", data: { candles: [] } });
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.invalidRows, 0, "an empty window is not an error");
});

test("candle parser accepts the documented v3 shape and preserves ordering", () => {
  const payload = {
    status: "success",
    data: {
      candles: [
        ["2026-11-23T09:20:00+05:30", 100, 110, 95, 105, 1000],
        ["2026-11-23T09:15:00+05:30", 98, 108, 94, 100, 900],
        ["2026-11-23T09:25:00+05:30", 105, 112, 104, 110, 1100],
      ],
    },
  };
  const parsed = parseRows(payload);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows.map((r) => r.ts), [...parsed.rows.map((r) => r.ts)].sort((a, b) => a - b), "rows must be chronologically ordered");
});

/* ------------------------------------------------------------------ *
 * Market session handling
 * ------------------------------------------------------------------ */

test("market session detection uses IST 09:15–15:30 Mon–Fri", () => {
  // 2026-11-23 is a Monday. 10:00 IST = 04:30 UTC.
  const mondayOpen = Date.UTC(2026, 10, 23, 4, 30) ;
  assert.equal(isMarketOpenNow(mondayOpen), true);
  // 17:32 IST = 12:02 UTC → after close.
  const mondayAfterClose = Date.UTC(2026, 10, 23, 12, 2);
  assert.equal(isMarketOpenNow(mondayAfterClose), false, "an intraday response after close must be classified as market closed");
  // Saturday 10:00 IST.
  const saturday = Date.UTC(2026, 10, 28, 4, 30);
  assert.equal(isMarketOpenNow(saturday), false);
  // 09:00 IST is before the open.
  const mondayPreOpen = Date.UTC(2026, 10, 23, 3, 30);
  assert.equal(isMarketOpenNow(mondayPreOpen), false);
});

test("IST date derivation does not drift across the UTC boundary", () => {
  // 2026-11-23T20:00Z = 2026-11-24 01:30 IST → the IST date must roll forward.
  const parts = istParts(Date.UTC(2026, 10, 23, 20, 0));
  assert.equal(parts.date, "2026-11-24");
  assert.equal(parts.minutes, 90);
});
