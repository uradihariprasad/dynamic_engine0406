"use client";

import { useState } from "react";
import { Metric, Panel, StatusBadge, Td, Th, Unavailable, fmt, fmtCompact, fmtDateTime } from "@/components/ui";
import type { AnalysisSnapshot, OiIntelligenceView, StrikeOiRowView } from "@/lib/engine/types";

const AVAIL_TONE: Record<string, string> = {
  AVAILABLE: "border-emerald-600 bg-emerald-500/10 text-emerald-300",
  WAITING_FOR_HISTORY: "border-sky-600 bg-sky-500/10 text-sky-300",
  INSUFFICIENT_DATA: "border-amber-600 bg-amber-500/10 text-amber-300",
};

const CLUSTER_TONE: Record<string, string> = {
  CE_BUILDUP_CLUSTER: "border-rose-600 bg-rose-500/10 text-rose-300",
  PE_BUILDUP_CLUSTER: "border-emerald-600 bg-emerald-500/10 text-emerald-300",
  CE_UNWINDING_CLUSTER: "border-amber-600 bg-amber-500/10 text-amber-300",
  PE_UNWINDING_CLUSTER: "border-amber-600 bg-amber-500/10 text-amber-300",
  BALANCED: "border-sky-600 bg-sky-500/10 text-sky-300",
  NO_SIGNAL: "border-slate-700 bg-slate-900 text-slate-500",
};

const PATTERN_TONE: Record<string, string> = {
  LONG_BUILDUP_PATTERN: "border-emerald-600 bg-emerald-500/10 text-emerald-300",
  SHORT_BUILDUP_PATTERN: "border-amber-600 bg-amber-500/10 text-amber-300",
  SHORT_COVERING_PATTERN: "border-sky-600 bg-sky-500/10 text-sky-300",
  LONG_UNWINDING_PATTERN: "border-rose-600 bg-rose-500/10 text-rose-300",
  INCONCLUSIVE: "border-slate-700 bg-slate-900 text-slate-500",
};

function Label({ text, tone }: { text: string; tone: string }) {
  return <span className={`inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${tone}`}>{text.replace(/_/g, " ")}</span>;
}

function tone(v: number | null | undefined): string {
  if (v === null || v === undefined) return "text-slate-500";
  return v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-slate-400";
}

type Section = "SUMMARY" | "STRIKE_TABLE" | "PARTICIPATION" | "CLUSTERS" | "GREEKS_LINK";

