"use client";

import { useEffect, useRef, useState } from "react";
import { useSessionContext, type ConnectionState } from "@/components/session-context";
import { fmtDateTime } from "@/components/ui";

/**
 * Inline Upstox access-token entry box for the header (top-right).
 *
 * SECURITY:
 *  - The token is held ONLY in this component's React state while being typed.
 *  - It is sent once to POST /api/session over HTTPS and then cleared from memory.
 *  - It is never written to localStorage/sessionStorage, never logged, and never
 *    echoed back — the backend returns only a masked preview.
 *  - The input is intentionally NOT cleared when validation fails, so the user can
 *    correct a typo without re-pasting. It IS cleared on success.
 *
 * This component and SettingsView share the same SessionProvider, so connecting here
 * immediately updates the header, Settings and triggers a fresh market-data scan.
 */
export function TokenEntry({ onNavigateToSettings }: { onNavigateToSettings?: () => void }) {
  const { state, connection, connect, disconnect, connecting, connectError } = useSessionContext();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string; status?: string; fix?: string | null } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const connected = state.connected && state.session.active;
  const busy = connecting;

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus the input when the panel opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Reflect a successful connection immediately.
  useEffect(() => {
    if (connected && result?.ok === false) setResult(null);
  }, [connected, result]);

  const submit = async () => {
    const trimmed = token.trim();
    if (trimmed.length < 40) {
      setResult({
        ok: false,
        text: `Token looks too short (${trimmed.length} characters). An Upstox access token is a long JWT — copy the full value from the developer console.`,
        status: "INVALID",
        fix: "Regenerate the access token at https://account.upstox.com/developer/apps and paste the whole value.",
      });
      return;
    }
    const outcome = await connect(trimmed);
    if (outcome.ok) {
      setToken("");
      setResult({ ok: true, text: outcome.message ?? "Connected", status: outcome.tokenStatus });
      // Collapse shortly after success so the header returns to normal.
      setTimeout(() => setOpen(false), 1200);
    } else {
      setResult({
        ok: false,
        text: outcome.error ?? "Connection failed",
        status: outcome.tokenStatus,
        fix:
          outcome.httpStatus === 401
            ? "Regenerate the access token at https://account.upstox.com/developer/apps (tokens expire daily at ~03:30 IST) and paste the full value."
            : outcome.httpStatus === 400
              ? "Copy the entire token — it is usually several hundred characters long."
              : outcome.httpStatus === 502
                ? "The server could not reach api.upstox.com. Check outbound HTTPS access and retry."
                : null,
      });
    }
  };

  const statusLabel = connected
    ? "CONNECTED"
    : connection === "CONNECTING"
      ? "VALIDATING…"
      : connection === "LOST"
        ? "SESSION LOST"
        : connection === "INVALID"
          ? "INVALID"
          : "NO TOKEN";

  const statusTone = connected
    ? "border-emerald-600 bg-emerald-500/10 text-emerald-300"
    : connection === "CONNECTING"
      ? "border-amber-600 bg-amber-500/10 text-amber-300"
      : connection === "LOST" || connection === "INVALID"
        ? "border-rose-600 bg-rose-500/10 text-rose-300"
        : "border-slate-700 bg-slate-900 text-slate-400";

  return (
    <div className="relative shrink-0" ref={panelRef}>
      {/* Trigger — always at the far right of the header row */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] transition sm:px-2.5 ${statusTone}`}
        title={connected ? `Upstox session active — token ${state.session.maskedToken || "masked"}. Click to manage.` : "Enter your Upstox access token"}
        aria-label="Upstox access token entry"
        aria-expanded={open}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${connected ? "bg-emerald-500 pulse-dot" : connection === "CONNECTING" ? "bg-amber-500 pulse-dot" : "bg-rose-500"}`} />
        <span className="hidden sm:inline">{statusLabel}</span>
        <span className="text-[11px] leading-none sm:hidden">🔑</span>
        <span className="text-[9px] leading-none text-slate-500">{open ? "▲" : "▼"}</span>
      </button>

      {open ? (
        <div className="fixed left-3 right-3 top-[64px] z-50 sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-[420px] sm:max-w-[92vw]">
          <div className="rounded-xl border border-slate-700 bg-[#0b111c] p-3 shadow-2xl shadow-black/60">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Upstox access token</div>
              <button onClick={() => setOpen(false)} className="text-[14px] leading-none text-slate-500 hover:text-slate-300" aria-label="Close token entry">
                ✕
              </button>
            </div>

            {!connected ? (
              <>
                <textarea
                  ref={inputRef}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  rows={4}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  placeholder="Paste your Upstox access token (eyJ…)"
                  className="mono w-full resize-y rounded border border-slate-700 bg-slate-900 px-2 py-2 text-[11px] leading-relaxed text-slate-200 placeholder:text-slate-600"
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
                  }}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => void submit()}
                    disabled={busy || token.trim().length < 40}
                    className="rounded bg-emerald-600 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white disabled:opacity-50"
                  >
                    {busy ? "Validating…" : "Connect"}
                  </button>
                  <button
                    onClick={() => {
                      setOpen(false);
                      setResult(null);
                    }}
                    disabled={busy}
                    className="rounded border border-slate-700 px-3 py-2 text-[11px] font-semibold text-slate-300 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  {onNavigateToSettings ? (
                    <button onClick={onNavigateToSettings} className="ml-auto text-[10px] font-semibold text-sky-400 underline-offset-2 hover:underline">
                      More options in Settings →
                    </button>
                  ) : null}
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                  Validated against <span className="mono">GET /v2/user/profile</span>, then held in backend runtime memory and mirrored in an AES-256-GCM
                  encrypted store. Never stored in plaintext, never logged, never returned to the browser.
                </p>
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Status" value="CONNECTED" tone="text-emerald-300" />
                  <Field label="Token" value={state.session.maskedToken || "—"} />
                  <Field label="Upstox user" value={state.session.userName ?? state.session.userId ?? "—"} />
                  <Field label="Connected at" value={state.session.connectedAt ? fmtDateTime(state.session.connectedAt) : "—"} />
                  <Field label="Last validated" value={state.session.lastValidatedAt ? fmtDateTime(state.session.lastValidatedAt) : "—"} />
                  <Field label="Expires" value={state.session.expiresAt ? fmtDateTime(state.session.expiresAt) : "—"} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    onClick={async () => {
                      await disconnect();
                      setResult({ ok: true, text: "Token deleted from backend memory and the encrypted store." });
                    }}
                    disabled={busy}
                    className="rounded border border-rose-700 px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-rose-300 disabled:opacity-50"
                  >
                    {busy ? "Disconnecting…" : "Disconnect"}
                  </button>
                  {onNavigateToSettings ? (
                    <button onClick={onNavigateToSettings} className="ml-auto text-[10px] font-semibold text-sky-400 underline-offset-2 hover:underline">
                      Full session details in Settings →
                    </button>
                  ) : null}
                </div>
                {result ? <div className={`mt-2 text-[11px] ${result.ok ? "text-emerald-300" : "text-rose-300"}`}>{result.text}</div> : null}
              </>
            )}

            {/* Error / success feedback — kept visible until the user acts */}
            {result && !connected ? (
              <div className={`mt-2 rounded border px-2.5 py-2 text-[11px] ${result.ok ? "border-emerald-700/50 bg-emerald-500/5 text-emerald-300" : "border-rose-700/50 bg-rose-500/5 text-rose-300"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">{result.ok ? "CONNECTED" : "NOT CONNECTED"}</span>
                  {result.status ? (
                    <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-400">
                      token: {result.status}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-slate-400">{result.text}</div>
                {result.fix ? <div className="mt-1 text-amber-300">Fix: {result.fix}</div> : null}
              </div>
            ) : null}

            {connectError && !result ? <div className="mt-2 text-[11px] text-rose-400">{connectError}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, value, tone = "text-slate-200" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 px-2 py-1.5">
      <div className="text-[8px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className={`mono mt-0.5 truncate text-[11px] ${tone}`} title={value}>
        {value}
      </div>
    </div>
  );
}

/** Re-exported so the header can render the right indicator colour without duplicating logic. */
export function connectionTone(connection: ConnectionState, connected: boolean): string {
  if (connected) return "bg-emerald-500";
  if (connection === "CONNECTING") return "bg-amber-500";
  return "bg-rose-500";
}
