"use client";

import { useCallback, useEffect, useState } from "react";
import { Panel, StatusBadge, Td, Th, fmtDateTime } from "@/components/ui";

interface Check {
  id: string;
  symbol: "NIFTY" | "SENSEX" | "BOTH";
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
  symbol: "NIFTY" | "SENSEX";
  resolution: { ok: boolean; instrumentKey: string; masterInstrumentKey: string | null; tradingSymbol: string | null; segment: string | null; source: string; reason: string | null };
  selectedExpiry: string | null;
  chainStrikes: number | null;
  greeksAvailable: boolean | null;
  checks: Check[];
}

interface DiagnosticsPayload {
  ok: boolean;
  connected: boolean;
  conclusion: string;
  checks: Check[];
  symbols: SymbolReport[];
  breakers: Array<{ group: string; open: boolean; failures: number; openedAt: string | null }>;
  recentFailures: Array<{ group: string; kind: string; message: string; status: number | null; code: string | null; at: string }>;
  summary: { niftyCoreReady: boolean; sensexCoreReady: boolean; totalChecks: number; failing: number };
  fix: string | null;
}

const CONCLUSION_COPY: Record<string, { title: string; tone: string }> = {
  NO_DATA_BECAUSE_NO_TOKEN: { title: "No Upstox token in backend memory", tone: "text-amber-300" },
  NO_DATA_BECAUSE_MARKET_DATA_CALLS_FAILED: { title: "Upstox market-data calls are failing", tone: "text-rose-300" },
  PARTIAL_DATA_SOME_CALLS_FAILED: { title: "Some Upstox calls are failing", tone: "text-amber-300" },
  DATA_AVAILABLE: { title: "All Upstox endpoints responded", tone: "text-emerald-300" },
};

/** Modules in the order they must be verified, per the required diagnostic matrix. */
const MODULE_ORDER = [
  "Instrument resolution",
  "Spot quote",
  "Historical candles",
  "Intraday candles",
  "Futures resolution",
  "Futures quote",
  "Option contract discovery",
  "Expiry selection",
  "Option chain",
  "Greeks",
  "Greeks field coverage",
  "Executed buyer/seller dominance",
  "OI snapshot persistence",
  "Market status",
];

