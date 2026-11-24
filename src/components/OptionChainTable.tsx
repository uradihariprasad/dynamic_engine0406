"use client";

import type { AnalysisSnapshot } from "@/lib/engine/types";
import { Panel, StatusBadge, Td, Th, Unavailable, fmt, fmtCompact } from "@/components/ui";

export function OptionChainTable({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  const chain = snapshot.optionChain;
  if (chain.strikes.length === 0) {
    return (
      <Panel title={`Option Chain — ${snapshot.symbol}`} status={chain.status}>
        <Unavailable reason={chain.message} />
      </Panel>
    );
  }

  // Show ATM ± 8 strikes to keep the table dense but readable
  const atmIdx = chain.strikes.findIndex((s) => s.isAtm);
  const from = Math.max(0, atmIdx - 8);
  const to = Math.min(chain.strikes.length, atmIdx + 9);
  const rows = chain.strikes.slice(from, to);
  const maxOi = Math.max(...chain.strikes.map((s) => Math.max(s.ce.oi ?? 0, s.pe.oi ?? 0)), 1);
  const maxMomentum = Math.max(...chain.strikes.map((s) => Math.max(s.ce.momentumScore ?? 0, s.pe.momentumScore ?? 0)), 1);

  const OiBar = ({ oi }: { oi: number | null }) => (
    <span className="flex items-center justify-end gap-1">
      <span className="inline-block h-1.5 w-10 overflow-hidden rounded bg-slate-800">
        <span
          className={`inline-block h-full ${oi === null ? "bg-transparent" : "bg-sky-500/60"}`}
          style={{ width: `${oi === null ? 0 : Math.max(3, (oi / maxOi) * 100)}%` }}
        />
      </span>
      <span className="mono">{fmtCompact(oi)}</span>
    </span>
  );

  return (
    <Panel
      title={`Option Chain — ${snapshot.symbol}`}
      subtitle={`Expiry ${chain.expiry ?? "n/a"} · ATM ${snapshot.selection.atmStrike ?? "n/a"} · Greeks ${chain.oi.greeksAvailable ? "provided by Upstox" : "unavailable"} · bid/ask quantity ${chain.oi.bidAskQtyAvailable ? "available" : "unavailable"}`}
      status={chain.status}
      right={<StatusBadge status={chain.status} small />}
    >
      <div className="swipe-hint overflow-x-auto scroll-thin">
        <table className="w-full min-w-[1500px] border-collapse">
          <thead>
            <tr>
              <Th align="right">CE OI</Th>
              <Th align="right">CE ΔOI</Th>
              <Th align="right">CE 5m ΔOI</Th>
              <Th align="right">CE Vol</Th>
              <Th align="right">CE IV</Th>
              <Th align="right">CE Δ</Th>
              <Th align="right">CE Θ</Th>
              <Th align="right">CE Bid/Ask</Th>
              <Th align="right">CE LTP</Th>
              <Th align="center">STRIKE</Th>
              <Th align="left">PE LTP</Th>
              <Th align="left">PE Bid/Ask</Th>
              <Th align="left">PE Θ</Th>
              <Th align="left">PE Δ</Th>
              <Th align="left">PE IV</Th>
              <Th align="left">PE Vol</Th>
              <Th align="left">PE 5m ΔOI</Th>
              <Th align="left">PE ΔOI</Th>
              <Th align="left">PE OI</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const isAtm = s.isAtm;
              const ceMomentumStrong = (s.ce.momentumScore ?? 0) >= maxMomentum * 0.75;
              const peMomentumStrong = (s.pe.momentumScore ?? 0) >= maxMomentum * 0.75;
              return (
                <tr key={s.strike} className={isAtm ? "bg-sky-500/10" : s.clusterLabel === "BULLISH_CLUSTER" ? "bg-emerald-500/5" : s.clusterLabel === "BEARISH_CLUSTER" ? "bg-rose-500/5" : ""}>
                  <Td align="right" tone="mono"><OiBar oi={s.ce.oi} /></Td>
                  <Td align="right" tone="mono">{s.ce.sessionOiChange === null ? "n/a" : fmtCompact(s.ce.sessionOiChange)}</Td>
                  <Td align="right" tone="mono">{s.ce.changeInOi === null ? "n/a" : fmtCompact(s.ce.changeInOi)}</Td>
                  <Td align="right" tone="mono">{fmtCompact(s.ce.volume)}</Td>
                  <Td align="right" tone="mono">{fmt(s.ce.iv)}</Td>
                  <Td align="right" tone="mono">{fmt(s.ce.delta, 3)}</Td>
                  <Td align="right" tone="mono">{fmt(s.ce.theta, 2)}</Td>
                  <Td align="right" tone="mono">{fmt(s.ce.bidPrice)} / {fmt(s.ce.askPrice)}</Td>
                  <Td align="right" className={ceMomentumStrong ? "font-semibold text-rose-300" : "text-slate-200"} tone="mono">
                    {fmt(s.ce.ltp)}
                  </Td>
                  <Td align="center" className={isAtm ? "font-bold text-sky-300" : "font-semibold text-slate-300"} tone="mono">
                    {fmt(s.strike, 0)}
                  </Td>
                  <Td align="left" className={peMomentumStrong ? "font-semibold text-emerald-300" : "text-slate-200"} tone="mono">
                    {fmt(s.pe.ltp)}
                  </Td>
                  <Td align="left" tone="mono">{fmt(s.pe.bidPrice)} / {fmt(s.pe.askPrice)}</Td>
                  <Td align="left" tone="mono">{fmt(s.pe.theta, 2)}</Td>
                  <Td align="left" tone="mono">{fmt(s.pe.delta, 3)}</Td>
                  <Td align="left" tone="mono">{fmt(s.pe.iv)}</Td>
                  <Td align="left" tone="mono">{fmtCompact(s.pe.volume)}</Td>
                  <Td align="left" tone="mono">{s.pe.changeInOi === null ? "n/a" : fmtCompact(s.pe.changeInOi)}</Td>
                  <Td align="left" tone="mono">{s.pe.sessionOiChange === null ? "n/a" : fmtCompact(s.pe.sessionOiChange)}</Td>
                  <Td align="left" tone="mono"><OiBar oi={s.pe.oi} /></Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-slate-500">
        <span><span className="mr-1 inline-block h-2 w-2 rounded bg-sky-500" />ATM strike</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded bg-emerald-500/40" />PE-dominant cluster</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded bg-rose-500/40" />CE-dominant cluster</span>
        <span>Bold premium = strongest momentum on that side (relative to the visible window)</span>
      </div>
    </Panel>
  );
}
