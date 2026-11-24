/**
 * Upstox REST transport.
 *
 * - Token-bucket rate limiter (global) + per-endpoint minimum spacing.
 * - Exponential backoff with jitter for 429 / 5xx / network errors ONLY.
 *   Authentication and invalid-instrument-key failures are never retried as if
 *   they were transient network problems.
 * - **Per-endpoint-group** circuit breakers: a repeated failure on an optional
 *   endpoint can never poison the whole pipeline.
 * - Every request is recorded (endpoint, HTTP status, Upstox error code, latency,
 *   record count) for the diagnostics dashboard. Tokens/headers are never logged.
 */

export type UpstoxFailureKind =
  | "NO_TOKEN"
  | "INVALID_TOKEN"
  | "EXPIRED_TOKEN"
  | "REVOKED_TOKEN"
  | "RATE_LIMITED"
  | "NETWORK"
  | "TIMEOUT"
  | "SERVER"
  | "NOT_FOUND"
  | "BAD_RESPONSE"
  | "EMPTY_PAYLOAD"
  | "CIRCUIT_OPEN";

export class UpstoxError extends Error {
  readonly kind: UpstoxFailureKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly detail: string | null;
  readonly endpoint: string;

  constructor(args: {
    kind: UpstoxFailureKind;
    message: string;
    status?: number | null;
    code?: string | null;
    detail?: string | null;
    endpoint?: string;
  }) {
    super(args.message);
    this.name = "UpstoxError";
    this.kind = args.kind;
    this.status = args.status ?? null;
    this.code = args.code ?? null;
    this.detail = args.detail ?? null;
    this.endpoint = args.endpoint ?? "";
  }
}

const BASE_URL = process.env.UPSTOX_BASE_URL ?? "https://api.upstox.com";
const MAX_RPS = Number(process.env.UPSTOX_MAX_RPS ?? 6);
const REQUEST_TIMEOUT_MS = Number(process.env.UPSTOX_TIMEOUT_MS ?? 15000);

const bucket = { capacity: Math.max(2, MAX_RPS * 2), tokens: Math.max(2, MAX_RPS * 2), lastRefill: Date.now() };
const lastCallAt = new Map<string, number>();

interface BreakerState {
  failures: number;
  openedAt: number;
}
const BREAKER_THRESHOLD = 4;
const BREAKER_OPEN_MS = 15000;
const breakers = new Map<string, BreakerState>();
const lastFailure = new Map<string, { kind: UpstoxFailureKind; message: string; status: number | null; code: string | null; at: number }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function refill(): void {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  if (elapsed <= 0) return;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * MAX_RPS);
  bucket.lastRefill = now;
}

async function waitForToken(): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    refill();
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    await sleep(20);
  }
  throw new UpstoxError({ kind: "RATE_LIMITED", message: "Local rate limiter saturated" });
}

function groupKey(path: string): string {
  return path.split("?")[0];
}

export interface BreakerSnapshot {
  group: string;
  open: boolean;
  failures: number;
  openedAt: number;
}

export function breakerState(group?: string): { open: boolean; failures: number; openedAt: number } {
  const key = group ? groupKey(group) : "";
  const b = key ? breakers.get(key) : null;
  if (!b) return { open: false, failures: 0, openedAt: 0 };
  return { open: b.openedAt > 0 && Date.now() - b.openedAt < BREAKER_OPEN_MS, failures: b.failures, openedAt: b.openedAt };
}

export function breakerSnapshots(): BreakerSnapshot[] {
  return [...breakers.entries()].map(([group, b]) => ({
    group,
    open: b.openedAt > 0 && Date.now() - b.openedAt < BREAKER_OPEN_MS,
    failures: b.failures,
    openedAt: b.openedAt,
  }));
}

export function recordFailure(group: string, kind: UpstoxFailureKind, message: string, status: number | null, code: string | null): void {
  lastFailure.set(groupKey(group), { kind, message, status, code, at: Date.now() });
}

