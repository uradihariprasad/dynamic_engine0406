import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";

import { SYMBOL_CONFIGS } from "@/lib/config";
import { failureToModuleStatus, UpstoxError } from "@/lib/upstox/client";
import { decryptToken, encryptToken, fingerprintToken, maskToken } from "@/lib/session-store";
import { toIsoDateFix } from "./helpers/instrument-date";

/* ------------------------------------------------------------------ *
 * Authentication transport semantics
 * ------------------------------------------------------------------ */

test("auth failures are classified, never retried as network errors", () => {
  const invalid = failureToModuleStatus(
    new UpstoxError({ kind: "INVALID_TOKEN", message: "Invalid token", status: 401, code: "UDAPI100050" }),
  );
  assert.equal(invalid.status, "INVALID");
  assert.equal(invalid.code, "UDAPI100050");

  const expired = failureToModuleStatus(
    new UpstoxError({ kind: "EXPIRED_TOKEN", message: "Token expired", status: 401 }),
  );
  assert.equal(expired.status, "INVALID");

  const revoked = failureToModuleStatus(
    new UpstoxError({ kind: "REVOKED_TOKEN", message: "Forbidden", status: 403 }),
  );
  assert.equal(revoked.status, "INVALID");

  const net = failureToModuleStatus(new UpstoxError({ kind: "NETWORK", message: "Network failure" }));
  assert.equal(net.status, "DISCONNECTED");

  const noToken = failureToModuleStatus(new UpstoxError({ kind: "NO_TOKEN", message: "No token" }));
  assert.equal(noToken.status, "UNAVAILABLE");

  const rate = failureToModuleStatus(new UpstoxError({ kind: "RATE_LIMITED", message: "429" }));
  assert.equal(rate.status, "STALE");
});

test("documented instrument keys and underlying symbols are wired per symbol", () => {
  assert.equal(SYMBOL_CONFIGS.NIFTY.indexKey, "NSE_INDEX|Nifty 50");
  assert.equal(SYMBOL_CONFIGS.NIFTY.derivativesExchange, "NSE_FO");
  assert.equal(SYMBOL_CONFIGS.NIFTY.underlyingName, "NIFTY");
  // The instrument master publishes BSE_INDEX|SENSEX; that is the canonical API key.
  assert.equal(SYMBOL_CONFIGS.SENSEX.indexKey, "BSE_INDEX|SENSEX");
  assert.equal(SYMBOL_CONFIGS.SENSEX.derivativesExchange, "BSE_FO");
  assert.equal(SYMBOL_CONFIGS.SENSEX.underlyingName, "SENSEX");
});

/* ------------------------------------------------------------------ *
 * Instrument master: expiry is published as epoch milliseconds
 * ------------------------------------------------------------------ */

test("epoch-millisecond expiry values are converted to ISO dates", () => {
  // 1796927399000 -> 2026-12-10 (UTC)
  assert.equal(toIsoDateFix(1796927399000), "2026-12-10");
  assert.equal(toIsoDateFix("1796927399000"), "2026-12-10");
});

test("ISO and short-numeric expiry values are also accepted", () => {
  assert.equal(toIsoDateFix("2026-12-10"), "2026-12-10");
  assert.equal(toIsoDateFix("2026-12-10T14:00:00+05:30"), "2026-12-10");
  assert.equal(toIsoDateFix(1796927399), "2026-12-10");
});

test("invalid expiry values never resolve to a fabricated date", () => {
  assert.equal(toIsoDateFix(""), null);
  assert.equal(toIsoDateFix("not-a-date"), null);
  assert.equal(toIsoDateFix(null), null);
  assert.equal(toIsoDateFix(undefined), null);
});

/* ------------------------------------------------------------------ *
 * Session store: token is never persisted or exposed in plaintext
 * ------------------------------------------------------------------ */

test("token encryption round-trips and never stores plaintext", () => {
  const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.token.value.abc123";
  const payload = encryptToken(token);
  assert.ok(!payload.ciphertext.includes(token), "ciphertext must not contain the plaintext token");
  assert.notEqual(payload.iv, encryptToken(token).iv, "IV must be random per encryption");
  assert.equal(decryptToken(payload), token);
});

test("tampered or mismatched ciphertext yields null, never a token", () => {
  const payload = encryptToken("another-token-value-0123456789");
  const tampered = { ...payload, ciphertext: Buffer.from("garbage").toString("base64") };
  assert.equal(decryptToken(tampered), null);
  const badTag = { ...payload, authTag: Buffer.from("0".repeat(16)).toString("base64") };
  assert.equal(decryptToken(badTag), null);
});

test("masked token never reveals the secret", () => {
  const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.middle.section.remains.hidden";
  const masked = maskToken(token);
  assert.ok(!masked.includes("middle"));
  assert.ok(!masked.includes("hidden"));
  assert.ok(masked.startsWith("eyJ"));
  assert.ok(masked.includes("len"));

  const fp = fingerprintToken(token);
  assert.equal(fp.length, 16);
  assert.notEqual(fp, token);
  assert.equal(fingerprintToken(token), fingerprintToken(token), "fingerprint must be deterministic");
});

/* ------------------------------------------------------------------ *
 * Session semantics
 * ------------------------------------------------------------------ */

test("disconnect clears the session from the owning process", async () => {
  const { setSession, isConnected, describeSession, disconnect } = await import("@/lib/upstox/session");
  setSession({ token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.disconnect.test.token.value", sessionId: "s1" });
  assert.equal(isConnected(), true);
  assert.equal(describeSession().active, true);
  await disconnect();
  assert.equal(isConnected(), false);
  assert.equal(await getTokenSafe(), null);
  assert.equal(describeSession().active, false);
});

test("a replaced token invalidates the previous session fingerprint", async () => {
  const { setSession, describeSession, disconnect } = await import("@/lib/upstox/session");
  setSession({ token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.first.token.value.aaaaaaaa", sessionId: "s1" });
  const first = describeSession().tokenFingerprint;
  setSession({ token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.second.token.value.bbbbbbbb", sessionId: "s2" });
  const second = describeSession().tokenFingerprint;
  assert.notEqual(first, second, "replacing the token must change the fingerprint");
  assert.equal(describeSession().sessionId, "s2");
  await disconnect();
});

test("describeSession reports process identity for consistency checks", async () => {
  const { describeSession, processId } = await import("@/lib/upstox/session");
  const info = describeSession();
  assert.ok(info.processId.length > 0);
  assert.equal(info.processId, processId());
});

async function getTokenSafe(): Promise<string | null> {
  const mod = await import("@/lib/upstox/session");
  return mod.getToken();
}
