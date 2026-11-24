import {
  SESSION_TTL_MS,
  clearPersistedSession,
  fingerprintToken,
  loadPersistedSession,
  maskToken,
  maskToken as mask,
  persistSession,
  touchPersistedSession,
} from "@/lib/session-store";

/**
 * Upstox session registry.
 *
 * Two-layer design:
 *  1. `globalThis` memory — fastest path, used by every market-data request.
 *  2. Encrypted shared store (PostgreSQL) — lets a different worker/instance, or a
 *     restarted process, hydrate the same session instead of reporting "no token".
 *
 * The raw token is exposed only through `getToken()` for server-side API calls.
 * Every public surface returns masked data only.
 */

export type TokenStatus = "VALID" | "INVALID" | "EXPIRED" | "REVOKED" | "NETWORK_ERROR" | "UPSTOX_SERVICE_ERROR" | "UNKNOWN";

export interface UpstoxSessionInfo {
  sessionId: string;
  maskedToken: string;
  tokenFingerprint: string;
  connectedAt: string;
  lastValidatedAt: string;
  expiresAt: string;
  userName: string | null;
  userId: string | null;
  exchanges: string[];
  active: boolean;
  /** Process that owns the in-memory token, for diagnostics. */
  processId: string;
  /** True when the session was restored from the encrypted shared store. */
  restoredFromStore: boolean;
  /** Whether the encrypted shared store was reachable when this session was written. */
  storeWritable: boolean;
  storeError: string | null;
}

interface MemorySession {
  sessionId: string;
  token: string;
  maskedToken: string;
  tokenFingerprint: string;
  connectedAt: number;
  lastValidatedAt: number;
  expiresAt: number;
  userName: string | null;
  userId: string | null;
  exchanges: string[];
  restoredFromStore: boolean;
  storeWritable: boolean;
  storeError: string | null;
}

interface TransportMetrics {
  lastRequestAt: number | null;
  lastRequestEndpoint: string | null;
  lastRequestOk: boolean | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastErrorCode: string | null;
  totalRequests: number;
  totalFailures: number;
}

const PROCESS_ID = `${process.pid}-${Date.now().toString(36)}`;

const globalForSession = globalThis as typeof globalThis & {
  __deSession?: MemorySession | null;
  __deSessionMetrics?: TransportMetrics;
  __deSessionHydrated?: boolean;
};

function metrics(): TransportMetrics {
  globalForSession.__deSessionMetrics ??= {
    lastRequestAt: null,
    lastRequestEndpoint: null,
    lastRequestOk: null,
    lastError: null,
    lastErrorAt: null,
    lastErrorCode: null,
    totalRequests: 0,
    totalFailures: 0,
  };
  return globalForSession.__deSessionMetrics;
}

function mem(): { get(): MemorySession | null; set(s: MemorySession): void; clear(): void } {
  const ref = globalForSession;
  return {
    get: () => ref.__deSession ?? null,
    set: (s) => {
      ref.__deSession = s;
    },
    clear: () => {
      ref.__deSession = null;
      ref.__deSessionHydrated = false;
    },
  };
}

export function setSession(params: {
  token: string;
  sessionId: string;
  userName?: string | null;
  userId?: string | null;
  exchanges?: string[];
}): UpstoxSessionInfo {
  const now = Date.now();
  const session: MemorySession = {
    sessionId: params.sessionId,
    token: params.token.trim(),
    maskedToken: mask(params.token),
    tokenFingerprint: fingerprintToken(params.token),
    connectedAt: now,
    lastValidatedAt: now,
    expiresAt: now + SESSION_TTL_MS,
    userName: params.userName ?? null,
    userId: params.userId ?? null,
    exchanges: params.exchanges ?? [],
    restoredFromStore: false,
    storeWritable: false,
    storeError: null,
  };
  mem().set(session);
  return describeSession();
}

export function markStoreWritable(ok: boolean, error: string | null): void {
  const s = mem().get();
  if (s) mem().set({ ...s, storeWritable: ok, storeError: error });
}