export function lastFailures(): Array<{ group: string; kind: string; message: string; status: number | null; code: string | null; at: string }> {
  return [...lastFailure.entries()].map(([group, f]) => ({
    group,
    kind: f.kind,
    message: f.message,
    status: f.status,
    code: f.code,
    at: new Date(f.at).toISOString(),
  }));
}

export function resetBreakers(): void {
  breakers.clear();
  lastFailure.clear();
}

/** Extracts Upstox's structured error code (e.g. UDAPI100050) from any response shape. */
function extractApiCode(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const errors = obj.errors;
  if (Array.isArray(errors) && errors.length > 0 && errors[0] && typeof errors[0] === "object") {
    const e = errors[0] as Record<string, unknown>;
    if (typeof e.errorCode === "string") return e.errorCode;
    if (typeof e.error_code === "string") return e.error_code;
  }
  if (typeof obj.errorCode === "string") return obj.errorCode;
  if (typeof obj.error_code === "string") return obj.error_code;
  return null;
}

function extractApiMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const errors = obj.errors;
  if (Array.isArray(errors) && errors.length > 0 && errors[0] && typeof errors[0] === "object") {
    const e = errors[0] as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
  }
  if (typeof obj.message === "string") return obj.message;
  return null;
}

function classifyStatus(status: number, body: string, code: string | null): UpstoxFailureKind {
  if (status === 401 || status === 403) {
    // UDAPI100050 = invalid token; token-related 403s mean revoked / no entitlement.
    if (/expired/i.test(body)) return "EXPIRED_TOKEN";
    if (status === 403) return "REVOKED_TOKEN";
    return "INVALID_TOKEN";
  }
  if (status === 429) return "RATE_LIMITED";
  if (status === 404) return "NOT_FOUND";
  if (status >= 500) return "SERVER";
  if (/invalid.*instrument|instrument.*key/i.test(body)) return "BAD_RESPONSE";
  return "BAD_RESPONSE";
}

export interface UpstoxRequestOptions {
  path: string;
  token: string | null;
  minIntervalMs?: number;
  retries?: number;
  query?: Record<string, string | undefined>;
  accept?: string;
  /** Optional endpoints never trip a breaker and never block the critical path. */
  critical?: boolean;
  /** True when a 200 response with zero records must be treated as EMPTY, not LIVE. */
  validate?: (data: unknown) => { ok: boolean; recordCount: number; problem?: string };
}

export interface UpstoxResponse<T> {
  data: T;
  status: number;
  receivedAt: number;
  elapsedMs: number;
  recordCount: number;
  validation: "VALID" | "EMPTY" | "PARTIAL";
}

