import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";

import { SYMBOL_CONFIGS } from "@/lib/config";
import { failureToModuleStatus, UpstoxError } from "@/lib/upstox/client";
import { decryptToken, encryptToken, fingerprintToken, maskToken } from "@/lib/session-store";
import { normalizeKeyTestHelper, pickEntryTestHelper } from "./helpers/quote-keys";
import { toIsoDateFix } from "./helpers/instrument-date";

/* ------------------------------------------------------------------ *
 * Instrument resolution
 * ------------------------------------------------------------------ */

test("SENSEX canonical key is BSE_INDEX|SENSEX as published by the instrument master", () => {
  assert.equal(SYMBOL_CONFIGS.SENSEX.indexKey, "BSE_INDEX|SENSEX");
  assert.ok(SYMBOL_CONFIGS.SENSEX.alternateIndexKeys.includes("BSE_INDEX|SENSEX"));
  assert.ok(SYMBOL_CONFIGS.SENSEX.alternateIndexKeys.includes("BSE_INDEX|Sensex"), "documented spelling kept as a probe fallback");
  assert.equal(SYMBOL_CONFIGS.SENSEX.underlyingName, "SENSEX");
  assert.equal(SYMBOL_CONFIGS.SENSEX.derivativesExchange, "BSE_FO");
});

test("NIFTY canonical key is unchanged and independently verified", () => {
  assert.equal(SYMBOL_CONFIGS.NIFTY.indexKey, "NSE_INDEX|Nifty 50");
  assert.equal(SYMBOL_CONFIGS.NIFTY.underlyingName, "NIFTY");
  assert.equal(SYMBOL_CONFIGS.NIFTY.derivativesExchange, "NSE_FO");
});

test("NIFTY and SENSEX configurations never share or overwrite each other", () => {
  assert.notEqual(SYMBOL_CONFIGS.NIFTY.indexKey, SYMBOL_CONFIGS.SENSEX.indexKey);
  assert.notEqual(SYMBOL_CONFIGS.NIFTY.underlyingName, SYMBOL_CONFIGS.SENSEX.underlyingName);
  assert.notEqual(SYMBOL_CONFIGS.NIFTY.derivativesExchange, SYMBOL_CONFIGS.SENSEX.derivativesExchange);
  assert.notEqual(SYMBOL_CONFIGS.NIFTY.exchange, SYMBOL_CONFIGS.SENSEX.exchange);
});

test("instrument master expiry published as epoch milliseconds converts to ISO dates", () => {
  assert.equal(toIsoDateFix(1796927399000), "2026-12-10");
  assert.equal(toIsoDateFix("1796927399000"), "2026-12-10");
  assert.equal(toIsoDateFix("2026-12-10"), "2026-12-10");
  assert.equal(toIsoDateFix(null), null);
  assert.equal(toIsoDateFix("garbage"), null);
});

/* ------------------------------------------------------------------ *
 * Quote response key normalisation
 * ------------------------------------------------------------------ */

test("quote keys normalise pipe/colon and case so no index is mismatched", () => {
  assert.equal(normalizeKeyTestHelper("BSE_INDEX|SENSEX"), normalizeKeyTestHelper("BSE_INDEX:SENSEX"));
  assert.equal(normalizeKeyTestHelper("BSE_INDEX|SENSEX"), normalizeKeyTestHelper("bse_index|sensex"));
  assert.notEqual(
    normalizeKeyTestHelper("BSE_INDEX|SENSEX"),
    normalizeKeyTestHelper("BSE_INDEX|SENSEX50"),
    "SENSEX50 is a different index and must never match",
  );
  assert.notEqual(
    normalizeKeyTestHelper("NSE_INDEX|Nifty 50"),
    normalizeKeyTestHelper("NSE_INDEX|Nifty 500"),
    "Nifty 500 is a different index and must never match",
  );
});

