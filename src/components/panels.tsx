"use client";

import { useEffect, useState } from "react";
import type { AnalysisSnapshot, SrLevelSelection, Zone } from "@/lib/engine/types";
import {
  Delta,
  Metric,
  Panel,
  ScoreBar,
  StatusBadge,
  Td,
  Th,
  Unavailable,
  fmt,
  fmtCompact,
  fmtDateTime,
  fmtTime,
  statusTone,
} from "@/components/ui";

function foundationFor(snapshot: AnalysisSnapshot | null) {
  return snapshot?.dataFoundation ?? null;
}

function ModuleGate({ snapshot, module, children }: { snapshot: AnalysisSnapshot | null; module: string; children: React.ReactNode }) {
  const df = foundationFor(snapshot);
  const m = df?.modules.find((x) => x.module === module);
  if (!m) return <>{children}</>;
  // READY / PARTIAL render the real content.
  if (m.ready) return <>{children}</>;
  // Otherwise render the explicit gate explanation instead of a blank panel.
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded border border-slate-600 bg-slate-800/60 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-400">
          {m.state.replace(/_/g, " ")}
        </span>
        <span className="text-[12px] font-semibold text-slate-300">{module.replace(/_/g, " ")} — not yet analysable</span>
      </div>
      <div className="mt-2 text-[11px] leading-relaxed text-slate-400">{m.reason}</div>
      {m.missing.length > 0 ? (
        <div className="mt-2 text-[11px] text-rose-300">Missing: {m.missing.join("; ")}</div>
      ) : null}
      {m.pendingHistory.length > 0 ? (
        <div className="mt-1 text-[11px] text-sky-300">Waiting for history: {m.pendingHistory.join("; ")}</div>
      ) : null}
      {m.present.length > 0 ? (
        <div className="mt-2 text-[11px] text-emerald-400">Available now: {m.present.join("; ")}</div>
      ) : null}
      {m.action ? <div className="mt-2 text-[11px] text-amber-300">Next: {m.action}</div> : null}
    </div>
  );
}

const TONE_CLASS: Record<string, string> = {
  green: "text-emerald-400",
  red: "text-rose-400",
  amber: "text-amber-300",
  muted: "text-slate-400",
};

/* ------------------------------------------------------------------ *
 * Dynamic S/R intelligence
 * ------------------------------------------------------------------ */

function LevelRow({ sel, role }: { sel: SrLevelSelection | null; role: string }) {
  if (!sel) {
    return (
      <tr>
        <Td>{role}</Td>
        <Td tone="text-slate-500">UNAVAILABLE — no distinct valid zone (not fabricated)</Td>
        <Td>-</Td>
        <Td>-</Td>
        <Td>-</Td>
        <Td>-</Td>
        <Td>-</Td>
        <Td>-</Td>
        <Td>-</Td>
        <Td>-</Td>
      </tr>
    );
  }
  const z = sel.zone;
  return (
    <tr>
      <Td className="font-semibold text-slate-200">{role}</Td>
      <Td tone="text-slate-100 mono">
        {fmt(z.lower)} – {fmt(z.upper)} <span className="text-slate-500">({z.widthPct.toFixed(2)}% wide)</span>
      </Td>
      <Td>
        <ScoreBar score={z.score} label={`${z.score} · ${z.classification.replace("_", " ")}`} />
      </Td>
      <Td>
        <span className={`text-[11px] font-semibold ${TONE_CLASS[statusTone(z.status)]}`}>{z.status.replace("_", " ")}</span>
        <div className="max-w-[280px] whitespace-normal text-[10px] text-slate-500">{z.statusReason}</div>
      </Td>
      <Td>
        <Delta value={z.scoreChange5m} />
        <div className="text-[10px] text-slate-500">15m <Delta value={z.scoreChange15m} /></div>
      </Td>
      <Td tone="mono">{fmt(z.prevScore)}</Td>
      <Td tone="mono">{z.tests}</Td>
      <Td tone="mono">{fmtTime(z.lastTestedAt ? new Date(z.lastTestedAt).toISOString() : null)}</Td>
      <Td tone="mono">{z.timeframeConfluence.join(", ")}</Td>
      <Td>
        <div className="w-28">
          <ScoreBar score={Math.round(z.evidence.coverage * 100)} label={`${Math.round(z.evidence.coverage * 100)}%`} />
        </div>
        <div className="text-[10px] text-slate-500">missing: {z.evidence.missing.join(", ") || "none"}</div>
      </Td>
    </tr>
  );
}

