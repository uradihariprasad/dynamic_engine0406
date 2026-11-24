"use client";

import { Panel, StatusBadge, Td, Th } from "@/components/ui";
import type { AnalysisSnapshot, DataFoundationView, ReadinessEvaluationView } from "@/lib/engine/types";

const STATE_STYLE: Record<string, string> = {
  READY: "bg-emerald-500/12 text-emerald-300 border-emerald-500/30",
  PARTIAL: "bg-amber-500/12 text-amber-300 border-amber-500/30",
  WAITING_FOR_HISTORY: "bg-sky-500/12 text-sky-300 border-sky-500/30",
  BLOCKED: "bg-slate-500/12 text-slate-400 border-slate-500/30",
  FAILED: "bg-rose-500/12 text-rose-300 border-rose-500/30",
  STALE: "bg-orange-500/12 text-orange-300 border-orange-500/30",
  FETCHING: "bg-sky-500/12 text-sky-300 border-sky-500/30",
  VALIDATING: "bg-sky-500/12 text-sky-300 border-sky-500/30",
  NOT_STARTED: "bg-slate-500/12 text-slate-400 border-slate-500/30",
};

function StateBadge({ state }: { state: string }) {
  const cls = STATE_STYLE[state] ?? STATE_STYLE.NOT_STARTED;
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${cls}`}>
      {state.replace(/_/g, " ")}
    </span>
  );
}

const VERDICT_TONE: Record<string, string> = {
  READY: "border-emerald-700/50 bg-emerald-500/5 text-emerald-300",
  PARTIAL: "border-amber-700/50 bg-amber-500/5 text-amber-300",
  BLOCKED: "border-slate-700 bg-slate-900/50 text-slate-400",
  FAILED: "border-rose-700/50 bg-rose-500/5 text-rose-300",
};

export function DataFoundationPanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return null;
  const df = snapshot.dataFoundation;
  return (
    <Panel
      title="Data Foundation & Readiness Gates"
      subtitle="Every analysis module runs only after its required source data has been fetched, validated, normalized and persisted. Modules missing prerequisites report exactly what is absent — never a fabricated value."
      status={df.verdict === "READY" ? "LIVE" : df.verdict === "FAILED" ? "INVALID" : df.verdict === "PARTIAL" ? "PARTIAL" : "UNAVAILABLE"}
    >
      <div className={`rounded-lg border px-3 py-2 text-[12px] font-semibold ${VERDICT_TONE[df.verdict] ?? VERDICT_TONE.BLOCKED}`}>
        FOUNDATION: {df.verdict}
        <div className="mt-1 text-[11px] font-normal text-slate-400">{df.reason}</div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <FoundationTile label="Chain strikes" value={df.counts.chainStrikes} sub={`${df.counts.chainPricedStrikes} priced`} />
        <FoundationTile label="Contract rows" value={df.counts.contractRowCount} sub={`${df.counts.expiryCount} expiries`} />
        <FoundationTile label="Greeks coverage" value={df.counts.greeksCoveragePct === null ? "—" : `${Math.round(df.counts.greeksCoveragePct)}%`} sub="of Greek slots" />
        <FoundationTile label="OI observations" value={df.counts.oiSnapshotCount} sub={df.counts.oldestOiAt ? `since ${fmtTime(df.counts.oldestOiAt)}` : "collecting"} />
        <FoundationTile label="Premium observations" value={df.counts.premiumObservationCount} sub="rows with LTP" />
        <FoundationTile label="Futures observations" value={df.counts.futuresObservationCount} sub="for this contract" />
        <FoundationTile
          label="DB read"
          value={df.counts.oiReadOk ? "OK" : "FAILED"}
          sub={df.counts.oiReadOk ? "oi_snapshot" : df.counts.oiReadError ?? "error"}
        />
      </div>

      {/* Module readiness matrix */}
      <div className="mt-4 swipe-hint overflow-x-auto scroll-thin">
        <table className="w-full min-w-[900px] border-collapse">
          <thead>
            <tr>
              <Th>Module</Th>
              <Th>State</Th>
              <Th>Required data present</Th>
              <Th>Missing</Th>
              <Th>Waiting for history</Th>
              <Th>Explanation</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {df.modules.map((m) => (
              <tr key={m.module} className={m.state === "FAILED" ? "bg-rose-500/5" : m.state === "READY" ? "" : ""}>
                <Td className="font-semibold text-slate-200">{m.module.replace(/_/g, " ")}</Td>
                <Td><StateBadge state={m.state} /></Td>
                <Td tone="text-emerald-400">
                  <div className="max-w-[220px] whitespace-normal">{m.present.length > 0 ? m.present.join("; ") : "—"}</div>
                </Td>
                <Td tone={m.missing.length > 0 ? "text-rose-300" : "text-slate-600"}>
                  <div className="max-w-[200px] whitespace-normal">{m.missing.length > 0 ? m.missing.join("; ") : "none"}</div>
                </Td>
                <Td tone={m.pendingHistory.length > 0 ? "text-sky-300" : "text-slate-600"}>
                  <div className="max-w-[190px] whitespace-normal">{m.pendingHistory.length > 0 ? m.pendingHistory.join("; ") : "—"}</div>
                </Td>
                <Td tone="text-slate-400">
                  <div className="max-w-[320px] whitespace-normal">{m.reason}</div>
                </Td>
                <Td tone="text-amber-300">
                  <div className="max-w-[220px] whitespace-normal">{m.action ?? "—"}</div>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Storage operations */}
      {df.storage.length > 0 ? (
        <div className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Persistence operations (latest cycle)</div>
          <div className="mt-2 swipe-hint overflow-x-auto scroll-thin">
            <table className="w-full min-w-[760px] border-collapse">
              <thead>
                <tr>
                  <Th>Table</Th>
                  <Th>Operation</Th>
                  <Th>Symbol</Th>
                  <Th>Expiry</Th>
                  <Th align="right">Records</Th>
                  <Th align="right">Duration</Th>
                  <Th>Result</Th>
                  <Th>Error / Skip reason</Th>
                </tr>
              </thead>
              <tbody>
                {df.storage.map((r, i) => (
                  <tr key={i}>
                    <Td className="font-semibold text-slate-200">{r.table}</Td>
                    <Td tone="mono">{r.operation}</Td>
                    <Td tone="mono">{r.symbol ?? "—"}</Td>
                    <Td tone="mono">{r.expiry ?? "—"}</Td>
                    <Td align="right" tone="mono">{r.recordCount}</Td>
                    <Td align="right" tone="mono">{r.durationMs}ms</Td>
                    <Td>{r.ok ? <StatusBadge status="LIVE" small /> : <StatusBadge status="INVALID" small />}</Td>
                    <Td tone={r.ok ? (r.skipped ? "text-sky-300" : "text-slate-600") : "text-rose-300"}>
                      {r.ok ? (r.skipped ? r.skipReason : "written") : r.error}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="mt-4 text-[11px] text-slate-500">
          No persistence operations ran this cycle (no validated chain or futures data to store).
        </div>
      )}
    </Panel>
  );
}

function FoundationTile({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="panel-flat px-3 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="mono mt-1 text-[15px] font-semibold text-slate-100">{value}</div>
      {sub ? <div className="mt-0.5 text-[10px] text-slate-500">{sub}</div> : null}
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" });
}

/** Compact readiness strip used on the Dashboard. */
export function ReadinessStrip({ foundation }: { foundation: DataFoundationView }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {foundation.modules.map((m: ReadinessEvaluationView) => (
        <span
          key={m.module}
          title={`${m.module}: ${m.reason}${m.missing.length ? ` | missing: ${m.missing.join(", ")}` : ""}`}
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${STATE_STYLE[m.state] ?? STATE_STYLE.NOT_STARTED}`}
        >
          {m.module.replace(/_/g, " ")}
        </span>
      ))}
    </div>
  );
}
