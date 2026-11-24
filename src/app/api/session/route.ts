import { clearSessionCaches } from "@/lib/pipeline";
import {
  disconnect,
  describeSession,
  getMetrics,
  isConnected,
  markStoreWritable,
  persistSession,
  processId,
  setSession,
  updateValidationTs,
} from "@/lib/upstox/session";
import { validateToken } from "@/lib/upstox/market";

export const dynamic = "force-dynamic";

export async function GET() {
  // Reconcile this process with the shared encrypted store: a restarted process, or a
  // different Render instance, hydrates the same session instead of reporting no token.
  const hydrated = await (async () => {
    const already = isConnected();
    if (already) return { hydrated: false, note: "session present in this process" };
    const ok = await import("@/lib/upstox/session").then((m) => m.ensureSessionLoaded());
    return { hydrated: ok, note: ok ? "session restored from encrypted shared store" : "no session available" };
  })();

  const metrics = getMetrics();
  return Response.json({
    connected: isConnected(),
    hydrated: hydrated.hydrated,
    note: hydrated.note,
    processId: processId(),
    session: describeSession(),
    transport: {
      lastRequestAt: metrics.lastRequestAt ? new Date(metrics.lastRequestAt).toISOString() : null,
      lastRequestEndpoint: metrics.lastRequestEndpoint,
      lastRequestOk: metrics.lastRequestOk,
      lastError: metrics.lastError,
      lastErrorAt: metrics.lastErrorAt ? new Date(metrics.lastErrorAt).toISOString() : null,
      lastErrorCode: metrics.lastErrorCode,
      totalRequests: metrics.totalRequests,
      totalFailures: metrics.totalFailures,
    },
  });
}

export async function POST(request: Request) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "Request body must be valid JSON: {\"token\": \"...\"}", tokenStatus: "INVALID", httpStatus: 400 },
      { status: 400 },
    );
  }
  const raw =
    body && typeof body === "object" && body !== null && "token" in body
      ? (body as { token?: unknown }).token
      : undefined;
  const token = typeof raw === "string" ? raw.trim() : "";

  if (!token) {
    return Response.json(
      { ok: false, error: "Missing access token. Paste your Upstox access token first.", tokenStatus: "INVALID", httpStatus: 400 },
      { status: 400 },
    );
  }
  if (token.length < 40) {
    return Response.json(
      {
        ok: false,
        error: `Token looks too short (${token.length} characters). An Upstox access token is a long JWT — copy the full value from the developer console.`,
        tokenStatus: "INVALID",
        httpStatus: 400,
      },
      { status: 400 },
    );
  }

  // Validate against the OFFICIAL endpoint: GET /v2/user/profile.
  // The token is only persisted after a confirmed VALID response.
  const validation = await validateToken(token);

  if (!validation.valid) {
    return Response.json(
      {
        ok: false,
        error: validation.message,
        tokenStatus: validation.status,
        httpStatus: validation.httpStatus,
        errorCode: validation.errorCode,
        message:
          validation.status === "EXPIRED"
            ? "Upstox access tokens expire daily at ~03:30 IST. Generate a new token and try again."
            : validation.status === "NETWORK_ERROR"
              ? "Could not reach api.upstox.com from the server. Check outbound HTTPS access."
              : validation.status === "UPSTOX_SERVICE_ERROR"
                ? "Upstox service temporarily unavailable or rate limited. Try again shortly."
                : validation.message,
        fix:
          validation.status === "INVALID" || validation.status === "EXPIRED"
            ? "Regenerate the access token at https://account.upstox.com/developer/apps and paste the full value."
            : null,
      },
      { status: validation.status === "NETWORK_ERROR" ? 502 : 401 },
    );
  }

  const sessionId = `sess_${Date.now().toString(36)}`;
  const info = setSession({
    token,
    sessionId,
    userName: validation.userName,
    userId: validation.userId,
    exchanges: validation.exchanges,
  });
  updateValidationTs();

  // Persist the encrypted session so restarts / other instances can hydrate it.
  const stored = await persistSession({
    token,
    userName: validation.userName,
    userId: validation.userId,
    exchanges: validation.exchanges,
    connectedAt: Date.now(),
    lastValidatedAt: Date.now(),
  });
  markStoreWritable(stored.ok, stored.error);

  clearSessionCaches();

  return Response.json({
    ok: true,
    tokenStatus: validation.status,
    httpStatus: validation.httpStatus,
    session: info,
    message: `Upstox token validated via GET /v2/user/profile (HTTP ${validation.httpStatus}) as ${validation.userName ?? validation.userId ?? "user"}.`,
    note: stored.ok
      ? "Session stored encrypted (AES-256-GCM) so it survives restarts and is visible to every backend instance."
      : `Session active in this process only; encrypted store unavailable (${stored.error}). A process restart will require reconnecting.`,
  });
}

export async function DELETE() {
  await disconnect();
  clearSessionCaches();
  const metrics = getMetrics();
  return Response.json({
    ok: true,
    connected: false,
    message: "Token deleted from backend memory and from the encrypted shared store.",
    processId: processId(),
    transport: { lastError: metrics.lastError, lastRequestAt: metrics.lastRequestAt ? new Date(metrics.lastRequestAt).toISOString() : null },
  });
}