export function updateValidationTs(): void {
  const s = mem().get();
  if (!s) return;
  mem().set({ ...s, lastValidatedAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
}

/**
 * Ensures the in-memory session exists, hydrating from the encrypted shared store
 * when this process has never seen the token (restart / different worker).
 */
export async function ensureSessionLoaded(): Promise<boolean> {
  const s = mem().get();
  if (s) {
    if (s.expiresAt < Date.now()) {
      mem().clear();
      return false;
    }
    return true;
  }
  if (globalForSession.__deSessionHydrated) return false;
  globalForSession.__deSessionHydrated = true;
  const persisted = await loadPersistedSession();
  if (!persisted) return false;
  mem().set({
    sessionId: `sess_${fingerprintToken(persisted.token)}`,
    token: persisted.token,
    maskedToken: persisted.meta.maskedToken,
    tokenFingerprint: persisted.meta.tokenFingerprint,
    connectedAt: new Date(persisted.meta.connectedAt).getTime(),
    lastValidatedAt: new Date(persisted.meta.lastValidatedAt).getTime(),
    expiresAt: new Date(persisted.meta.expiresAt).getTime(),
    userName: persisted.meta.userName,
    userId: persisted.meta.userId,
    exchanges: persisted.meta.exchanges,
    restoredFromStore: true,
    storeWritable: true,
    storeError: null,
  });
  return true;
}

/** Returns the raw token for server-side API calls only. Never expose this value. */
export function getToken(): string | null {
  const s = mem().get();
  if (!s) return null;
  if (s.expiresAt < Date.now()) return null;
  return s.token;
}

export function getSessionId(): string | null {
  return mem().get()?.sessionId ?? null;
}

export function describeSession(): UpstoxSessionInfo {
  const s = mem().get();
  if (!s) {
    return {
      sessionId: "",
      maskedToken: "",
      tokenFingerprint: "",
      connectedAt: "",
      lastValidatedAt: "",
      expiresAt: "",
      userName: null,
      userId: null,
      exchanges: [],
      active: false,
      processId: PROCESS_ID,
      restoredFromStore: false,
      storeWritable: false,
      storeError: null,
    };
  }
  return {
    sessionId: s.sessionId,
    maskedToken: s.maskedToken,
    tokenFingerprint: s.tokenFingerprint,
    connectedAt: new Date(s.connectedAt).toISOString(),
    lastValidatedAt: new Date(s.lastValidatedAt).toISOString(),
    expiresAt: new Date(s.expiresAt).toISOString(),
    userName: s.userName,
    userId: s.userId,
    exchanges: s.exchanges,
    active: true,
    processId: PROCESS_ID,
    restoredFromStore: s.restoredFromStore,
    storeWritable: s.storeWritable,
    storeError: s.storeError,
  };
}

export function isConnected(): boolean {
  return mem().get() !== null && getToken() !== null;
}

export function maskOf(token: string): string {
  return maskToken(token);
}

export async function disconnect(): Promise<void> {
  mem().clear();
  await clearPersistedSession();
}

/* ------------------------------------------------------------------ *
 * Transport metrics (consumed by /api/session and /api/diagnostics)
 * ------------------------------------------------------------------ */

export function recordRequest(endpoint: string, ok: boolean, errorCode: string | null, message: string | null): void {
  const m = metrics();
  m.totalRequests += 1;
  m.lastRequestAt = Date.now();
  m.lastRequestEndpoint = endpoint;
  m.lastRequestOk = ok;
  if (!ok) {
    m.totalFailures += 1;
    m.lastError = message;
    m.lastErrorAt = Date.now();
    m.lastErrorCode = errorCode;
  }
}

export function getMetrics(): TransportMetrics {
  const m = metrics();
  return {
    ...m,
    lastErrorAt: m.lastErrorAt,
  };
}

export function processId(): string {
  return PROCESS_ID;
}

export { touchPersistedSession, persistSession };
