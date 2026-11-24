"use client";

import { useState } from "react";
import { Metric, Panel, StatusBadge, Td, Th, Unavailable, fmt, fmtCompact, fmtDateTime } from "@/components/ui";
import type { AnalysisSnapshot } from "@/lib/engine/types";

const GREEKS_MODULES = [
  "GREEKS_OVERVIEW",
  "DELTA_GAMMA_ANALYSIS",
  "THETA_VEGA_RISK",
  "IV_INTELLIGENCE",
  "OPTION_PARTICIPATION",
  "QUOTE_PRESSURE",
  "BEST_CE_FINDER",
  "BEST_PE_FINDER",
  "FINAL_COMPARISON",
] as const;

type GreeksSection = (typeof GREEKS_MODULES)[number];

const SECTION_LABELS: Record<GreeksSection, string> = {
  GREEKS_OVERVIEW: "Greeks Overview",
  DELTA_GAMMA_ANALYSIS: "Delta / Gamma Analysis",
  THETA_VEGA_RISK: "Theta / Vega Risk",
  IV_INTELLIGENCE: "IV Intelligence",
  OPTION_PARTICIPATION: "Option Participation",
  QUOTE_PRESSURE: "Buyer/Seller Quote Pressure",
  BEST_CE_FINDER: "Best CE Finder",
  BEST_PE_FINDER: "Best PE Finder",
  FINAL_COMPARISON: "Final Strike Comparison",
};

type MetricTone = "neutral" | "green" | "red" | "amber" | "blue" | "muted";

function toneClass(value: number | null | undefined): string {
  if (value === null || value === undefined) return "text-slate-500";
  return value > 0 ? "text-emerald-400" : value < 0 ? "text-rose-400" : "text-slate-400";
}

function toneFor(value: number | null | undefined): MetricTone {
  if (value === null || value === undefined) return "muted";
  return value > 0 ? "green" : value < 0 ? "red" : "neutral";
}

function Label({ text, tone }: { text: string; tone: string }) {
  return <span className={`rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${tone}`}>{text.replace(/_/g, " ")}</span>;
}

export function GreeksIntelligencePanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  const [section, setSection] = useState<GreeksSection>("GREEKS_OVERVIEW");

  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;

  const strikes = snapshot.optionChain.strikes;
  const withGreeks = strikes.filter((s) => s.ce.greeksAssessment || s.pe.greeksAssessment);
  const anyGreeks = withGreeks.length > 0;
  const atmIdx = strikes.findIndex((s) => s.isAtm);
  const window = strikes.slice(Math.max(0, atmIdx - 8), atmIdx === -1 ? strikes.length : atmIdx + 9);

  return (
    <Panel
      title={`Greeks Intelligence — ${snapshot.symbol}`}
      subtitle="Four separate intelligence layers, never merged: Greeks describe price sensitivities (Layer A); participation classifies premium/OI/volume interaction (Layer B); quote pressure reports displayed bid/ask liquidity (Layer C); executed buyer/seller dominance is NOT AVAILABLE from this data source."
      status={anyGreeks ? (snapshot.greeks.status === "LIVE" ? "LIVE" : "PARTIAL") : "PARTIAL"}
      right={<span className="mono text-[10px] text-slate-500">{fmtDateTime(snapshot.generatedAt)}</span>}
    >
      {/* Section navigation */}
      <div className="flex flex-wrap gap-1.5">
        {GREEKS_MODULES.map((m) => (
          <button
            key={m}
            onClick={() => setSection(m)}
            className={`rounded px-2.5 py-1.5 text-[11px] font-semibold ${section === m ? "bg-sky-600/25 text-sky-300 ring-1 ring-sky-600/40" : "bg-slate-900/60 text-slate-400"}`}
          >
            {SECTION_LABELS[m]}
          </button>
        ))}
      </div>

      {/* Executed dominance disclosure — always visible */}
      <div className="mt-3 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status="UNAVAILABLE" small />
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Executed buyer/seller dominance</span>
        </div>
        <div className="mt-1 text-[11px] text-slate-500">
          {EXECUTED_DOMINANCE_NOTE}
        </div>
      </div>

      <div className="mt-4">
        {section === "GREEKS_OVERVIEW" ? <GreeksOverview snapshot={snapshot} strikes={window} /> : null}
        {section === "DELTA_GAMMA_ANALYSIS" ? <DeltaGammaTable strikes={window} /> : null}
        {section === "THETA_VEGA_RISK" ? <ThetaVegaTable strikes={window} /> : null}
        {section === "IV_INTELLIGENCE" ? <IvPanel snapshot={snapshot} strikes={window} /> : null}
        {section === "OPTION_PARTICIPATION" ? <ParticipationTable strikes={window} /> : null}
        {section === "QUOTE_PRESSURE" ? <QuotePressureTable strikes={window} /> : null}
        {section === "BEST_CE_FINDER" ? <BestSide snapshot={snapshot} side="CE" /> : null}
        {section === "BEST_PE_FINDER" ? <BestSide snapshot={snapshot} side="PE" /> : null}
        {section === "FINAL_COMPARISON" ? <FinalComparison snapshot={snapshot} /> : null}
      </div>
    </Panel>
  );
}

