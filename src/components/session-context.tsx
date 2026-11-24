"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "LOST" | "INVALID";

export interface SessionSnapshot {
  connected: boolean;
  session: {
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
    processId: string;
    restoredFromStore: boolean;
    storeWritable: boolean;
    storeError: string | null;
  };
}

export interface ConnectResult {
  ok: boolean;
  error: string | null;
  tokenStatus: string;
  httpStatus: number | null;
  errorCode: string | null;
  message: string | null;
}

interface SessionContextValue {
  state: SessionSnapshot;
  connection: ConnectionState;
  lastError: string | null;
  connectError: string | null;
  connecting: boolean;
  /** Bumped on every connect/disconnect so consumers can re-fetch immediately. */
  version: number;
  connect: (token: string) => Promise<ConnectResult>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  clearErrors: () => void;
}

const EMPTY: SessionSnapshot = {
  connected: false,
  session: {
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
    processId: "",
    restoredFromStore: false,
    storeWritable: false,
    storeError: null,
  },
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionSnapshot>(EMPTY);
  const [connection, setConnection] = useState<ConnectionState>("DISCONNECTED");
  const [connecting, setConnecting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const apply = useCallback((snap: SessionSnapshot) => {
    setState(snap);
    if (snap.connected && snap.session.active) setConnection("CONNECTED");
    else setConnection((prev) => (prev === "CONNECTING" ? prev : "DISCONNECTED"));
    setVersion((v) => v + 1);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/session", { cache: "no-store" });
      const json = (await res.json()) as SessionSnapshot;
      // Detect session loss: previously connected, now the process reports no token.
      setConnection((prev) => {
        if (json.connected && json.session.active) return "CONNECTED";
        if (prev === "CONNECTED") return "LOST";
        if (prev === "CONNECTING") return prev;
        return "DISCONNECTED";
      });
      setState(json);
      setVersion((v) => v + 1);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : "Unable to reach /api/session");
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Slow background reconciliation only; every mutation refreshes immediately.
    pollRef.current = setInterval(() => void refresh(), 30000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  const connect = useCallback(
    async (token: string): Promise<ConnectResult> => {
      setConnecting(true);
      setConnection("CONNECTING");
      setConnectError(null);
      setLastError(null);
      try {
        const res = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        let json: {
          ok?: boolean;
          error?: string;
          message?: string;
          tokenStatus?: string;
          httpStatus?: number | null;
          errorCode?: string | null;
          session?: SessionSnapshot["session"];
        } = {};
        try {
          json = (await res.json()) as typeof json;
        } catch {
          return {
            ok: false,
            error: `Backend returned HTTP ${res.status} with a non-JSON body`,
            tokenStatus: "UNKNOWN",
            httpStatus: res.status,
            errorCode: null,
            message: null,
          };
        }

        if (!json.ok) {
          setConnection("INVALID");
          setConnectError(json.error ?? `Connection failed (HTTP ${res.status})`);
          // Keep the entered token in the input so the user can correct it.
          return {
            ok: false,
            error: json.error ?? `Connection failed (HTTP ${res.status})`,
            tokenStatus: json.tokenStatus ?? "UNKNOWN",
            httpStatus: json.httpStatus ?? res.status,
            errorCode: json.errorCode ?? null,
            message: json.message ?? null,
          };
        }

        // The backend already validated against /v2/user/profile. Reflect it immediately.
        setState({
          connected: true,
          session: json.session ?? EMPTY.session,
        });
        setConnection("CONNECTED");
        setVersion((v) => v + 1);
        return {
          ok: true,
          error: null,
          tokenStatus: json.tokenStatus ?? "VALID",
          httpStatus: json.httpStatus ?? null,
          errorCode: null,
          message: json.message ?? "Connected",
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network failure while connecting";
        setConnection("DISCONNECTED");
        setConnectError(msg);
        return { ok: false, error: msg, tokenStatus: "NETWORK_ERROR", httpStatus: null, errorCode: null, message: null };
      } finally {
        setConnecting(false);
      }
    },
    [],
  );

  const disconnect = useCallback(async () => {
    setConnecting(true);
    try {
      await fetch("/api/session", { method: "DELETE" });
      setConnectError(null);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setConnecting(false);
      await refresh();
    }
  }, [refresh]);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      connection,
      lastError,
      connectError,
      connecting,
      version,
      connect,
      disconnect,
      refresh,
      clearErrors: () => {
        setLastError(null);
        setConnectError(null);
      },
    }),
    [state, connection, lastError, connectError, connecting, version, connect, disconnect, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSessionContext(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSessionContext must be used inside <SessionProvider>");
  return ctx;
}