export function SrPanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  const levels = snapshot.levels;
  return (
    <Panel
      title="Dynamic Support & Resistance Intelligence"
      subtitle="Zones are formed from clustered structural reactions, rejection quality, consolidation boundaries, volume nodes, OI clusters and futures/quote confluence. Width is derived from ATR, local volatility, tick size and reaction dispersion — never from fixed intervals."
      status={snapshot.dataQuality.entries.find((e) => e.module === "CANDLES")?.status}
    >
      <div className="swipe-hint overflow-x-auto scroll-thin">
        <table className="w-full min-w-[1100px] border-collapse">
          <thead>
            <tr>
              <Th>Level</Th>
              <Th>Zone range</Th>
              <Th>Strength</Th>
              <Th>Directional status</Th>
              <Th>5m / 15m score Δ</Th>
              <Th>Prev score</Th>
              <Th>Tests</Th>
              <Th>Last tested</Th>
              <Th>TF confluence</Th>
              <Th>Evidence coverage</Th>
            </tr>
          </thead>
          <tbody>
            <LevelRow sel={levels.immediateSupport} role="IMMEDIATE SUPPORT" />
            <LevelRow sel={levels.primarySupport} role="PRIMARY SUPPORT" />
            <LevelRow sel={levels.immediateResistance} role="IMMEDIATE RESISTANCE" />
            <LevelRow sel={levels.primaryResistance} role="PRIMARY RESISTANCE" />
          </tbody>
        </table>
      </div>
      {levels.unavailable.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {levels.unavailable.map((u) => (
            <li key={u} className="text-[11px] text-amber-300/80">• {u}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {snapshot.zones.slice(0, 9).map((z) => (
          <ZoneCard key={z.id} zone={z} />
        ))}
      </div>
    </Panel>
  );
}

export function ZoneCard({ zone }: { zone: Zone }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="panel-flat p-3">
      <button className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setOpen((v) => !v)}>
        <span className="mono text-[12px] font-semibold text-slate-100">
          {zone.kind === "support" ? "SUPPORT" : "RESISTANCE"} {fmt(zone.lower)}–{fmt(zone.upper)}
        </span>
        <span className="flex items-center gap-2">
          <ScoreBar score={zone.score} />
          <span className={`text-[10px] font-semibold ${TONE_CLASS[statusTone(zone.status)]}`}>{zone.status.replace("_", " ")}</span>
        </span>
      </button>
      {open ? <ZoneDetailInline zone={zone} /> : null}
    </div>
  );
}

function ZoneDetailInline({ zone }: { zone: Zone }) {
  const [history, setHistory] = useState<Array<{ t: string; score: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/zones/${encodeURIComponent(zone.id)}`, { cache: "no-store" });
        const json = (await res.json()) as { ok: boolean; zone?: { scoreHistory: Array<{ t: string; score: number }> } };
        if (!cancelled) {
          if (json.ok && json.zone) setHistory(json.zone.scoreHistory);
          else setError("No persisted history for this zone yet.");
        }
      } catch {
        if (!cancelled) setError("Zone history unavailable.");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [zone.id]);

  return (
    <div className="mt-3 space-y-2 text-[11px] text-slate-400">
      <div className="grid grid-cols-2 gap-2">
        <Metric label="Created" value={fmtDateTime(new Date(zone.createdAt).toISOString())} mono={false} />
        <Metric label="Tests" value={zone.tests} />
        <Metric label="OI-only provenance" value={zone.oiOnly ? "YES — OI-derived, not structural" : "No"} mono={false} />
        <Metric label="Width" value={`${fmt(zone.width)} (${zone.widthPct.toFixed(2)}%)`} />
      </div>
      <div>
        <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">Source reactions</div>
        <ul className="mt-1 space-y-0.5">
          {zone.sources.slice(0, 8).map((s, i) => (
            <li key={i} className="whitespace-normal">
              • <span className="text-slate-300">{s.kind}</span> @ {fmt(s.price)} [{s.timeframe}] — {s.note}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">Evidence components</div>
        <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
          {Object.entries(zone.evidence.components).map(([k, v]) => (
            <li key={k} className="mono">
              {k}: {v === null ? <span className="text-slate-600">unavailable</span> : `${Math.round(v * 100)}%`}
            </li>
          ))}
        </ul>
        {zone.evidence.contradictory.length > 0 ? (
          <ul className="mt-1 space-y-0.5 text-amber-300/80">
            {zone.evidence.contradictory.map((c, i) => (
              <li key={i}>⚠ {c}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <div>
        <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">Strength history</div>
        {error ? <div className="mt-1 text-slate-600">{error}</div> : null}
        {history && history.length > 0 ? (
          <div className="mt-1 flex h-10 items-end gap-[2px]">
            {history.slice(-40).map((h, i) => (
              <div key={i} className="w-1 rounded-t bg-sky-500/70" style={{ height: `${Math.max(6, h.score)}%` }} title={`${fmtTime(h.t)} → ${h.score}`} />
            ))}
          </div>
        ) : null}
      </div>
      <div className="text-[10px] text-slate-500">
        Invalidation: two consecutive closes beyond {zone.lower}–{zone.upper}, or sustained acceptance outside the zone with follow-through.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Market structure
 * ------------------------------------------------------------------ */

export function StructurePanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  const s = snapshot.structure;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Panel title="Market Structure" subtitle="Confirmed fractal pivots only (right-side bars required) — no look-ahead bias." status={s.status}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Metric label="Primary TF trend" value={s.trend} tone={s.trend === "BULLISH" ? "green" : s.trend === "BEARISH" ? "red" : "muted"} />
          <Metric label={`HTF trend (${snapshot.timeframe === "1m" ? "15m" : "30m"})`} value={s.htfTrend} />
          <Metric label="Swing highs" value={s.highs.label} tone={s.highs.label === "HH" ? "green" : s.highs.label === "LH" ? "red" : "muted"} />
          <Metric label="Swing lows" value={s.lows.label} tone={s.lows.label === "HL" ? "green" : s.lows.label === "LL" ? "red" : "muted"} />
          <Metric label="Structure bias" value={s.structureBiasScore ?? "n/a"} />
          <Metric label="Last swing high" value={fmt(s.lastHigh)} />
          <Metric label="Last swing low" value={fmt(s.lastLow)} />
          <Metric label="Session H/L" value={`${fmt(s.rangeLow)} / ${fmt(s.rangeHigh)}`} />
        </div>
        <ul className="mt-3 space-y-1 text-[11px] text-slate-400">
          {s.explanation.map((e, i) => (
            <li key={i}>• {e}</li>
          ))}
        </ul>
        <div className="mt-3 max-h-56 overflow-y-auto scroll-thin">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Event</Th>
                <Th>Direction</Th>
                <Th>Level</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {s.events.map((e, i) => (
                <tr key={i}>
                  <Td tone="mono">{fmtTime(new Date(e.ts).toISOString())}</Td>
                  <Td tone="text-slate-200">{e.type}</Td>
                  <Td tone={e.direction === "BULLISH" ? "text-emerald-400" : "text-rose-400"}>{e.direction}</Td>
                  <Td tone="mono">{fmt(e.level)}</Td>
                  <Td tone="text-slate-400">{e.detail}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel
        title="Volume Profile"
        subtitle="Derived from traded volume where available. Index spot has no traded volume — when derived from another series it is labelled ESTIMATED, never presented as true footprint data."
        status={snapshot.volumeProfile.status}
      >
        {snapshot.volumeProfile.status === "UNAVAILABLE" ? (
          <Unavailable reason={snapshot.volumeProfile.message} />
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Metric label="POC" value={fmt(snapshot.volumeProfile.poc)} tone="blue" />
            <Metric label="Developing POC" value={fmt(snapshot.volumeProfile.developingPoc)} />
            <Metric label="VAH" value={fmt(snapshot.volumeProfile.vah)} />
            <Metric label="VAL" value={fmt(snapshot.volumeProfile.val)} />
            <Metric label="Concentration" value={snapshot.volumeProfile.concentration === null ? "n/a" : `${snapshot.volumeProfile.concentration}%`} />
            <Metric label="Migration" value={snapshot.volumeProfile.migration ?? "n/a"} />
          </div>
        )}
        <div className="mt-3">
          <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">Session references</div>
          <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
            <Metric label="Prev day high" value={fmt(snapshot.sessionLevels.prevDayHigh)} />
            <Metric label="Prev day low" value={fmt(snapshot.sessionLevels.prevDayLow)} />
            <Metric label="Prev close" value={fmt(snapshot.sessionLevels.prevClose)} />
            <Metric label="Prev week H/L" value={`${fmt(snapshot.sessionLevels.prevWeekLow)} / ${fmt(snapshot.sessionLevels.prevWeekHigh)}`} />
            <Metric label="Opening range H" value={fmt(snapshot.sessionLevels.openingRangeHigh)} />
            <Metric label="Opening range L" value={fmt(snapshot.sessionLevels.openingRangeLow)} />
            <Metric label="Session high" value={fmt(snapshot.sessionLevels.sessionHigh)} />
            <Metric label="Session low" value={fmt(snapshot.sessionLevels.sessionLow)} />
            <Metric
              label="VWAP"
              value={snapshot.sessionLevels.vwap === null ? "UNAVAILABLE" : fmt(snapshot.sessionLevels.vwap)}
              hint={snapshot.sessionLevels.vwapStatus === "ESTIMATED" ? "ESTIMATED (OHLCV-derived)" : undefined}
            />
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Futures intelligence
 * ------------------------------------------------------------------ */

export function FuturesPanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  const f = snapshot.futures;
  return (
    <Panel
      title="Futures Positioning Intelligence"
      subtitle="Price/OI/volume interaction read from the resolved index futures contract. Participant identity is never inferred from aggregate OI."
      status={f.status}
    >
      <ModuleGate snapshot={snapshot} module="FUTURES">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        <Metric label="Contract" value={f.tradingSymbol ?? "UNAVAILABLE"} mono={false} />
        <Metric label="Expiry" value={f.expiry ?? "n/a"} />
        <Metric label="LTP" value={fmt(f.ltp)} />
        <Metric label="Spot" value={fmt(f.spot)} />
        <Metric label="Basis" value={f.basis === null ? "n/a" : fmt(f.basis)} tone={f.basis !== null && f.basis > 0 ? "green" : "red"} hint={f.basisPct === null ? undefined : `${f.basisPct}%`} />
        <Metric label="Classification" value={f.classification.replace(/_/g, " ")} tone={f.classification.includes("LONG_BUILDUP") || f.classification.includes("SHORT_COVERING") ? "green" : f.classification.includes("SHORT") || f.classification.includes("UNWINDING") ? "red" : "muted"} />
        <Metric label="OI" value={fmtCompact(f.oi)} />
        <Metric label="Δ OI (vs ref)" value={f.changeInOi === null ? "n/a" : fmtCompact(f.changeInOi)} />
        <Metric label="Δ OI %" value={f.changeInOiPct === null ? "n/a" : `${f.changeInOiPct}%`} />
        <Metric label="Volume" value={fmtCompact(f.volume)} />
        <Metric label="Volume Δ" value={f.volumeChange === null ? "n/a" : fmtCompact(f.volumeChange)} />
        <Metric label="Lot size" value={f.lotSize ?? "n/a"} />
      </div>
      <ul className="mt-3 space-y-1 text-[11px] text-slate-400">
        {f.interpretation.map((t, i) => (
          <li key={i}>• {t}</li>
        ))}
      </ul>
      <FuturesReadiness snapshot={snapshot} />
      </ModuleGate>
    </Panel>
  );
}

function FuturesReadiness({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  const df = foundationFor(snapshot);
  const pos = df?.modules.find((x) => x.module === "FUTURES_POSITIONING");
  if (!pos || pos.state === "READY") return null;
  return (
    <div className="mt-3 rounded border border-sky-800/50 bg-sky-500/5 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded border border-sky-600 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-sky-300">
          {pos.state.replace(/_/g, " ")}
        </span>
        <span className="text-[11px] font-semibold text-sky-300">Futures positioning</span>
      </div>
      <div className="mt-1 text-[11px] text-slate-400">{pos.reason}</div>
      {pos.action ? <div className="mt-1 text-[11px] text-amber-300">Next: {pos.action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * OI intelligence
 * ------------------------------------------------------------------ */

export function OiPanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  const oi = snapshot.optionChain.oi;
  return (
    <Panel
      title="OI Intelligence"
      subtitle="Rolling 5m / 15m changes come from persisted OI snapshots in PostgreSQL; session-cumulative change uses the session baseline snapshot. Current total OI is never conflated with OI change."
      status={oi.status}
    >
      <ModuleGate snapshot={snapshot} module="OI_INTELLIGENCE">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        <Metric label="Total CE OI" value={fmtCompact(oi.totalCeOi)} />
        <Metric label="Total PE OI" value={fmtCompact(oi.totalPeOi)} />
        <Metric label="Combined OI" value={fmtCompact(oi.combinedOi)} />
        <Metric label="PCR" value={oi.pcr === null ? "n/a" : oi.pcr} hint={oi.pcrBasis} />
        <Metric label="CE 5m ΔOI" value={oi.ce5mChange === null ? "n/a" : fmtCompact(oi.ce5mChange)} tone={(oi.ce5mChange ?? 0) > 0 ? "green" : "red"} />
        <Metric label="PE 5m ΔOI" value={oi.pe5mChange === null ? "n/a" : fmtCompact(oi.pe5mChange)} tone={(oi.pe5mChange ?? 0) > 0 ? "green" : "red"} />
        <Metric label="CE 15m ΔOI" value={oi.ce15mChange === null ? "n/a" : fmtCompact(oi.ce15mChange)} />
        <Metric label="PE 15m ΔOI" value={oi.pe15mChange === null ? "n/a" : fmtCompact(oi.pe15mChange)} />
        <Metric label="CE session ΔOI" value={oi.ceSessionChange === null ? "n/a" : fmtCompact(oi.ceSessionChange)} />
        <Metric label="PE session ΔOI" value={oi.peSessionChange === null ? "n/a" : fmtCompact(oi.peSessionChange)} />
        <Metric label="Snapshots stored" value={oi.snapshotCount} />
        <Metric label="Baseline captured" value={fmtDateTime(oi.baselineAt)} mono={false} />
      </div>
      <ul className="mt-3 space-y-1 text-[11px] text-slate-400">
        {oi.interpretation.map((t, i) => (
          <li key={i}>• {t}</li>
        ))}
      </ul>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">OI concentration by strike (top 8)</div>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Strike</Th>
                <Th>Side</Th>
                <Th align="right">OI</Th>
                <Th align="right">Share</Th>
                <Th>Reading</Th>
              </tr>
            </thead>
            <tbody>
              {oi.oiClusters.map((c, i) => (
                <tr key={i}>
                  <Td tone="mono">{fmt(c.strike, 0)}</Td>
                  <Td tone={c.side === "CE" ? "text-rose-300" : "text-emerald-300"}>{c.side}</Td>
                  <Td align="right" tone="mono">{fmtCompact(c.oi)}</Td>
                  <Td align="right" tone="mono">{(c.share * 100).toFixed(1)}%</Td>
                  <Td tone="text-slate-400">{c.kind}</Td>
                </tr>
              ))}
              {oi.oiClusters.length === 0 ? (
                <tr>
                  <Td tone="text-slate-500">UNAVAILABLE</Td>
                  <Td>-</Td>
                  <Td>-</Td>
                  <Td>-</Td>
                  <Td>-</Td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Significant 5m OI additions / reductions</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] text-emerald-400">Additions</div>
              <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
                {oi.additions.map((a, i) => (
                  <li key={i} className="mono">{a.side} {fmt(a.strike, 0)} → +{fmtCompact(a.change)} ({a.window})</li>
                ))}
                {oi.additions.length === 0 ? <li className="text-slate-600">None detected in this window.</li> : null}
              </ul>
            </div>
            <div>
              <div className="text-[10px] text-rose-400">Reductions</div>
              <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
                {oi.reductions.map((a, i) => (
                  <li key={i} className="mono">{a.side} {fmt(a.strike, 0)} → {fmtCompact(a.change)} ({a.window})</li>
                ))}
                {oi.reductions.length === 0 ? <li className="text-slate-600">None detected in this window.</li> : null}
              </ul>
            </div>
          </div>
        </div>
      </div>
      </ModuleGate>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Greeks dashboard
 * ------------------------------------------------------------------ */

export function GreeksPanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  const g = snapshot.greeks;
  const any = g.distribution.some((d) => d.ceDelta !== null || d.peDelta !== null);
  return (
    <Panel
      title="Options Greeks Intelligence"
      subtitle={g.message}
      status={g.status}
      right={<StatusBadge status={g.source === "UPSTOX" ? "LIVE" : "UNAVAILABLE"} />}
    >
      <ModuleGate snapshot={snapshot} module="GREEKS">
      {!any ? (
        <div className="rounded-lg border border-amber-800/50 bg-amber-500/5 px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status="PARTIAL" />
            <span className="text-[12px] font-semibold text-amber-300">GREEKS UNAVAILABLE — option data is still shown</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400">{g.message}</div>
          <div className="mt-2 text-[11px] text-slate-500">
            Upstox returned valid chain rows for {snapshot.optionChain.strikes.length} strike(s) carrying LTP, OI, volume and bid/ask. That data is shown on the
            Option Chain tab. No delta/gamma/theta/vega/IV was present in the <span className="mono">option_greeks</span> object, so nothing is estimated here.
          </div>
        </div>
      ) : (
        <div className="swipe-hint overflow-x-auto scroll-thin">
          <table className="w-full min-w-[900px] border-collapse">
            <thead>
              <tr>
                <Th>Strike</Th>
                <Th align="right">CE Δ</Th>
                <Th align="right">CE Γ</Th>
                <Th align="right">CE Θ</Th>
                <Th align="right">CE Vega</Th>
                <Th align="right">CE IV</Th>
                <Th align="right">PE Δ</Th>
                <Th align="right">PE Γ</Th>
                <Th align="right">PE Θ</Th>
                <Th align="right">PE Vega</Th>
                <Th align="right">PE IV</Th>
              </tr>
            </thead>
            <tbody>
              {g.distribution.map((d) => (
                <tr key={d.strike}>
                  <Td tone="mono font-semibold">{fmt(d.strike, 0)}</Td>
                  <Td align="right" tone="mono">{fmt(d.ceDelta, 4)}</Td>
                  <Td align="right" tone="mono">{fmt(d.ceGamma, 5)}</Td>
                  <Td align="right" tone="mono">{fmt(d.ceTheta, 3)}</Td>
                  <Td align="right" tone="mono">{fmt(d.ceVega, 4)}</Td>
                  <Td align="right" tone="mono">{fmt(d.ceIv, 2)}</Td>
                  <Td align="right" tone="mono">{fmt(d.peDelta, 4)}</Td>
                  <Td align="right" tone="mono">{fmt(d.peGamma, 5)}</Td>
                  <Td align="right" tone="mono">{fmt(d.peTheta, 3)}</Td>
                  <Td align="right" tone="mono">{fmt(d.peVega, 4)}</Td>
                  <Td align="right" tone="mono">{fmt(d.peIv, 2)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </ModuleGate>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Strike momentum
 * ------------------------------------------------------------------ */

function CandidateTable({ rows, side }: { rows: AnalysisSnapshot["strikeMomentum"]["ceRanked"]; side: "CE" | "PE" }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <Th>Rank</Th>
          <Th>Strike</Th>
          <Th>Type</Th>
          <Th align="right">Score</Th>
          <Th align="right">Coverage</Th>
          <Th align="right">Premium Δ%</Th>
          <Th align="right">Rel. volume</Th>
          <Th align="right">OI Δ (5m)</Th>
          <Th align="right">Δ</Th>
          <Th align="right">Θ</Th>
          <Th align="right">IV</Th>
          <Th align="right">Spread %</Th>
          <Th>Participation read</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c, i) => (
          <tr key={`${c.optionType}-${c.strike}`}>
            <Td tone="mono">{i + 1}</Td>
            <Td tone="mono font-semibold">{fmt(c.strike, 0)}</Td>
            <Td tone={side === "CE" ? "text-rose-300" : "text-emerald-300"}>{c.classification}</Td>
            <Td align="right" tone="mono">{c.suitabilityScore ?? "n/a"}</Td>
            <Td align="right" tone="mono">{Math.round(c.coverage * 100)}%</Td>
            <Td align="right" tone="mono">{fmt(c.leg.premiumChangePct)}%</Td>
            <Td align="right" tone="mono">{fmt(c.leg.relativeVolume)}x</Td>
            <Td align="right" tone="mono">{c.leg.changeInOi === null ? "n/a" : fmtCompact(c.leg.changeInOi)}</Td>
            <Td align="right" tone="mono">{fmt(c.leg.delta, 3)}</Td>
            <Td align="right" tone="mono">{fmt(c.leg.theta, 2)}</Td>
            <Td align="right" tone="mono">{fmt(c.leg.iv, 2)}</Td>
            <Td align="right" tone="mono">{fmt(c.leg.spreadPct)}%</Td>
            <Td tone="text-slate-400">{c.leg.participationRead}</Td>
          </tr>
        ))}
        {rows.length === 0 ? (
          <tr>
            <Td tone="text-slate-500">UNAVAILABLE</Td>
            <Td>-</Td>
            <Td>-</Td>
            <Td>-</Td>
            <Td>-</Td>
            <Td>-</Td>
            <Td>-</Td>
            <Td>-</Td>
            <Td>-</Td>
            <Td>-</Td>
            <Td>-</Td>
            <Td>-</Td>
            <Td>-</Td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

export function StrikeMomentumPanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  return (
    <Panel title="Strike-wise Momentum" subtitle={snapshot.strikeMomentum.message} status={snapshot.strikeMomentum.status}>
      <ModuleGate snapshot={snapshot} module="STRIKE_MOMENTUM">
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-rose-300">CALL side ranking</div>
          <CandidateTable rows={snapshot.strikeMomentum.ceRanked} side="CE" />
        </div>
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300">PUT side ranking</div>
          <CandidateTable rows={snapshot.strikeMomentum.peRanked} side="PE" />
        </div>
      </div>
      </ModuleGate>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Best strike finder
 * ------------------------------------------------------------------ */

function CandidateCard({ title, c }: { title: string; c: AnalysisSnapshot["selection"]["bestCall"] }) {
  if (!c) {
    return (
      <div className="panel-flat p-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{title}</div>
        <div className="mt-2"><Unavailable reason="No contract cleared the liquidity / spread gates — no strike recommended." /></div>
      </div>
    );
  }
  return (
    <div className="panel-flat p-3">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{title}</div>
        <ScoreBar score={c.suitabilityScore} />
      </div>
      <div className="mono mt-2 text-[16px] font-semibold text-slate-100">
        {fmt(c.strike, 0)} {c.optionType} <span className="text-[11px] text-slate-500">({c.classification}, {fmt(c.atmDistance, 0)} from spot)</span>
      </div>
      <div className="mono text-[11px] text-slate-400">{c.leg.tradingSymbol ?? c.leg.instrumentKey ?? "symbol unavailable"}</div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        <Metric label="Premium" value={fmt(c.leg.ltp)} />
        <Metric label="Bid / Ask" value={`${fmt(c.leg.bidPrice)} / ${fmt(c.leg.askPrice)}`} />
        <Metric label="Spread %" value={fmt(c.leg.spreadPct)} />
        <Metric label="Delta" value={fmt(c.leg.delta, 3)} />
        <Metric label="Gamma" value={fmt(c.leg.gamma, 5)} />
        <Metric label="Theta" value={fmt(c.leg.theta, 2)} />
        <Metric label="Vega" value={fmt(c.leg.vega, 3)} />
        <Metric label="IV" value={fmt(c.leg.iv, 2)} />
        <Metric label="Volume" value={fmtCompact(c.leg.volume)} />
        <Metric label="Rel. volume" value={fmt(c.leg.relativeVolume)} />
        <Metric label="OI" value={fmtCompact(c.leg.oi)} />
        <Metric label="OI Δ 5m" value={c.leg.changeInOi === null ? "n/a" : fmtCompact(c.leg.changeInOi)} />
      </div>
      <div className="mt-3 space-y-1">
        <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-emerald-400">Why selected</div>
        <ul className="space-y-0.5 text-[11px] text-slate-400">
          {c.reasons.map((r, i) => (
            <li key={i}>• {r}</li>
          ))}
        </ul>
      </div>
      {c.risks.length > 0 ? (
        <div className="mt-2 space-y-1">
          <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-amber-400">Risks</div>
          <ul className="space-y-0.5 text-[11px] text-slate-400">
            {c.risks.map((r, i) => (
              <li key={i}>⚠ {r}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {c.rejections.length > 0 ? (
        <div className="mt-2 space-y-1">
          <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-rose-400">Why alternatives rejected</div>
          <ul className="space-y-0.5 text-[11px] text-slate-400">
            {c.rejections.map((r, i) => (
              <li key={i}>• {r}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function StrikeFinderPanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  const s = snapshot.selection;
  return (
    <Panel
      title="Best ATM / ITM / OTM Strike Finder"
      subtitle="ATM is derived from actually listed strikes — strike intervals are never hardcoded. ATM, ITM and OTM legs are compared on delta suitability, premium momentum, liquidity, spread, OI, gamma, theta cost and IV."
      status={s.status}
    >
      <ModuleGate snapshot={snapshot} module="BEST_STRIKE_FINDER">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Metric label="Spot" value={fmt(s.spot)} />
        <Metric label="ATM strike" value={s.atmStrike === null ? "n/a" : fmt(s.atmStrike, 0)} />
        <Metric label="Expiry" value={s.expiry ?? "n/a"} />
        <Metric label="Chain spot" value={fmt(snapshot.optionChain.spot)} />
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <CandidateCard title="Best CALL BUY candidate" c={s.bestCall} />
        <CandidateCard title="Best PUT BUY candidate" c={s.bestPut} />
      </div>
      <ul className="mt-3 space-y-1 text-[11px] text-slate-400">
        {s.rationale.map((r, i) => (
          <li key={i}>• {r}</li>
        ))}
      </ul>
      </ModuleGate>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Trade finder
 * ------------------------------------------------------------------ */

export function TradeFinderPanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  const t = snapshot.trade;
  const isNoTrade = t.action === "NO_TRADE";
  return (
    <Panel
      title={`Best Option Trade Finder — ${snapshot.symbol}`}
      subtitle="Spot market structure determines the bias; the option chain and Greeks validate momentum and select the contract. NO TRADE is preferred over a forced recommendation."
      status={t.status}
    >
      <ModuleGate snapshot={snapshot} module="TRADE_FINDER">
      <div className={`rounded-lg border px-4 py-3 ${isNoTrade ? "border-slate-700 bg-slate-900/40" : t.action === "CALL_BUY" ? "border-emerald-700/50 bg-emerald-500/5 glow-green" : "border-rose-700/50 bg-rose-500/5 glow-red"}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Recommendation</div>
            <div className="mono mt-1 text-[20px] font-bold text-slate-100">{t.headline}</div>
            <div className="mono text-[11px] text-slate-400">
              {t.contract?.leg.tradingSymbol ?? t.contract?.leg.instrumentKey ?? "—"}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Metric label="Setup score" value={t.setupScore ?? "n/a"} tone={(t.setupScore ?? 0) >= 62 ? "green" : "amber"} hint={`coverage ${Math.round(t.setupCoverage * 100)}%`} />
            <Metric label="Suitability" value={t.contract?.suitabilityScore ?? "n/a"} tone={(t.contract?.suitabilityScore ?? 0) >= 60 ? "green" : "amber"} hint={t.contract ? `coverage ${Math.round(t.contract.coverage * 100)}%` : undefined} />
            <Metric label="Spot" value={fmt(snapshot.spot.ltp)} />
            <Metric label="Premium" value={fmt(t.premium)} />
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        <Metric label="Entry trigger" value={t.entryTrigger} mono={false} />
        <Metric label="Entry range" value={t.entryLow === null ? "n/a" : `${fmt(t.entryLow)} – ${fmt(t.entryHigh)}`} />
        <Metric label="Entry state" value={t.entryState.replace("_", " ")} tone={t.entryState === "READY" ? "green" : t.entryState === "NOT_APPLICABLE" ? "muted" : "amber"} />
        <Metric label="Underlying stop" value={t.stopLoss === null ? "n/a" : fmt(t.stopLoss)} tone="red" />
        <Metric label="Target 1" value={t.target1 === null ? "n/a" : fmt(t.target1)} tone="green" />
        <Metric label="Target 2" value={t.target2 === null ? "n/a" : fmt(t.target2)} tone="green" />
        <Metric label="Risk / reward" value={t.riskReward === null ? "n/a" : `1 : ${t.riskReward}`} />
        <Metric label="Direction" value={t.direction.toUpperCase()} tone={t.direction === "bullish" ? "green" : t.direction === "bearish" ? "red" : "muted"} />
        <Metric label="Strike" value={t.contract ? fmt(t.contract.strike, 0) : "n/a"} />
        <Metric label="Option type" value={t.contract?.optionType ?? "n/a"} />
        <Metric label="ATM distance" value={t.contract ? fmt(t.contract.atmDistance, 0) : "n/a"} />
        <Metric label="Spread %" value={fmt(t.contract?.leg.spreadPct ?? null)} />
      </div>

      <div className="mt-3 text-[11px] text-slate-400">{t.stopBasis}</div>
      <div className="mt-1 text-[11px] text-slate-400">{t.targetBasis}</div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-400">Conditions met</div>
          <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
            {t.conditionsMet.map((c, i) => (
              <li key={i}>✓ {c}</li>
            ))}
            {t.conditionsMet.length === 0 ? <li className="text-slate-600">None satisfied.</li> : null}
          </ul>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-rose-400">Conditions failed</div>
          <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
            {t.conditionsFailed.map((c, i) => (
              <li key={i}>✗ {c}</li>
            ))}
          </ul>
        </div>
      </div>

      {isNoTrade && t.noTradeReasons.length > 0 ? (
        <div className="mt-4 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">NO TRADE reasons</div>
          <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
            {t.noTradeReasons.map((r, i) => (
              <li key={i}>• {r}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Setup score components</div>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {Object.entries(t.setupComponents).map(([k, v]) => (
            <Metric key={k} label={k.replace(/([A-Z])/g, " $1").toUpperCase()} value={v === null ? "n/a" : `${Math.round(v)}`} />
          ))}
        </div>
      </div>

      <div className="mt-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Invalidation</div>
        <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
          {t.invalidation.map((c, i) => (
            <li key={i}>• {c}</li>
          ))}
        </ul>
      </div>
      <div className="mt-3 text-[10px] text-slate-600">Last updated {fmtDateTime(t.updatedAt)} · intelligence only, no automatic order placement.</div>
      </ModuleGate>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

export function ScenarioPanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {snapshot.scenarios.map((s) => (
        <Panel key={s.name} title={`${s.name} SCENARIO`} status={s.likelihoodScore === null ? "UNAVAILABLE" : "LIVE"}>
          <div className="flex items-center gap-3">
            <ScoreBar score={s.likelihoodScore} label={s.likelihoodScore === null ? "n/a" : `${s.likelihoodScore}`} />
            <span className="text-[10px] text-slate-500">coverage {Math.round(s.coverage * 100)}%</span>
          </div>
          <div className="mt-3">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">Conditions</div>
            <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
              {s.conditions.map((c, i) => (
                <li key={i}>• {c}</li>
              ))}
            </ul>
          </div>
          <div className="mt-2">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-emerald-400">Supporting</div>
            <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
              {s.supporting.map((c, i) => (
                <li key={i}>+ {c}</li>
              ))}
              {s.supporting.length === 0 ? <li className="text-slate-600">None currently.</li> : null}
            </ul>
          </div>
          <div className="mt-2">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-rose-400">Contradictory</div>
            <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
              {s.contradictory.map((c, i) => (
                <li key={i}>− {c}</li>
              ))}
              {s.contradictory.length === 0 ? <li className="text-slate-600">None detected.</li> : null}
            </ul>
          </div>
          <div className="mt-2 text-[11px] text-slate-300">Trigger: {s.trigger}</div>
          <div className="mt-1 text-[11px] text-slate-400">Invalidation: {s.invalidation}</div>
          <ul className="mt-2 space-y-0.5 text-[10px] text-slate-500">
            {s.zones.map((z, i) => (
              <li key={i}>▣ {z}</li>
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Data quality
 * ------------------------------------------------------------------ */

export function DataQualityPanel({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  const dq = snapshot.dataQuality;
  return (
    <Panel
      title="Data Quality & Reliability"
      subtitle="Every module reports LIVE / PARTIAL / STALE / UNAVAILABLE / INVALID / DISCONNECTED. Stale data is never silently treated as live, and missing data never becomes positive evidence."
      status={dq.overall}
    >
      <div className="swipe-hint overflow-x-auto scroll-thin">
        <table className="w-full min-w-[820px] border-collapse">
          <thead>
            <tr>
              <Th>Module</Th>
              <Th>Status</Th>
              <Th>Message</Th>
              <Th>Source ts</Th>
              <Th>Received</Th>
              <Th align="right">Freshness</Th>
            </tr>
          </thead>
          <tbody>
            {dq.entries.map((e) => (
              <tr key={e.module}>
                <Td className="font-semibold text-slate-200">{e.module}</Td>
                <Td><StatusBadge status={e.status} /></Td>
                <Td tone="text-slate-400">{e.message}</Td>
                <Td tone="mono">{fmtDateTime(e.sourceTs)}</Td>
                <Td tone="mono">{fmtDateTime(e.receivedAt)}</Td>
                <Td align="right" tone="mono">{e.freshnessMs === null ? "n/a" : `${(e.freshnessMs / 1000).toFixed(1)}s`}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-3 space-y-1 text-[11px] text-slate-500">
        {snapshot.notes.map((n, i) => (
          <li key={i}>• {n}</li>
        ))}
      </ul>
    </Panel>
  );
}