export function DiagnosticsView({ symbol }: { symbol: string }) {
  const [data, setData] = useState<DiagnosticsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [ranAt, setRanAt] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/diagnostics?symbol=${symbol === "SENSEX" ? "BOTH" : "BOTH"}`, { cache: "no-store" });
      const json = (await res.json()) as DiagnosticsPayload;
      setData(json);
      setRanAt(new Date().toISOString());
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    void run();
  }, [run]);

  const clearBreakers = async () => {
    await fetch("/api/diagnostics", { method: "POST" });
    await run();
  };

  const conclusion = data ? (CONCLUSION_COPY[data.conclusion] ?? { title: data.conclusion, tone: "text-slate-300" }) : null;

  const renderSymbol = (sym: "NIFTY" | "SENSEX") => {
    const rep = data?.symbols.find((r) => r.symbol === sym);
    if (!rep) return null;
    const resolved = rep.checks.filter((c) => MODULE_ORDER.includes(c.module));
    const ordered = MODULE_ORDER.map((m) => resolved.find((c) => c.module === m)).filter((c): c is Check => Boolean(c));
    const passed = ordered.filter((c) => c.ok).length;
    return (
      <Panel
        key={sym}
        title={`${sym} — module verification matrix`}
        subtitle={`Instrument key: ${rep.resolution.instrumentKey}${rep.resolution.masterInstrumentKey && rep.resolution.masterInstrumentKey !== rep.resolution.instrumentKey ? ` (master: ${rep.resolution.masterInstrumentKey})` : ""} · verified from ${rep.resolution.source}${rep.resolution.tradingSymbol ? ` · ${rep.resolution.tradingSymbol}` : ""}${rep.resolution.segment ? ` · ${rep.resolution.segment}` : ""}`}
        status={passed === ordered.length && ordered.length > 0 ? "LIVE" : passed > 0 ? "PARTIAL" : "UNAVAILABLE"}
        right={<span className="mono text-[11px] text-slate-500">{passed}/{ordered.length} passed</span>}
      >
        <div className="swipe-hint overflow-x-auto scroll-thin">
          <table className="w-full min-w-[1050px] border-collapse">
            <thead>
              <tr>
                <Th>Module</Th>
                <Th>Result</Th>
                <Th>Endpoint</Th>
                <Th>Instrument key</Th>
                <Th align="right">HTTP</Th>
                <Th>Error code</Th>
                <Th align="right">Records</Th>
                <Th align="right">Latency</Th>
                <Th>Detail</Th>
                <Th>Corrective action</Th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((c) => (
                <tr key={c.id}>
                  <Td className="font-semibold text-slate-200">{c.module}</Td>
                  <Td>{c.ok ? <StatusBadge status="LIVE" small /> : <StatusBadge status={c.status} small />}</Td>
                  <Td tone="mono text-slate-500">{c.endpoint}</Td>
                  <Td tone="mono text-slate-400">{c.instrumentKey ?? "—"}</Td>
                  <Td align="right" tone="mono">{c.httpStatus ?? "—"}</Td>
                  <Td tone="mono text-rose-300">{c.errorCode ?? "—"}</Td>
                  <Td align="right" tone="mono">{c.recordCount ?? "—"}</Td>
                  <Td align="right" tone="mono">{c.latencyMs === null ? "—" : `${c.latencyMs}ms`}</Td>
                  <Td>
                    <div className="max-w-[300px] whitespace-normal text-slate-400">{c.message}</div>
                    {c.sample ? (
                      <details>
                        <summary className="cursor-pointer text-[10px] text-sky-400">response sample</summary>
                        <pre className="mono mt-1 max-h-44 overflow-auto rounded bg-slate-950/70 p-2 text-[10px] text-slate-400 scroll-thin">
                          {JSON.stringify(c.sample, null, 1)}
                        </pre>
                      </details>
                    ) : null}
                  </Td>
                  <Td tone="text-amber-300">
                    <div className="max-w-[240px] whitespace-normal">{c.correctiveAction ?? "—"}</div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <SummaryTile label="Expiry selected" value={rep.selectedExpiry ?? "unavailable"} />
          <SummaryTile label="Chain strikes" value={rep.chainStrikes === null ? "unavailable" : String(rep.chainStrikes)} />
          <SummaryTile label="Greeks" value={rep.greeksAvailable === null ? "unavailable" : rep.greeksAvailable ? "AVAILABLE" : "NOT RETURNED"} />
          <SummaryTile label="Master key" value={rep.resolution.masterInstrumentKey ?? "—"} />
        </div>
      </Panel>
    );
  };

  return (
    <div className="space-y-3">
      <Panel
        title="Upstox Diagnostics"
        subtitle="Executes real requests against every official Upstox endpoint the engine uses — independently for NIFTY and SENSEX — and reports the exact HTTP status, Upstox error code, record count and a corrective action for every failure."
        status={data?.connected ? "LIVE" : "UNAVAILABLE"}
        right={
          <div className="flex gap-2">
            <button onClick={run} disabled={loading} className="rounded bg-sky-600 px-3 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50">
              {loading ? "Testing…" : "Run diagnostics"}
            </button>
            <button onClick={clearBreakers} className="rounded border border-slate-700 px-3 py-1.5 text-[11px] font-semibold text-slate-300">
              Reset breakers
            </button>
          </div>
        }
      >
        {data && conclusion ? (
          <div className={`rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-[12px] font-semibold ${conclusion.tone}`}>
            {conclusion.title}
            <span className="ml-2 text-[11px] font-normal text-slate-500">
              {data.summary.totalChecks} checks, {data.summary.failing} failing · NIFTY core {data.summary.niftyCoreReady ? "READY" : "BLOCKED"} · SENSEX core{" "}
              {data.summary.sensexCoreReady ? "READY" : "BLOCKED"}
              {ranAt ? ` · ran ${fmtDateTime(ranAt)}` : ""}
            </span>
            {data.fix ? <span className="mt-1 block text-[11px] font-normal text-slate-400">Fix: {data.fix}</span> : null}
          </div>
        ) : null}

        {/* Session + master checks */}
        <div className="mt-3 swipe-hint overflow-x-auto scroll-thin">
          <table className="w-full min-w-[900px] border-collapse">
            <thead>
              <tr>
                <Th>Layer</Th>
                <Th>Result</Th>
                <Th>Endpoint</Th>
                <Th align="right">HTTP</Th>
                <Th align="right">Latency</Th>
                <Th>Detail</Th>
                <Th>Corrective action</Th>
              </tr>
            </thead>
            <tbody>
              {(data?.checks ?? [])
                .filter((c) => c.symbol === "BOTH")
                .map((c) => (
                  <tr key={c.id}>
                    <Td className="font-semibold text-slate-200">{c.module}</Td>
                    <Td>{c.ok ? <StatusBadge status="LIVE" small /> : <StatusBadge status={c.status} small />}</Td>
                    <Td tone="mono text-slate-500">{c.endpoint}</Td>
                    <Td align="right" tone="mono">{c.httpStatus ?? "—"}</Td>
                    <Td align="right" tone="mono">{c.latencyMs === null ? "—" : `${c.latencyMs}ms`}</Td>
                    <Td>
                      <div className="max-w-[340px] whitespace-normal text-slate-400">{c.message}</div>
                      {c.sample ? (
                        <details>
                          <summary className="cursor-pointer text-[10px] text-sky-400">view</summary>
                          <pre className="mono mt-1 max-h-40 overflow-auto rounded bg-slate-950/70 p-2 text-[10px] text-slate-400 scroll-thin">
                            {JSON.stringify(c.sample, null, 1)}
                          </pre>
                        </details>
                      ) : null}
                    </Td>
                    <Td tone="text-amber-300">
                      <div className="max-w-[220px] whitespace-normal">{c.correctiveAction ?? "—"}</div>
                    </Td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {renderSymbol("NIFTY")}
      {renderSymbol("SENSEX")}

      {data && data.breakers.length > 0 ? (
        <Panel title="Circuit breakers (per endpoint group)">
          <ul className="space-y-0.5 text-[11px] text-slate-400">
            {data.breakers.map((b) => (
              <li key={b.group}>
                <span className="mono">{b.group}</span> — {b.open ? "OPEN" : "closed"}, failures {b.failures}
                {b.openedAt ? `, opened ${fmtDateTime(b.openedAt)}` : ""}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {data && data.recentFailures.length > 0 ? (
        <Panel title="Most recent transport failures">
          <ul className="space-y-0.5 text-[11px] text-slate-400">
            {data.recentFailures.map((f, i) => (
              <li key={i}>
                <span className="mono text-slate-300">{f.group}</span> — {f.kind} {f.status ? `(HTTP ${f.status})` : ""} {f.code ? `[${f.code}]` : ""}: {f.message}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title="Most common reasons a module shows no data" status="LIVE">
        <ul className="space-y-1.5 text-[12px] text-slate-400">
          <li>• <span className="font-semibold text-slate-200">UDAPI100050 / HTTP 401</span> — the token is invalid or expired. Upstox tokens expire daily at ~03:30 IST.</li>
          <li>• <span className="font-semibold text-slate-200">Invalid Instrument key</span> — the key was rejected. Diagnostics shows the exact key sent so you can compare it with the master row.</li>
          <li>• <span className="font-semibold text-slate-200">Invalid Endpoint</span> — the path is not registered. The engine now uses only documented endpoints: <span className="mono">/v2/user/profile</span>, <span className="mono">/v3/market-quote/quotes</span>, <span className="mono">/v3/historical-candle</span>, <span className="mono">/v2/option/contract</span>, <span className="mono">/v2/option/chain</span>.</li>
          <li>• <span className="font-semibold text-slate-200">Empty data object</span> — a valid HTTP 200 with zero records is never reported as LIVE; the V2 fallback is attempted and its result is reported separately.</li>
          <li>• <span className="font-semibold text-slate-200">No contract rows</span> — the underlying may genuinely have no listed contracts for that expiry.</li>
        </ul>
      </Panel>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel-flat px-3 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="mono mt-1 text-[12px] text-slate-200">{value}</div>
    </div>
  );
}