const EXECUTED_DOMINANCE_NOTE =
  "Executed buyer/seller dominance requires trade-level execution data with aggressor-side classification. Upstox market data exposes option-chain snapshots (LTP, OI, volume, best bid/ask price and quantity) and does not provide individual trades or aggressor flags. CVD, footprint delta, executed volume delta and confirmed absorption are therefore NOT computed — deriving them from OI or displayed bid/ask quantities would be fabrication.";

/* ---------------- Overview ---------------- */

function GreeksOverview({ snapshot, strikes }: { snapshot: AnalysisSnapshot; strikes: AnalysisSnapshot["optionChain"]["strikes"] }) {
  const priced = strikes.filter((s) => (s.ce.ltp ?? 0) > 0 || (s.pe.ltp ?? 0) > 0);
  const ceGreeks = priced.map((s) => s.ce.greeksAssessment).filter((g): g is NonNullable<typeof g> => Boolean(g));
  const peGreeks = priced.map((s) => s.pe.greeksAssessment).filter((g): g is NonNullable<typeof g> => Boolean(g));

  const atmStrike = snapshot.selection.atmStrike;
  const atm = strikes.find((s) => s.isAtm);
  const ceIv = atm?.ce.iv ?? null;
  const peIv = atm?.pe.iv ?? null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Expiry" value={snapshot.optionChain.expiry ?? "n/a"} mono={false} />
        <Metric label="ATM strike" value={atmStrike ?? "n/a"} />
        <Metric label="Strikes shown" value={strikes.length} hint={`ATM ± 8 of ${snapshot.optionChain.strikes.length}`} />
        <Metric label="CE contracts with Greeks" value={ceGreeks.length} hint={`${ceGreeks.filter((g) => g.quality === "COMPLETE").length} complete`} />
        <Metric label="PE contracts with Greeks" value={peGreeks.length} hint={`${peGreeks.filter((g) => g.quality === "COMPLETE").length} complete`} />
        <Metric label="Greeks source" value={snapshot.greeks.source} mono={false} />
        <Metric label="ATM CE IV" value={ceIv === null ? "unavailable" : ceIv} />
        <Metric label="ATM PE IV" value={peIv === null ? "unavailable" : peIv} />
        <Metric
          label="ATM IV skew (CE − PE)"
          value={ceIv !== null && peIv !== null ? `${(ceIv - peIv).toFixed(2)}` : "unavailable"}
          hint="A skew is an observation, not a directional signal"
        />
        <Metric label="Median comparable gamma" value={ceGreeks[0]?.gamma ? "computed" : "n/a"} />
        <Metric label="Best CE composite" value={snapshot.selection.bestCall?.compositeScore ?? "n/a"} />
        <Metric label="Best PE composite" value={snapshot.selection.bestPut?.compositeScore ?? "n/a"} />
      </div>

      <div className="rounded border border-slate-800 bg-slate-900/40 p-3 text-[11px] leading-relaxed text-slate-400">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">How to read this</div>
        Delta measures premium sensitivity to the underlying — a higher |delta| means the premium moves more per point of the underlying, and is <span className="text-slate-200">not</span> a probability guarantee. Gamma measures how fast delta itself changes, so high gamma amplifies both gains and losses. Theta is the decay cost of holding a long option; it is compared as a ratio to premium so contracts across strikes are comparable. Vega and IV describe sensitivity to implied volatility — rising IV helps a long option, falling IV (IV crush) can reduce premium even when the underlying moves favourably. None of these four identifies a buyer or a seller.
      </div>
    </div>
  );
}

/* ---------------- Delta / Gamma ---------------- */