export function OiChangePanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  const [section, setSection] = useState<Section>("SUMMARY");
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  const oi = snapshot.oiIntelligence;

  return (
    <Panel
      title={`Change in OI Intelligence — ${snapshot.symbol}`}
      subtitle="A dedicated ΔOI engine. Current total OI, source-provided change, calculated change and rolling 1m/5m/15m changes are reported separately and never conflated. Every rolling comparison is scoped to the exact contract identity (underlying + expiry + strike + CE/PE + instrument key)."
      status={oi.status === "LIVE" ? "LIVE" : oi.status === "WAITING_FOR_HISTORY" ? "PARTIAL" : oi.status === "UNAVAILABLE" ? "UNAVAILABLE" : "PARTIAL"}
      right={<span className="mono text-[10px] text-slate-500">{fmtDateTime(snapshot.generatedAt)}</span>}
    >
      <div className="flex flex-wrap gap-1.5">
        {([
          ["SUMMARY", "Summary"],
          ["STRIKE_TABLE", "Strike-wise ΔOI"],
          ["PARTICIPATION", "Participation"],
          ["CLUSTERS", "Clusters & rankings"],
          ["GREEKS_LINK", "Greeks link"],
        ] as Array<[Section, string]>).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setSection(k)}
            className={`rounded px-2.5 py-1.5 text-[11px] font-semibold ${section === k ? "bg-sky-600/25 text-sky-300 ring-1 ring-sky-600/40" : "bg-slate-900/60 text-slate-400"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {oi.unavailableReasons.length > 0 ? (
        <div className="mt-3 rounded border border-sky-800/50 bg-sky-500/5 px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-sky-300">Data availability</div>
          <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
            {oi.unavailableReasons.map((r, i) => (
              <li key={i}>• {r}</li>
            ))}
          </ul>
          <div className="mt-1 text-[10px] text-slate-500">
            Snapshots are collected on every scan. Keep the app open — 5-minute values appear after ~5 minutes of observations, 15-minute after ~15 minutes. No historical OI is ever invented to fill these windows.
          </div>
        </div>
      ) : null}

      <div className="mt-4">
        {section === "SUMMARY" ? <Summary oi={oi} /> : null}
        {section === "STRIKE_TABLE" ? <StrikeTable oi={oi} /> : null}
        {section === "PARTICIPATION" ? <ParticipationTable oi={oi} /> : null}
        {section === "CLUSTERS" ? <Clusters oi={oi} /> : null}
        {section === "GREEKS_LINK" ? <GreeksLink snapshot={snapshot} /> : null}
      </div>
    </Panel>
  );
}

/* ---------------- Summary ---------------- */

function Summary({ oi }: { oi: OiIntelligenceView }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Total CE OI" value={fmtCompact(oi.totalCeOi)} />
        <Metric label="Total PE OI" value={fmtCompact(oi.totalPeOi)} />
        <Metric label="Combined OI" value={fmtCompact(oi.combinedOi)} />
        <Metric label="PCR" value={oi.pcr === null ? "unavailable" : oi.pcr} hint={oi.pcrChange === null ? "no session baseline" : `moved ${oi.pcrChange > 0 ? "+" : ""}${oi.pcrChange} vs baseline`} />
        <Metric label="CE 5m ΔOI" value={fmtCompact(oi.ce5mChange)} tone={oi.ce5mChange === null ? "muted" : oi.ce5mChange > 0 ? "green" : "red"} hint={oi.ce5mPct === null ? undefined : `${oi.ce5mPct}%`} />
        <Metric label="PE 5m ΔOI" value={fmtCompact(oi.pe5mChange)} tone={oi.pe5mChange === null ? "muted" : oi.pe5mChange > 0 ? "green" : "red"} hint={oi.pe5mPct === null ? undefined : `${oi.pe5mPct}%`} />
        <Metric label="CE 15m ΔOI" value={fmtCompact(oi.ce15mChange)} hint={oi.ce15mPct === null ? undefined : `${oi.ce15mPct}%`} />
        <Metric label="PE 15m ΔOI" value={fmtCompact(oi.pe15mChange)} hint={oi.pe15mPct === null ? undefined : `${oi.pe15mPct}%`} />
        <Metric label="CE session ΔOI" value={fmtCompact(oi.ceSessionChange)} />
        <Metric label="PE session ΔOI" value={fmtCompact(oi.peSessionChange)} />
        <Metric label="Strikes measured" value={oi.rows.length} />
        <Metric label="Stored observations" value={oi.distinctObservations} hint={`${oi.snapshotCount} rows`} />
      </div>

      {/* Window availability */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Rolling window availability</div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(["m1", "m5", "m15", "session"] as const).map((k) => (
            <div key={k} className="panel-flat px-3 py-2">
              <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">{k === "session" ? "Session cumulative" : k.replace("m", "") + "-minute"}</div>
              <div className="mt-1">
                <Label text={oi.windows[k]} tone={AVAIL_TONE[oi.windows[k]]} />
              </div>
              <div className="mt-1 text-[10px] text-slate-500">
                {oi.windows[k] === "AVAILABLE"
                  ? `Baseline ${oi.baselineAt ? fmtDateTime(oi.baselineAt) : "n/a"}`
                  : oi.windows[k] === "WAITING_FOR_HISTORY"
                    ? "Collecting observations"
                    : "Some contracts have data, others do not"}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded border border-slate-800 bg-slate-900/40 p-3">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Interpretation</div>
        <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
          {oi.interpretation.map((t, i) => (
            <li key={i}>• {t}</li>
          ))}
        </ul>
      </div>

      <div className="rounded border border-amber-800/50 bg-amber-500/5 p-2.5 text-[11px] text-amber-200/90">{oi.priceConfirmationNote}</div>
    </div>
  );
}

/* ---------------- Strike table ---------------- */

function StrikeTable({ oi }: { oi: OiIntelligenceView }) {
  const rows = oi.rows;
  if (rows.length === 0) return <Unavailable reason="No option-chain rows available for this cycle." />;
  return (
    <div className="swipe-hint overflow-x-auto scroll-thin">
      <table className="w-full min-w-[1500px] border-collapse">
        <thead>
          <tr>
            <Th>Strike</Th>
            <Th align="right">CE OI</Th>
            <Th align="right">CE ΔOI</Th>
            <Th align="right">CE ΔOI %</Th>
            <Th align="right">CE 5m</Th>
            <Th align="right">CE 15m</Th>
            <Th align="right">CE session</Th>
            <Th align="right">CE vol</Th>
            <Th align="right">CE prem Δ</Th>
            <Th align="center">PCR</Th>
            <Th align="right">PE OI</Th>
            <Th align="right">PE ΔOI</Th>
            <Th align="right">PE ΔOI %</Th>
            <Th align="right">PE 5m</Th>
            <Th align="right">PE 15m</Th>
            <Th align="right">PE session</Th>
            <Th align="right">PE vol</Th>
            <Th align="right">PE prem Δ</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.strike} className={r.isAtm ? "bg-sky-500/10" : ""}>
              <Td className={r.isAtm ? "font-bold text-sky-300" : "font-semibold"} tone="mono">
                {fmt(r.strike, 0)}
                {r.isAtm ? <span className="ml-1 text-[9px] text-sky-400">ATM</span> : null}
              </Td>

              {/* CE block */}
              <Td align="right" tone="mono">{fmtCompact(r.ce.currentOi)}</Td>
              <Td align="right" tone={tone(r.ce.changeInOi)}>{fmtCompact(r.ce.changeInOi)}</Td>
              <Td align="right" tone={tone(r.ce.changeInOiPct)}>{r.ce.changeInOiPct === null ? "n/a" : `${r.ce.changeInOiPct.toFixed(2)}%`}</Td>
              <Td align="right" tone={tone(r.ce.windows.m5.change)}>{fmtCompact(r.ce.windows.m5.change)}</Td>
              <Td align="right" tone={tone(r.ce.windows.m15.change)}>{fmtCompact(r.ce.windows.m15.change)}</Td>
              <Td align="right" tone={tone(r.ce.sessionCumulativeChange)}>{fmtCompact(r.ce.sessionCumulativeChange)}</Td>
              <Td align="right" tone="mono">{fmtCompact(r.ce.windows.m5.referenceOi)}</Td>
              <Td align="right" tone="mono">{fmt(r.ce.windows.m5.pct)}</Td>

              <Td align="center" tone="mono">{fmt(r.strikePcr)}</Td>

              {/* PE block */}
              <Td align="right" tone="mono">{fmtCompact(r.pe.currentOi)}</Td>
              <Td align="right" tone={tone(r.pe.changeInOi)}>{fmtCompact(r.pe.changeInOi)}</Td>
              <Td align="right" tone={tone(r.pe.changeInOiPct)}>{r.pe.changeInOiPct === null ? "n/a" : `${r.pe.changeInOiPct.toFixed(2)}%`}</Td>
              <Td align="right" tone={tone(r.pe.windows.m5.change)}>{fmtCompact(r.pe.windows.m5.change)}</Td>
              <Td align="right" tone={tone(r.pe.windows.m15.change)}>{fmtCompact(r.pe.windows.m15.change)}</Td>
              <Td align="right" tone={tone(r.pe.sessionCumulativeChange)}>{fmtCompact(r.pe.sessionCumulativeChange)}</Td>
              <Td align="right" tone="mono">{fmtCompact(r.pe.windows.m5.referenceOi)}</Td>
              <Td align="right" tone="mono">{fmt(r.pe.windows.m5.pct)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- Participation ---------------- */

function ParticipationTable({ oi }: { oi: OiIntelligenceView }) {
  const rows = oi.rows.filter((r) => r.ceParticipation || r.peParticipation);
  if (rows.length === 0) {
    return (
      <div className="rounded border border-sky-800/50 bg-sky-500/5 px-3 py-3 text-[11px] text-slate-400">
        Participation classification requires BOTH a premium observation and an OI change observation for the same contract. Neither is available yet — no pattern is asserted rather than guessing. Snapshots accumulate on every scan.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="rounded border border-slate-800 bg-slate-900/40 p-2.5 text-[11px] text-slate-400">
        Classification combines premium direction with OI direction. OI alone is never sufficient, and these are aggregate interaction patterns — <span className="text-slate-200">not</span> proof of buyer or seller identity.
      </div>
      <div className="swipe-hint overflow-x-auto scroll-thin">
        <table className="w-full min-w-[1250px] border-collapse">
          <thead>
            <tr>
              <Th>Strike</Th>
              <Th>CE pattern</Th>
              <Th>CE OI Δ window</Th>
              <Th>CE OI magnitude</Th>
              <Th>CE volume</Th>
              <Th>CE confidence</Th>
              <Th>PE pattern</Th>
              <Th>PE OI Δ window</Th>
              <Th>PE OI magnitude</Th>
              <Th>PE volume</Th>
              <Th>PE confidence</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.strike} className={r.isAtm ? "bg-sky-500/10" : ""}>
                <Td className={r.isAtm ? "font-bold text-sky-300" : "font-semibold"} tone="mono">{fmt(r.strike, 0)}</Td>
                <Td>{r.ceParticipation ? <Label text={r.ceParticipation.pattern} tone={PATTERN_TONE[r.ceParticipation.pattern]} /> : <span className="text-slate-600">n/a</span>}</Td>
                <Td tone="mono text-slate-400">{r.ceParticipation ? `${r.ceParticipation.oiBasis.window} (${r.ceParticipation.oiBasis.source})` : "n/a"}</Td>
                <Td>{r.ceParticipation ? <span className="mono text-[10px] text-slate-400">{r.ceParticipation.oiMagnitude.toLowerCase()}</span> : <span className="text-slate-600">n/a</span>}</Td>
                <Td tone="text-slate-400">{r.ceParticipation ? (r.ceParticipation.volumeConfirms === null ? "unverified" : r.ceParticipation.volumeConfirms ? "confirmed" : "not confirmed") : "n/a"}</Td>
                <Td>{r.ceParticipation ? <Label text={r.ceParticipation.confidence} tone={AVAIL_TONE[r.ceParticipation.confidence] ?? "border-slate-700 bg-slate-900 text-slate-500"} /> : <span className="text-slate-600">n/a</span>}</Td>
                <Td>{r.peParticipation ? <Label text={r.peParticipation.pattern} tone={PATTERN_TONE[r.peParticipation.pattern]} /> : <span className="text-slate-600">n/a</span>}</Td>
                <Td tone="mono text-slate-400">{r.peParticipation ? `${r.peParticipation.oiBasis.window} (${r.peParticipation.oiBasis.source})` : "n/a"}</Td>
                <Td>{r.peParticipation ? <span className="mono text-[10px] text-slate-400">{r.peParticipation.oiMagnitude.toLowerCase()}</span> : <span className="text-slate-600">n/a</span>}</Td>
                <Td tone="text-slate-400">{r.peParticipation ? (r.peParticipation.volumeConfirms === null ? "unverified" : r.peParticipation.volumeConfirms ? "confirmed" : "not confirmed") : "n/a"}</Td>
                <Td>{r.peParticipation ? <Label text={r.peParticipation.confidence} tone={AVAIL_TONE[r.peParticipation.confidence] ?? "border-slate-700 bg-slate-900 text-slate-500"} /> : <span className="text-slate-600">n/a</span>}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="rounded border border-slate-800 bg-slate-900/40 p-3 text-[11px] text-slate-400">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Participation totals</div>
        <div className="mt-1">
          Fresh buildup (long/short buildup patterns): <span className="mono text-emerald-400">{oi.freshParticipation}</span> · Weakening (unwinding/covering): <span className="mono text-rose-400">{oi.weakeningParticipation}</span>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Clusters ---------------- */

function Clusters({ oi }: { oi: OiIntelligenceView }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <ClusterList title="Highest OI strikes" rows={oi.highestOiStrikes.map((h) => ({ label: `${h.side} ${fmt(h.strike, 0)}`, value: fmtCompact(h.oi) }))} empty="No OI levels available." />
        <ClusterList title={`Largest OI additions (${oi.largestAdditions[0]?.window ?? "n/a"})`} rows={oi.largestAdditions.map((a) => ({ label: `${a.side} ${fmt(a.strike, 0)}`, value: `+${fmtCompact(a.change)}${a.pct !== null ? ` (${a.pct.toFixed(2)}%)` : ""}` }))} empty="No OI additions measured yet." />
        <ClusterList title={`Largest OI reductions (${oi.largestReductions[0]?.window ?? "n/a"})`} rows={oi.largestReductions.map((a) => ({ label: `${a.side} ${fmt(a.strike, 0)}`, value: `${fmtCompact(a.change)}${a.pct !== null ? ` (${a.pct.toFixed(2)}%)` : ""}` }))} empty="No OI reductions measured yet." />
        <ClusterList title="Buildup clusters" rows={oi.buildupClusters.map((a) => ({ label: `${a.side} ${fmt(a.strike, 0)}`, value: `+${fmtCompact(a.change)}` }))} empty="No buildup cluster identified." />
        <ClusterList title="Unwinding clusters" rows={oi.unwindingClusters.map((a) => ({ label: `${a.side} ${fmt(a.strike, 0)}`, value: fmtCompact(a.change) }))} empty="No unwinding cluster identified." />
        <div className="panel-flat p-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Cluster labels at each strike</div>
          <ul className="mt-2 space-y-1">
            {oi.rows.slice(0, 10).map((r) => (
              <li key={r.strike} className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="mono text-slate-300">{fmt(r.strike, 0)}</span>
                <Label text={r.cluster} tone={CLUSTER_TONE[r.cluster]} />
              </li>
            ))}
          </ul>
        </div>
      </div>
      {oi.rows.some((r) => r.cluster !== "NO_SIGNAL") ? (
        <div className="rounded border border-slate-800 bg-slate-900/40 p-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Cluster evidence</div>
          <ul className="mt-1 space-y-1 text-[11px] text-slate-400">
            {oi.rows.filter((r) => r.cluster !== "NO_SIGNAL").slice(0, 6).map((r) => (
              <li key={r.strike}>
                <span className="mono text-slate-300">{fmt(r.strike, 0)}</span>: {r.clusterReason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ClusterList({ title, rows, empty }: { title: string; rows: Array<{ label: string; value: string }>; empty: string }) {
  return (
    <div className="panel-flat p-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{title}</div>
      {rows.length === 0 ? (
        <div className="mt-2 text-[11px] text-slate-500">{empty}</div>
      ) : (
        <ul className="mt-2 space-y-0.5">
          {rows.map((r, i) => (
            <li key={i} className="flex items-center justify-between text-[11px]">
              <span className="mono text-slate-300">{r.label}</span>
              <span className="mono text-slate-200">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------- Greeks link ---------------- */

function GreeksLink({ snapshot }: { snapshot: AnalysisSnapshot }) {
  const rows = snapshot.oiIntelligence.rows.filter((r) => r.ceParticipation || r.peParticipation);
  return (
    <div className="space-y-3">
      <div className="rounded border border-slate-800 bg-slate-900/40 p-3 text-[11px] leading-relaxed text-slate-400">
        OI change explains <span className="text-slate-200">participation</span>; Greeks explain <span className="text-slate-200">contract sensitivity and risk</span>. They answer different questions and are never combined into one number. Greeks cannot be used as proof of buyer or seller dominance — a high-delta contract tells you the premium will move with the underlying, not that anyone is aggressively buying it.
      </div>
      {rows.length === 0 ? (
        <Unavailable reason="Requires both ΔOI measurements and option-chain Greeks for the same contracts." />
      ) : (
        <div className="swipe-hint overflow-x-auto scroll-thin">
          <table className="w-full min-w-[1150px] border-collapse">
            <thead>
              <tr>
                <Th>Strike</Th>
                <Th>CE pattern</Th>
                <Th align="right">CE Δ</Th>
                <Th align="right">CE Γ rel</Th>
                <Th align="right">CE Θ/prem</Th>
                <Th align="right">CE IV</Th>
                <Th>PE pattern</Th>
                <Th align="right">PE Δ</Th>
                <Th align="right">PE Γ rel</Th>
                <Th align="right">PE Θ/prem</Th>
                <Th align="right">PE IV</Th>
                <Th align="right">CE ΔOI %</Th>
                <Th align="right">PE ΔOI %</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cg = snapshot.optionChain.strikes.find((s) => s.strike === r.strike)?.ce.greeksAssessment;
                const pg = snapshot.optionChain.strikes.find((s) => s.strike === r.strike)?.pe.greeksAssessment;
                return (
                  <tr key={r.strike} className={r.isAtm ? "bg-sky-500/10" : ""}>
                    <Td className={r.isAtm ? "font-bold text-sky-300" : "font-semibold"} tone="mono">{fmt(r.strike, 0)}</Td>
                    <Td>{r.ceParticipation ? <Label text={r.ceParticipation.pattern} tone={PATTERN_TONE[r.ceParticipation.pattern]} /> : <span className="text-slate-600">n/a</span>}</Td>
                    <Td align="right" tone="mono">{fmt(cg?.delta.value ?? null, 3)}</Td>
                    <Td align="right" tone="mono">{fmt(cg?.gamma.relativeToPeers ?? null, 2)}</Td>
                    <Td align="right" tone="mono">{cg?.theta.ratioToLtp != null ? `${(cg.theta.ratioToLtp * 100).toFixed(1)}%` : "n/a"}</Td>
                    <Td align="right" tone="mono">{fmt(cg?.vega.iv ?? null, 2)}</Td>
                    <Td>{r.peParticipation ? <Label text={r.peParticipation.pattern} tone={PATTERN_TONE[r.peParticipation.pattern]} /> : <span className="text-slate-600">n/a</span>}</Td>
                    <Td align="right" tone="mono">{fmt(pg?.delta.value ?? null, 3)}</Td>
                    <Td align="right" tone="mono">{fmt(pg?.gamma.relativeToPeers ?? null, 2)}</Td>
                    <Td align="right" tone="mono">{pg?.theta.ratioToLtp != null ? `${(pg.theta.ratioToLtp * 100).toFixed(1)}%` : "n/a"}</Td>
                    <Td align="right" tone="mono">{fmt(pg?.vega.iv ?? null, 2)}</Td>
                    <Td align="right" tone={tone(r.ce.changeInOiPct)}>{r.ce.changeInOiPct === null ? "n/a" : `${r.ce.changeInOiPct.toFixed(2)}%`}</Td>
                    <Td align="right" tone={tone(r.pe.changeInOiPct)}>{r.pe.changeInOiPct === null ? "n/a" : `${r.pe.changeInOiPct.toFixed(2)}%`}</Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
