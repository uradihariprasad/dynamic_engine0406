import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { upstoxSessionStore } from "@/db/schema";

/**
 * Secure shared ephemeral session store.
 *
 * WHY THIS EXISTS: a pure `globalThis` token lives only inside one Node worker.
 * Next.js route handlers may be served by different workers/instances, and a
 * restart wipes it — which made the app look permanently disconnected even after
 * a successful Connect.
 *
 * DESIGN: the token is AES-256-GCM encrypted with a server-side key before it
 * touches PostgreSQL, and is only ever decrypted in backend memory. Plaintext
 * never reaches the database, logs, responses or the browser. Rows expire, and
 * Disconnect deletes the row immediately.
 */

const SINGLETON = "singleton";
export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 12 * 60 * 60 * 1000);

function encryptionKey(): Buffer {
  const secret =
    process.env.SESSION_SECRET ??
    process.env.NEXTAUTH_SECRET ??
    // Deterministic fallback so the store works without extra configuration.
    // Still server-side only; still never leaves the process.
    `${process.env.DATABASE_URL ?? "dynamic-engine"}::dynamic-engine-session-key`;
  return createHash("sha256").update(secret).digest();
}

export function fingerprintToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex").slice(0, 16);
}

export function maskToken(token: string): string {
  const cleaned = token.trim();
  if (cleaned.length <= 8) return "****";
  return `${cleaned.slice(0, 4)}…${cleaned.slice(-4)} (len ${cleaned.length})`;
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function encryptToken(token: string): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptToken(payload: EncryptedPayload): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]);
    const value = dec.toString("utf8");
    return value.length > 0 ? value : null;
  } catch {
    // Wrong key, tampered row or rotated secret: treat as unavailable, never as a token.
    return null;
  }
}

export interface PersistedSessionMeta {
  maskedToken: string;
  tokenFingerprint: string;
  userName: string | null;
  userId: string | null;
  exchanges: string[];
  connectedAt: string;
  lastValidatedAt: string;
  expiresAt: string;
}

/** Writes the encrypted session. Failures are reported, never swallowed silently. */
export async function persistSession(args: {
  token: string;
  userName: string | null;
  userId: string | null;
  exchanges: string[];
  connectedAt: number;
  lastValidatedAt: number;
}): Promise<{ ok: boolean; error: string | null }> {
  const payload = encryptToken(args.token);
  const now = new Date();
  const values = {
    id: SINGLETON,
    ciphertext: payload.ciphertext,
    iv: payload.iv,
    authTag: payload.authTag,
    maskedToken: maskToken(args.token),
    tokenFingerprint: fingerprintToken(args.token),
    userName: args.userName,
    userId: args.userId,
    exchanges: args.exchanges,
    connectedAt: new Date(args.connectedAt),
    lastValidatedAt: new Date(args.lastValidatedAt),
    expiresAt: new Date(args.lastValidatedAt + SESSION_TTL_MS),
    updatedAt: now,
  };
  try {
    await db
      .insert(upstoxSessionStore)
      .values(values)
      .onConflictDoUpdate({ target: upstoxSessionStore.id, set: values });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function loadPersistedSession(): Promise<{ token: string; meta: PersistedSessionMeta } | null> {
  try {
    const rows = await db.select().from(upstoxSessionStore).where(eq(upstoxSessionStore.id, SINGLETON)).limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    const token = decryptToken({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag });
    if (!token) return null;
    if (new Date(row.expiresAt).getTime() < Date.now()) return null;
    return {
      token,
      meta: {
        maskedToken: row.maskedToken,
        tokenFingerprint: row.tokenFingerprint,
        userName: row.userName,
        userId: row.userId,
        exchanges: Array.isArray(row.exchanges) ? (row.exchanges as string[]) : [],
        connectedAt: new Date(row.connectedAt).toISOString(),
        lastValidatedAt: new Date(row.lastValidatedAt).toISOString(),
        expiresAt: new Date(row.expiresAt).toISOString(),
      },
    };
  } catch {
    return null;
  }
}

export async function clearPersistedSession(): Promise<void> {
  try {
    await db.delete(upstoxSessionStore).where(eq(upstoxSessionStore.id, SINGLETON));
  } catch {
    // ignore: nothing left to clear
  }
}

/** Touches the validation timestamp without re-encrypting the token. */
export async function touchPersistedSession(at: number): Promise<void> {
  try {
    await db
      .update(upstoxSessionStore)
      .set({ lastValidatedAt: new Date(at), updatedAt: new Date(at) })
      .where(eq(upstoxSessionStore.id, SINGLETON));
  } catch {
    // non-fatal
  }
}