function DeltaGammaTable({ strikes }: { strikes: AnalysisSnapshot["optionChain"]["strikes"] }) {
  return (
    <div className="swipe-hint overflow-x-auto scroll-thin">
      <table className="w-full min-w-[1100px] border-collapse">
        <thead>
          <tr>
            <Th>Strike</Th>
            <Th align="right">CE Δ</Th>
            <Th align="right">CE |Δ|</Th>
            <Th>CE band</Th>
            <Th align="right">CE Γ rel</Th>
            <Th>CE Γ class</Th>
            <Th align="right">PE Δ</Th>
            <Th align="right">PE |Δ|</Th>
            <Th>PE band</Th>
            <Th align="right">PE Γ rel</Th>
            <Th>PE Γ class</Th>
            <Th align="right">CE Δ accel/%</Th>
          </tr>
        </thead>
        <tbody>
          {strikes.map((s) => {
            const cg = s.ce.greeksAssessment;
            const pg = s.pe.greeksAssessment;
            return (
              <tr key={s.strike} className={s.isAtm ? "bg-sky-500/10" : ""}>
                <Td className={s.isAtm ? "font-bold text-sky-300" : "font-semibold"} tone="mono">{fmt(s.strike, 0)}</Td>
                <Td align="right" tone="mono">{fmt(cg?.delta.value ?? s.ce.delta, 4)}</Td>
                <Td align="right" tone="mono">{fmt(cg?.delta.absolute ?? null, 3)}</Td>
                <Td>{cg ? <Label text={cg.delta.band} tone={cg.delta.band === "INSIDE" ? "border-emerald-600 bg-emerald-500/10 text-emerald-300" : "border-amber-600 bg-amber-500/10 text-amber-300"} /> : <span className="text-slate-600">n/a</span>}</Td>
                <Td align="right" tone="mono">{fmt(cg?.gamma.relativeToPeers ?? null, 2)}</Td>
                <Td>{cg ? <Label text={cg.gamma.classification} tone={gammaTone(cg.gamma.classification)} /> : <span className="text-slate-600">n/a</span>}</Td>
                <Td align="right" tone="mono">{fmt(pg?.delta.value ?? s.pe.delta, 4)}</Td>
                <Td align="right" tone="mono">{fmt(pg?.delta.absolute ?? null, 3)}</Td>
                <Td>{pg ? <Label text={pg.delta.band} tone={pg.delta.band === "INSIDE" ? "border-emerald-600 bg-emerald-500/10 text-emerald-300" : "border-amber-600 bg-amber-500/10 text-amber-300"} /> : <span className="text-slate-600">n/a</span>}</Td>
                <Td align="right" tone="mono">{fmt(pg?.gamma.relativeToPeers ?? null, 2)}</Td>
                <Td>{pg ? <Label text={pg.gamma.classification} tone={gammaTone(pg.gamma.classification)} /> : <span className="text-slate-600">n/a</span>}</Td>
                <Td align="right" tone="mono">{fmt(cg?.gamma.deltaAccelerationPerPct ?? null, 2)}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function gammaTone(c: string): string {
  switch (c) {
    case "EXTREME":
      return "border-rose-600 bg-rose-500/10 text-rose-300";
    case "HIGH":
      return "border-amber-600 bg-amber-500/10 text-amber-300";
    case "MODERATE":
      return "border-emerald-600 bg-emerald-500/10 text-emerald-300";
    case "LOW":
      return "border-slate-600 bg-slate-500/10 text-slate-400";
    default:
      return "border-slate-700 bg-slate-900 text-slate-600";
  }
}

/* ---------------- Theta / Vega ---------------- */

function ThetaVegaTable({ strikes }: { strikes: AnalysisSnapshot["optionChain"]["strikes"] }) {
  return (
    <div className="space-y-3">
      <div className="swipe-hint overflow-x-auto scroll-thin">
        <table className="w-full min-w-[1000px] border-collapse">
          <thead>
            <tr>
              <Th>Strike</Th>
              <Th align="right">CE Θ</Th>
              <Th align="right">CE Θ/prem</Th>
              <Th>CE decay class</Th>
              <Th align="right">CE Vega</Th>
              <Th align="right">PE Θ</Th>
              <Th align="right">PE Θ/prem</Th>
              <Th>PE decay class</Th>
              <Th align="right">PE Vega</Th>
              <Th>Expiry risk</Th>
            </tr>
          </thead>
          <tbody>
            {strikes.map((s) => {
              const cg = s.ce.greeksAssessment;
              const pg = s.pe.greeksAssessment;
              return (
                <tr key={s.strike} className={s.isAtm ? "bg-sky-500/10" : ""}>
                  <Td className={s.isAtm ? "font-bold text-sky-300" : "font-semibold"} tone="mono">{fmt(s.strike, 0)}</Td>
                  <Td align="right" tone="mono">{fmt(cg?.theta.value ?? s.ce.theta, 3)}</Td>
                  <Td align="right" tone={cg?.theta.ratioToLtp != null ? (cg.theta.ratioToLtp > 0.2 ? "text-rose-400" : "text-emerald-400") : "text-slate-500"}>
                    {cg?.theta.ratioToLtp != null ? `${(cg.theta.ratioToLtp * 100).toFixed(2)}%` : "n/a"}
                  </Td>
                  <Td>{cg ? <Label text={cg.theta.classification} tone={thetaTone(cg.theta.classification)} /> : <span className="text-slate-600">n/a</span>}</Td>
                  <Td align="right" tone="mono">{fmt(cg?.vega.value ?? s.ce.vega, 3)}</Td>
                  <Td align="right" tone="mono">{fmt(pg?.theta.value ?? s.pe.theta, 3)}</Td>
                  <Td align="right" tone={pg?.theta.ratioToLtp != null ? (pg.theta.ratioToLtp > 0.2 ? "text-rose-400" : "text-emerald-400") : "text-slate-500"}>
                    {pg?.theta.ratioToLtp != null ? `${(pg.theta.ratioToLtp * 100).toFixed(2)}%` : "n/a"}
                  </Td>
                  <Td>{pg ? <Label text={pg.theta.classification} tone={thetaTone(pg.theta.classification)} /> : <span className="text-slate-600">n/a</span>}</Td>
                  <Td align="right" tone="mono">{fmt(pg?.vega.value ?? s.pe.vega, 3)}</Td>
                  <Td>{cg ? <Label text={cg.gamma.expiryAdjustedRisk} tone={cg.gamma.expiryAdjustedRisk === "SEVERE" ? "border-rose-600 bg-rose-500/10 text-rose-300" : cg.gamma.expiryAdjustedRisk === "ELEVATED" ? "border-amber-600 bg-amber-500/10 text-amber-300" : "border-emerald-600 bg-emerald-500/10 text-emerald-300"} /> : <span className="text-slate-600">n/a</span>}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {strikes.some((s) => s.ce.greeksAssessment) ? (
        <div className="rounded border border-slate-800 bg-slate-900/40 p-3 text-[11px] text-slate-400">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Theta convention </span>
          {strikes.find((s) => s.ce.greeksAssessment)?.ce.greeksAssessment?.theta.convention}
        </div>
      ) : null}
    </div>
  );
}

function thetaTone(c: string): string {
  switch (c) {
    case "CHEAP":
      return "border-emerald-600 bg-emerald-500/10 text-emerald-300";
    case "REASONABLE":
      return "border-sky-600 bg-sky-500/10 text-sky-300";
    case "EXPENSIVE":
      return "border-amber-600 bg-amber-500/10 text-amber-300";
    case "SEVERE":
      return "border-rose-600 bg-rose-500/10 text-rose-300";
    default:
      return "border-slate-700 bg-slate-900 text-slate-600";
  }
}

/* ---------------- IV Intelligence ---------------- */

function IvPanel({ snapshot, strikes }: { snapshot: AnalysisSnapshot; strikes: AnalysisSnapshot["optionChain"]["strikes"] }) {
  const withIv = strikes.filter((s) => s.ce.iv !== null || s.pe.iv !== null);
  const ceIvs = withIv.map((s) => s.ce.iv).filter((v): v is number => v !== null);
  const peIvs = withIv.map((s) => s.pe.iv).filter((v): v is number => v !== null);
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const ceAvg = avg(ceIvs);
  const peAvg = avg(peIvs);
  const ivExpansion = strikes.reduce((acc, s) => {
    const c = s.ce.greeksAssessment?.vega.ivChange ?? null;
    const p = s.pe.greeksAssessment?.vega.ivChange ?? null;
    return acc + (c !== null && c > 0 ? 1 : 0) + (p !== null && p > 0 ? 1 : 0);
  }, 0);
  const ivContraction = strikes.reduce((acc, s) => {
    const c = s.ce.greeksAssessment?.vega.ivChange ?? null;
    const p = s.pe.greeksAssessment?.vega.ivChange ?? null;
    return acc + (c !== null && c < 0 ? 1 : 0) + (p !== null && p < 0 ? 1 : 0);
  }, 0);
  const ivObsCount = snapshot.dataFoundation?.counts?.premiumObservationCount ?? 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Average CE IV" value={ceAvg === null ? "unavailable" : ceAvg.toFixed(2)} />
        <Metric label="Average PE IV" value={peAvg === null ? "unavailable" : peAvg.toFixed(2)} />
        <Metric label="CE − PE IV" value={ceAvg !== null && peAvg !== null ? (ceAvg - peAvg).toFixed(2) : "unavailable"} hint="Skew observation, not a directional signal" />
        <Metric label="Contracts with IV expanding" value={ivExpansion} tone={ivExpansion > 0 ? "green" : "muted"} />
        <Metric label="Contracts with IV contracting" value={ivContraction} tone={ivContraction > 0 ? "amber" : "muted"} />
        <Metric label="Stored IV observations" value={ivObsCount} hint="Percentile requires ≥10 observations" />
      </div>
      <div className="swipe-hint overflow-x-auto scroll-thin">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr>
              <Th>Strike</Th>
              <Th align="right">CE IV</Th>
              <Th align="right">CE IV vs peers</Th>
              <Th align="right">CE IV Δ5m</Th>
              <Th>CE IV class</Th>
              <Th align="right">PE IV</Th>
              <Th align="right">PE IV vs peers</Th>
              <Th align="right">PE IV Δ5m</Th>
              <Th>PE IV class</Th>
            </tr>
          </thead>
          <tbody>
            {withIv.map((s) => {
              const cg = s.ce.greeksAssessment;
              const pg = s.pe.greeksAssessment;
              return (
                <tr key={s.strike} className={s.isAtm ? "bg-sky-500/10" : ""}>
                  <Td className={s.isAtm ? "font-bold text-sky-300" : "font-semibold"} tone="mono">{fmt(s.strike, 0)}</Td>
                  <Td align="right" tone="mono">{fmt(s.ce.iv, 2)}</Td>
                  <Td align="right" tone="mono">{fmt(cg?.vega.ivRelativeToPeers ?? null, 2)}</Td>
                  <Td align="right" tone={toneClass(cg?.vega.ivChange ?? null)}>{fmt(cg?.vega.ivChange ?? null, 3)}</Td>
                  <Td>{cg ? <Label text={cg.vega.classification} tone={ivTone(cg.vega.classification)} /> : <span className="text-slate-600">n/a</span>}</Td>
                  <Td align="right" tone="mono">{fmt(s.pe.iv, 2)}</Td>
                  <Td align="right" tone="mono">{fmt(pg?.vega.ivRelativeToPeers ?? null, 2)}</Td>
                  <Td align="right" tone={toneClass(pg?.vega.ivChange ?? null)}>{fmt(pg?.vega.ivChange ?? null, 3)}</Td>
                  <Td>{pg ? <Label text={pg.vega.classification} tone={ivTone(pg.vega.classification)} /> : <span className="text-slate-600">n/a</span>}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="rounded border border-amber-800/50 bg-amber-500/5 p-2.5 text-[11px] text-amber-200/90">
        IV percentile is computed only when at least 10 timestamped IV observations are stored. {ivObsCount < 10 ? `Currently ${ivObsCount} stored — percentile is unavailable rather than estimated.` : `Percentile is available from ${ivObsCount} observations.`} High IV is never interpreted as bullish or bearish by itself.
      </div>
    </div>
  );
}

function ivTone(c: string): string {
  switch (c) {
    case "ELEVATED":
      return "border-amber-600 bg-amber-500/10 text-amber-300";
    case "NORMAL":
      return "border-emerald-600 bg-emerald-500/10 text-emerald-300";
    case "BELOW_NORMAL":
      return "border-sky-600 bg-sky-500/10 text-sky-300";
    default:
      return "border-slate-700 bg-slate-900 text-slate-600";
  }
}

/* ---------------- Participation ---------------- */

function ParticipationTable({ strikes }: { strikes: AnalysisSnapshot["optionChain"]["strikes"] }) {
  return (
    <div className="space-y-3">
      <div className="rounded border border-slate-800 bg-slate-900/40 p-2.5 text-[11px] text-slate-400">
        These are aggregate premium/OI/volume interaction patterns over stated time windows. They do <span className="text-slate-200">not</span> identify which participant type initiated the change, and an OI increase alone is never treated as proof of option writing.
      </div>
      <div className="swipe-hint overflow-x-auto scroll-thin">
        <table className="w-full min-w-[1200px] border-collapse">
          <thead>
            <tr>
              <Th>Strike</Th>
              <Th>CE pattern</Th>
              <Th align="right">CE prem Δ</Th>
              <Th align="right">CE OI Δ</Th>
              <Th>CE confidence</Th>
              <Th>CE buyer/seller</Th>
              <Th>PE pattern</Th>
              <Th align="right">PE prem Δ</Th>
              <Th align="right">PE OI Δ</Th>
              <Th>PE confidence</Th>
              <Th>PE buyer/seller</Th>
            </tr>
          </thead>
          <tbody>
            {strikes.map((s) => (
              <tr key={s.strike} className={s.isAtm ? "bg-sky-500/10" : ""}>
                <Td className={s.isAtm ? "font-bold text-sky-300" : "font-semibold"} tone="mono">{fmt(s.strike, 0)}</Td>
                <Td>{s.ce.participation ? <Label text={s.ce.participation.pattern} tone={patternTone(s.ce.participation.pattern)} /> : <span className="text-slate-600">n/a</span>}</Td>
                <Td align="right" tone={toneClass(s.ce.premiumChange)}>{fmt(s.ce.premiumChange, 2)}</Td>
                <Td align="right" tone={toneClass(s.ce.changeInOi)}>{s.ce.changeInOi === null ? "n/a" : fmtCompact(s.ce.changeInOi)}</Td>
                <Td>{s.ce.participation ? <Label text={s.ce.participation.confidence} tone={confTone(s.ce.participation.confidence)} /> : <span className="text-slate-600">n/a</span>}</Td>
                <Td>{s.ce.buyerSeller ? <Label text={s.ce.buyerSeller.label} tone={bsTone(s.ce.buyerSeller.label)} /> : <span className="text-slate-600">n/a</span>}</Td>
                <Td>{s.pe.participation ? <Label text={s.pe.participation.pattern} tone={patternTone(s.pe.participation.pattern)} /> : <span className="text-slate-600">n/a</span>}</Td>
                <Td align="right" tone={toneClass(s.pe.premiumChange)}>{fmt(s.pe.premiumChange, 2)}</Td>
                <Td align="right" tone={toneClass(s.pe.changeInOi)}>{s.pe.changeInOi === null ? "n/a" : fmtCompact(s.pe.changeInOi)}</Td>
                <Td>{s.pe.participation ? <Label text={s.pe.participation.confidence} tone={confTone(s.pe.participation.confidence)} /> : <span className="text-slate-600">n/a</span>}</Td>
                <Td>{s.pe.buyerSeller ? <Label text={s.pe.buyerSeller.label} tone={bsTone(s.pe.buyerSeller.label)} /> : <span className="text-slate-600">n/a</span>}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function patternTone(p: string): string {
  switch (p) {
    case "LONG_BUILDUP_PATTERN":
      return "border-emerald-600 bg-emerald-500/10 text-emerald-300";
    case "SHORT_BUILDUP_PATTERN":
      return "border-amber-600 bg-amber-500/10 text-amber-300";
    case "SHORT_COVERING_PATTERN":
      return "border-sky-600 bg-sky-500/10 text-sky-300";
    case "LONG_UNWINDING_PATTERN":
      return "border-rose-600 bg-rose-500/10 text-rose-300";
    default:
      return "border-slate-700 bg-slate-900 text-slate-600";
  }
}

function confTone(c: string): string {
  switch (c) {
    case "HIGH":
      return "border-emerald-600 bg-emerald-500/10 text-emerald-300";
    case "MEDIUM":
      return "border-sky-600 bg-sky-500/10 text-sky-300";
    case "LOW":
      return "border-amber-600 bg-amber-500/10 text-amber-300";
    default:
      return "border-slate-700 bg-slate-900 text-slate-600";
  }
}

function bsTone(l: string): string {
  if (l.endsWith("BUYER_PARTICIPATION")) return "border-emerald-600 bg-emerald-500/10 text-emerald-300";
  if (l.endsWith("WRITER_SHORT_BUILDUP_PATTERN")) return "border-amber-600 bg-amber-500/10 text-amber-300";
  if (l === "SHORT_COVERING") return "border-sky-600 bg-sky-500/10 text-sky-300";
  if (l === "LONG_UNWINDING") return "border-rose-600 bg-rose-500/10 text-rose-300";
  return "border-slate-700 bg-slate-900 text-slate-500";
}

/* ---------------- Quote Pressure ---------------- */

function QuotePressureTable({ strikes }: { strikes: AnalysisSnapshot["optionChain"]["strikes"] }) {
  return (
    <div className="space-y-3">
      <div className="rounded border border-slate-800 bg-slate-900/40 p-2.5 text-[11px] text-slate-400">
        Displayed liquidity from best bid/ask price and quantity (D0 level). Displayed orders are not executed trades, so this is <span className="text-slate-200">not</span> executed buying or selling pressure.
      </div>
      <div className="swipe-hint overflow-x-auto scroll-thin">
        <table className="w-full min-w-[1150px] border-collapse">
          <thead>
            <tr>
              <Th>Strike</Th>
              <Th align="right">CE bid/ask</Th>
              <Th align="right">CE qty b/a</Th>
              <Th align="right">CE imbalance</Th>
              <Th>CE pressure</Th>
              <Th align="right">PE bid/ask</Th>
              <Th align="right">PE qty b/a</Th>
              <Th align="right">PE imbalance</Th>
              <Th>PE pressure</Th>
              <Th align="right">CE spread%</Th>
            </tr>
          </thead>
          <tbody>
            {strikes.map((s) => {
              const cq = s.ce.quotePressure;
              const pq = s.pe.quotePressure;
              return (
                <tr key={s.strike} className={s.isAtm ? "bg-sky-500/10" : ""}>
                  <Td className={s.isAtm ? "font-bold text-sky-300" : "font-semibold"} tone="mono">{fmt(s.strike, 0)}</Td>
                  <Td align="right" tone="mono">{fmt(s.ce.bidPrice)} / {fmt(s.ce.askPrice)}</Td>
                  <Td align="right" tone="mono">{cq?.quantitiesAvailable ? `${cq.bidQty ?? 0} / ${cq.askQty ?? 0}` : "unavailable"}</Td>
                  <Td align="right" tone={toneClass(cq?.imbalance ?? null)}>{cq?.imbalance != null ? `${(cq.imbalance * 100).toFixed(0)}%` : "n/a"}</Td>
                  <Td>{cq ? <Label text={cq.label} tone={qpTone(cq.label)} /> : <span className="text-slate-600">n/a</span>}</Td>
                  <Td align="right" tone="mono">{fmt(s.pe.bidPrice)} / {fmt(s.pe.askPrice)}</Td>
                  <Td align="right" tone="mono">{pq?.quantitiesAvailable ? `${pq.bidQty ?? 0} / ${pq.askQty ?? 0}` : "unavailable"}</Td>
                  <Td align="right" tone={toneClass(pq?.imbalance ?? null)}>{pq?.imbalance != null ? `${(pq.imbalance * 100).toFixed(0)}%` : "n/a"}</Td>
                  <Td>{pq ? <Label text={pq.label} tone={qpTone(pq.label)} /> : <span className="text-slate-600">n/a</span>}</Td>
                  <Td align="right" tone="mono">{fmt(s.ce.spreadPct)}%</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function qpTone(l: string): string {
  switch (l) {
    case "BID_SIDE_HEAVY":
      return "border-emerald-600 bg-emerald-500/10 text-emerald-300";
    case "ASK_SIDE_HEAVY":
      return "border-rose-600 bg-rose-500/10 text-rose-300";
    case "BALANCED":
      return "border-sky-600 bg-sky-500/10 text-sky-300";
    case "ONE_SIDED_ASK_ONLY":
    case "ONE_SIDED_BID_ONLY":
      return "border-amber-600 bg-amber-500/10 text-amber-300";
    default:
      return "border-slate-700 bg-slate-900 text-slate-600";
  }
}

/* ---------------- Best side ---------------- */

function BestSide({ snapshot, side }: { snapshot: AnalysisSnapshot; side: "CE" | "PE" }) {
  const best = side === "CE" ? snapshot.selection.bestCall : snapshot.selection.bestPut;
  const ranked = (side === "CE" ? snapshot.strikeMomentum.ceRanked : snapshot.strikeMomentum.peRanked).slice(0, 8);

  if (!best) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status="UNAVAILABLE" />
          <span className="text-[12px] font-bold uppercase tracking-wider text-slate-300">NO ELIGIBLE CONTRACT — INSUFFICIENT EVIDENCE</span>
        </div>
        <ul className="mt-2 space-y-1 text-[11px] text-slate-400">
          {snapshot.selection.rationale.map((r, i) => (
            <li key={i}>• {r}</li>
          ))}
        </ul>
        <div className="mt-2 text-[11px] text-slate-500">No fallback contract is fabricated when mandatory conditions fail.</div>
      </div>
    );
  }

  const ga = best.leg.greeksAssessment;
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-sky-700/50 bg-sky-500/5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Best {side === "CE" ? "CALL BUY" : "PUT BUY"} candidate</div>
            <div className="mono mt-1 text-[18px] font-bold text-slate-100">
              {fmt(best.strike, 0)} {best.optionType} <span className="text-[11px] text-slate-500">({best.classification}, {best.leg.tradingSymbol ?? best.leg.instrumentKey ?? "symbol unavailable"})</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label="A · Setup" value={snapshot.trade.setupScore ?? "n/a"} hint="underlying direction" />
            <Metric label="B · Greeks" value={best.greeksSuitabilityScore ?? "n/a"} hint={best.greeksSuitabilityClass ?? undefined} />
            <Metric label="C · Execution" value={best.executionQualityScore ?? "n/a"} hint={`coverage ${Math.round((best.executionCoverage ?? 0) * 100)}%`} />
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <Metric label="LTP" value={fmt(best.leg.ltp)} />
          <Metric label="Expiry" value={snapshot.optionChain.expiry ?? "n/a"} />
          <Metric label="Delta" value={fmt(best.leg.delta, 3)} />
          <Metric label="Gamma" value={fmt(best.leg.gamma, 5)} />
          <Metric label="Theta" value={fmt(best.leg.theta, 3)} />
          <Metric label="Vega" value={fmt(best.leg.vega, 3)} />
          <Metric label="IV" value={fmt(best.leg.iv, 2)} />
          <Metric label="Premium Δ%" value={`${fmt(best.leg.premiumChangePct)}%`} tone={toneFor(best.leg.premiumChangePct)} />
          <Metric label="5m momentum" value={fmt(best.leg.momentum5m ?? null, 2)} tone={toneFor(best.leg.momentum5m ?? null)} />
          <Metric label="15m momentum" value={fmt(best.leg.momentum15m ?? null, 2)} tone={toneFor(best.leg.momentum15m ?? null)} />
          <Metric label="OI" value={fmtCompact(best.leg.oi)} />
          <Metric label="OI Δ 5m" value={best.leg.changeInOi === null ? "n/a" : fmtCompact(best.leg.changeInOi)} />
          <Metric label="Volume" value={fmtCompact(best.leg.volume)} />
          <Metric label="Rel. volume" value={fmt(best.leg.relativeVolume)} />
          <Metric label="Bid/ask" value={`${fmt(best.leg.bidPrice)} / ${fmt(best.leg.askPrice)}`} />
          <Metric label="Spread %" value={fmt(best.leg.spreadPct)} />
        </div>
        {ga ? (
          <div className="mt-3 rounded border border-slate-800 bg-slate-900/50 p-2.5 text-[11px] text-slate-400">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Greeks trade-off</div>
            <div className="mt-1">{ga.tradeOff}</div>
            <div className="mt-1 text-[10px] text-slate-500">Delta band: {ga.delta.band} · gamma {ga.gamma.classification.toLowerCase()} · decay {(ga.theta.ratioToLtp ?? 0) * 100 > 0 ? `${((ga.theta.ratioToLtp ?? 0) * 100).toFixed(2)}%` : "n/a"} · IV {ga.vega.classification.toLowerCase()}. Greeks evidence coverage {Math.round(ga.evidenceCoverage * 100)}%.</div>
          </div>
        ) : null}
        {best.risks.length > 0 ? (
          <div className="mt-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-amber-400">Risk warnings</div>
            <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
              {best.risks.map((r, i) => (
                <li key={i}>⚠ {r}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="swipe-hint overflow-x-auto scroll-thin">
        <table className="w-full min-w-[980px] border-collapse">
          <thead>
            <tr>
              <Th>Rank</Th>
              <Th>Strike</Th>
              <Th>Type</Th>
              <Th align="right">B · Greeks</Th>
              <Th align="right">C · Execution</Th>
              <Th align="right">Composite</Th>
              <Th align="right">LTP</Th>
              <Th align="right">Δ</Th>
              <Th align="right">Γ rel</Th>
              <Th align="right">Θ/prem</Th>
              <Th align="right">IV</Th>
              <Th align="right">Rel vol</Th>
              <Th align="right">Spread%</Th>
              <Th>Class</Th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((c, i) => (
              <tr key={`${c.optionType}-${c.strike}`} className={c.strike === best.strike ? "bg-sky-500/10" : ""}>
                <Td tone="mono">{i + 1}</Td>
                <Td className="font-semibold" tone="mono">{fmt(c.strike, 0)}</Td>
                <Td tone="text-slate-400">{c.classification}</Td>
                <Td align="right" tone="mono">{c.greeksSuitabilityScore ?? "n/a"}</Td>
                <Td align="right" tone="mono">{c.executionQualityScore ?? "n/a"}</Td>
                <Td align="right" tone="mono font-semibold">{c.compositeScore ?? "n/a"}</Td>
                <Td align="right" tone="mono">{fmt(c.leg.ltp)}</Td>
                <Td align="right" tone="mono">{fmt(c.leg.delta, 3)}</Td>
                <Td align="right" tone="mono">{fmt(c.leg.greeksAssessment?.gamma.relativeToPeers ?? null, 2)}</Td>
                <Td align="right" tone="mono">{c.leg.greeksAssessment?.theta.ratioToLtp != null ? `${(c.leg.greeksAssessment.theta.ratioToLtp * 100).toFixed(1)}%` : "n/a"}</Td>
                <Td align="right" tone="mono">{fmt(c.leg.iv, 2)}</Td>
                <Td align="right" tone="mono">{fmt(c.leg.relativeVolume)}</Td>
                <Td align="right" tone="mono">{fmt(c.leg.spreadPct)}%</Td>
                <Td>{c.greeksSuitabilityClass ?? "n/a"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Final comparison ---------------- */

function FinalComparison({ snapshot }: { snapshot: AnalysisSnapshot }) {
  const call = snapshot.selection.bestCall;
  const put = snapshot.selection.bestPut;
  const eligible = Boolean(call && put);
  return (
    <div className="space-y-3">
      {!eligible ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-3">
          <div className="text-[12px] font-bold uppercase tracking-wider text-slate-300">NO ELIGIBLE CONTRACT — INSUFFICIENT EVIDENCE</div>
          <ul className="mt-2 space-y-1 text-[11px] text-slate-400">
            {snapshot.selection.rationale.map((r, i) => (
              <li key={i}>• {r}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="swipe-hint overflow-x-auto scroll-thin">
          <table className="w-full min-w-[900px] border-collapse">
            <thead>
              <tr>
                <Th>Field</Th>
                <Th align="right">Best CE</Th>
                <Th align="right">Best PE</Th>
              </tr>
            </thead>
            <tbody>
              <ComparisonRow label="Strike" ce={fmt(call!.strike, 0)} pe={fmt(put!.strike, 0)} />
              <ComparisonRow label="ITM/ATM/OTM" ce={call!.classification} pe={put!.classification} />
              <ComparisonRow label="Instrument key" ce={call!.leg.instrumentKey ?? "n/a"} pe={put!.leg.instrumentKey ?? "n/a"} />
              <ComparisonRow label="LTP" ce={fmt(call!.leg.ltp)} pe={fmt(put!.leg.ltp)} />
              <ComparisonRow label="Delta" ce={fmt(call!.leg.delta, 3)} pe={fmt(put!.leg.delta, 3)} />
              <ComparisonRow label="Gamma" ce={fmt(call!.leg.gamma, 5)} pe={fmt(put!.leg.gamma, 5)} />
              <ComparisonRow label="Theta" ce={fmt(call!.leg.theta, 3)} pe={fmt(put!.leg.theta, 3)} />
              <ComparisonRow label="Vega" ce={fmt(call!.leg.vega, 3)} pe={fmt(put!.leg.vega, 3)} />
              <ComparisonRow label="IV" ce={fmt(call!.leg.iv, 2)} pe={fmt(put!.leg.iv, 2)} />
              <ComparisonRow label="Premium Δ%" ce={fmt(call!.leg.premiumChangePct)} pe={fmt(put!.leg.premiumChangePct)} />
              <ComparisonRow label="5m momentum" ce={fmt(call!.leg.momentum5m ?? null)} pe={fmt(put!.leg.momentum5m ?? null)} />
              <ComparisonRow label="OI" ce={fmtCompact(call!.leg.oi)} pe={fmtCompact(put!.leg.oi)} />
              <ComparisonRow label="OI Δ 5m" ce={call!.leg.changeInOi === null ? "n/a" : fmtCompact(call!.leg.changeInOi)} pe={put!.leg.changeInOi === null ? "n/a" : fmtCompact(put!.leg.changeInOi)} />
              <ComparisonRow label="Volume" ce={fmtCompact(call!.leg.volume)} pe={fmtCompact(put!.leg.volume)} />
              <ComparisonRow label="Relative volume" ce={fmt(call!.leg.relativeVolume)} pe={fmt(put!.leg.relativeVolume)} />
              <ComparisonRow label="Spread %" ce={fmt(call!.leg.spreadPct)} pe={fmt(put!.leg.spreadPct)} />
              <ComparisonRow label="A · Directional setup" ce={fmt(snapshot.trade.setupScore)} pe={fmt(snapshot.trade.setupScore)} />
              <ComparisonRow label="B · Greeks suitability" ce={fmt(call!.greeksSuitabilityScore)} pe={fmt(put!.greeksSuitabilityScore)} />
              <ComparisonRow label="C · Execution quality" ce={fmt(call!.executionQualityScore)} pe={fmt(put!.executionQualityScore)} />
              <ComparisonRow label="Composite" ce={fmt(call!.compositeScore)} pe={fmt(put!.compositeScore)} />
              <ComparisonRow label="Evidence coverage" ce={`${Math.round((call!.greeksCoverage ?? 0) * 100)}%`} pe={`${Math.round((put!.greeksCoverage ?? 0) * 100)}%`} />
            </tbody>
          </table>
        </div>
      )}
      <div className="rounded border border-slate-800 bg-slate-900/40 p-2.5 text-[11px] text-slate-400">
        The three scores are reported separately and never collapsed into one number: <span className="text-slate-200">A</span> is underlying direction, <span className="text-slate-200">B</span> is contract sensitivity/risk from Greeks, <span className="text-slate-200">C</span> is executability. These are engineering rankings, not validated probabilities of profit.
      </div>
    </div>
  );
}

function ComparisonRow({ label, ce, pe }: { label: string; ce: string; pe: string }) {
  return (
    <tr>
      <Td className="font-semibold text-slate-300">{label}</Td>
      <Td align="right" tone="mono">{ce}</Td>
      <Td align="right" tone="mono">{pe}</Td>
    </tr>
  );
}