export async function upstoxRequest<T>(opts: UpstoxRequestOptions): Promise<UpstoxResponse<T>> {
  const started = Date.now();
  const group = groupKey(opts.path);
  const critical = opts.critical ?? true;
  const token = opts.token;

  if (critical) {
    const b = breakerState(group);
    if (b.open) {
      const err = new UpstoxError({
        kind: "CIRCUIT_OPEN",
        message: `Circuit breaker open for ${group} (failures=${b.failures})`,
        endpoint: group,
      });
      recordFailure(group, err.kind, err.message, null, null);
      throw err;
    }
  }

  const minIntervalMs = opts.minIntervalMs ?? 0;
  if (minIntervalMs > 0) {
    const last = lastCallAt.get(group);
    if (last !== undefined && Date.now() - last < minIntervalMs) {
      await sleep(minIntervalMs - (Date.now() - last));
    }
  }

  const url = new URL(`${BASE_URL}${opts.path}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = { Accept: opts.accept ?? "application/json" };
  if (!token) {
    const err = new UpstoxError({
      kind: "NO_TOKEN",
      message: "No Upstox access token in backend session. Connect from Settings to enable live data.",
      endpoint: group,
    });
    recordFailure(group, err.kind, err.message, null, null);
    throw err;
  }
  headers.Authorization = `Bearer ${token}`;

  const retries = opts.retries ?? 3;
  let lastError: UpstoxError | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await waitForToken();
    if (minIntervalMs > 0) lastCallAt.set(group, Date.now());
    try {
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      const apiCode = extractApiCode(parsed);
      const apiMessage = extractApiMessage(parsed);

      if (!res.ok) {
        const kind = classifyStatus(res.status, text, apiCode);
        lastError = new UpstoxError({
          kind,
          message: `${apiMessage ?? `Upstox HTTP ${res.status}`} on ${group}`,
          status: res.status,
          code: apiCode,
          detail: text.slice(0, 300),
          endpoint: group,
        });
        // Auth / not-found / bad-request failures are deterministic: never retry them.
        const retryable = kind === "RATE_LIMITED" || kind === "SERVER";
        if (!retryable || attempt === retries) break;
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        const backoff = Math.max(retryAfter * 1000, 250 * 2 ** attempt) + Math.random() * 150;
        await sleep(Math.min(backoff, 4000));
        continue;
      }

      let validation: UpstoxResponse<T>["validation"] = "VALID";
      let recordCount = 0;
      if (opts.validate) {
        const v = opts.validate(parsed);
        recordCount = v.recordCount;
        validation = v.ok ? "VALID" : v.recordCount > 0 ? "PARTIAL" : "EMPTY";
        if (!v.ok) {
          const err = new UpstoxError({
            kind: "EMPTY_PAYLOAD",
            message: `${group} returned HTTP ${res.status} but ${v.problem ?? "no usable records"}`,
            status: res.status,
            code: apiCode,
            endpoint: group,
          });
          recordFailure(group, err.kind, err.message, res.status, apiCode);
          throw err;
        }
      } else if (parsed && typeof parsed === "object") {
        const data = (parsed as { data?: unknown }).data;
        if (Array.isArray(data)) recordCount = data.length;
        else if (data && typeof data === "object") recordCount = Object.keys(data as Record<string, unknown>).length;
        if (recordCount === 0) validation = "EMPTY";
      }

      const b = breakers.get(group);
      if (b) breakers.set(group, { failures: 0, openedAt: 0 });
      return { data: parsed as T, status: res.status, receivedAt: Date.now(), elapsedMs: Date.now() - started, recordCount, validation };
    } catch (err) {
      if (err instanceof UpstoxError) {
        lastError = err;
        break;
      }
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      lastError = new UpstoxError({
        kind: isTimeout ? "TIMEOUT" : "NETWORK",
        message: isTimeout ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${group}` : `Network failure reaching ${group}`,
        detail: err instanceof Error ? err.message : String(err),
        endpoint: group,
      });
      if (attempt === retries) break;
      await sleep(Math.min(300 * 2 ** attempt + Math.random() * 200, 5000));
    }
  }

  if (critical) {
    const b = breakers.get(group) ?? { failures: 0, openedAt: 0 };
    const failures = b.failures + 1;
    breakers.set(group, { failures, openedAt: failures >= BREAKER_THRESHOLD ? Date.now() : b.openedAt });
  }
  if (lastError) {
    recordFailure(group, lastError.kind, lastError.message, lastError.status, lastError.code);
    throw lastError;
  }
  throw new UpstoxError({ kind: "BAD_RESPONSE", message: "Upstox request failed", endpoint: group });
}

export function failureToModuleStatus(err: unknown): { status: string; message: string; kind?: string; code?: string | null } {
  if (err instanceof UpstoxError) {
    const map: Record<UpstoxFailureKind, string> = {
      NO_TOKEN: "UNAVAILABLE",
      INVALID_TOKEN: "INVALID",
      EXPIRED_TOKEN: "INVALID",
      REVOKED_TOKEN: "INVALID",
      RATE_LIMITED: "STALE",
      NETWORK: "DISCONNECTED",
      TIMEOUT: "DISCONNECTED",
      SERVER: "STALE",
      NOT_FOUND: "UNAVAILABLE",
      BAD_RESPONSE: "INVALID",
      EMPTY_PAYLOAD: "PARTIAL",
      CIRCUIT_OPEN: "DISCONNECTED",
    };
    return { status: map[err.kind], message: err.message, kind: err.kind, code: err.code };
  }
  return { status: "INVALID", message: err instanceof Error ? err.message : String(err), kind: "BAD_RESPONSE", code: null };
}