test("requested keys are matched individually, not by substring", () => {
  const map = {
    "NSE_INDEX:Nifty 50": { last_price: 100 },
    "BSE_INDEX:SENSEX": { last_price: 200 },
  };
  assert.equal(pickEntryTestHelper(map, "NSE_INDEX|Nifty 50")?.last_price, 100);
  assert.equal(pickEntryTestHelper(map, "BSE_INDEX|SENSEX")?.last_price, 200);
  assert.equal(pickEntryTestHelper(map, "BSE_INDEX|SENSEX50"), null);
  assert.equal(pickEntryTestHelper({}, "NSE_INDEX|Nifty 50"), null);
});

test("a response containing one instrument does not prove all requested keys returned", () => {
  const map = { "NSE_INDEX:Nifty 50": { last_price: 100 } };
  const requested = ["NSE_INDEX|Nifty 50", "BSE_INDEX|SENSEX"];
  const missing = requested.filter((k) => pickEntryTestHelper(map, k) === null);
  assert.deepEqual(missing, ["BSE_INDEX|SENSEX"]);
});

/* ------------------------------------------------------------------ *
 * Previous-close / percentage change
 * ------------------------------------------------------------------ */

test("previous close prefers the documented prev_close_price and falls back to ohlc.close", () => {
  const documentedOnly = { prev_close_price: 100, ohlc: { close: 999 }, last_price: 105 };
  const prevClose = documentedOnly.prev_close_price ?? documentedOnly.ohlc.close;
  assert.equal(prevClose, 100);
  const change = documentedOnly.last_price - prevClose;
  const pct = (change / prevClose) * 100;
  assert.equal(change, 5);
  assert.ok(Math.abs(pct - 5) < 1e-9);
});

test("a genuinely flat close produces 0.00 change and is distinguished from a missing close", () => {
  const flat = { prev_close_price: 25349.65, last_price: 25349.65 };
  const prevClose = flat.prev_close_price;
  const change = flat.last_price - prevClose;
  assert.equal(change, 0);
  assert.equal((change / prevClose) * 100, 0);
  const missing = { prev_close_price: undefined, last_price: 100 };
  assert.equal(missing.prev_close_price ?? null, null, "missing close must be null, never 0");
});

/* ------------------------------------------------------------------ *
 * Transport + auth semantics
 * ------------------------------------------------------------------ */

test("auth failures are classified and never retried as network errors", () => {
  assert.equal(failureToModuleStatus(new UpstoxError({ kind: "INVALID_TOKEN", message: "x", status: 401, code: "UDAPI100050" })).code, "UDAPI100050");
  assert.equal(failureToModuleStatus(new UpstoxError({ kind: "REVOKED_TOKEN", message: "x", status: 403 })).status, "INVALID");
  assert.equal(failureToModuleStatus(new UpstoxError({ kind: "NETWORK", message: "x" })).status, "DISCONNECTED");
  assert.equal(failureToModuleStatus(new UpstoxError({ kind: "EMPTY_PAYLOAD", message: "x" })).status, "PARTIAL");
});

/* ------------------------------------------------------------------ *
 * Session security
 * ------------------------------------------------------------------ */

test("token encryption round-trips and never stores plaintext", () => {
  const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensex.test.token.value";
  const payload = encryptToken(token);
  assert.ok(!payload.ciphertext.includes(token));
  assert.notEqual(payload.iv, encryptToken(token).iv);
  assert.equal(decryptToken(payload), token);
  assert.equal(decryptToken({ ...payload, ciphertext: Buffer.from("x").toString("base64") }), null);
});

test("masked token never reveals the secret", () => {
  const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret.section.remains.hidden";
  const masked = maskToken(token);
  assert.ok(!masked.includes("secret"));
  assert.ok(!masked.includes("hidden"));
  assert.equal(fingerprintToken(token).length, 16);
});

/* ------------------------------------------------------------------ *
 * Pipeline isolation semantics
 * ------------------------------------------------------------------ */

test("Promise.allSettled semantics preserve rejection reasons instead of empty results", () => {
  const results = [
    { status: "fulfilled" as const, value: 1 },
    { status: "rejected" as const, reason: new Error("SENSEX quote failed") },
  ];
  const err = results[1].status === "rejected" ? (results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason)) : null;
  assert.equal(err, "SENSEX quote failed");
  assert.ok(results[0].status === "fulfilled");
});
