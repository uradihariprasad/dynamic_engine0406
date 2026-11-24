"use client";

import { useMemo, useState } from "react";
import { SCAN_INTERVAL_MS, useAnalysis } from "@/components/useAnalysis";
import { SessionProvider, useSessionContext } from "@/components/session-context";
import {
  AlertsView,
  DashboardView,
  DocsView,
  ReplayView,
  SettingsView,
  SymbolView,
} from "@/components/views";
import {
  DataQualityPanel,
  FuturesPanel,
  GreeksPanel,
  OiPanel,
  ScenarioPanel,
  SrPanel,
  StrikeFinderPanel,
  StrikeMomentumPanel,
  StructurePanel,
  TradeFinderPanel,
} from "@/components/panels";
import { OptionChainTable } from "@/components/OptionChainTable";
import { DiagnosticsView } from "@/components/DiagnosticsView";
import { DataFoundationPanel, ReadinessStrip } from "@/components/DataFoundation";
import { GreeksIntelligencePanel } from "@/components/GreeksIntelligence";
import { OiChangePanel } from "@/components/OiChangePanel";
import { StatusBadge, Unavailable, fmt, fmtTime } from "@/components/ui";
import { TokenEntry } from "@/components/TokenEntry";
import type { AnalysisSnapshot } from "@/lib/engine/types";

const TABS = [
  "Dashboard",
  "NIFTY",
  "SENSEX",
  "Market Structure",
  "Dynamic S/R",
  "Futures Intelligence",
  "Option Chain",
  "OI Intelligence",
  "Change in OI",
  "Options Greeks",
  "Greeks Intelligence",
  "Strike Momentum",
  "Best Strike Finder",
  "Trade Finder",
  "Historical Replay",
  "Alerts",
  "Settings",
  "Diagnostics",
  "Data Foundation",
  "Docs",
] as const;

type Tab = (typeof TABS)[number];
const TIMEFRAMES = ["1m", "2m", "5m", "15m", "30m", "1h"] as const;

export default function HomePage() {
  return (
    <SessionProvider>
      <Terminal />
    </SessionProvider>
  );
}

function Terminal() {
  const [tab, setTab] = useState<Tab>("Dashboard");
  const [symbol, setSymbol] = useState<"NIFTY" | "SENSEX">("NIFTY");
  const [timeframe, setTimeframe] = useState<string>("5m");
  const [navOpen, setNavOpen] = useState(false);

  const session = useSessionContext();
  const { snapshots, errors, loading, lastRefresh, scanNow, setAutoScan, scan } = useAnalysis(
    ["NIFTY", "SENSEX"],
    timeframe,
    session.version,
  );
  const connected = session.state.connected && session.state.session.active;

  const snapshot = snapshots[symbol] ?? null;
  const nifty = snapshots.NIFTY ?? null;
  const sensex = snapshots.SENSEX ?? null;

  const headerTone = useMemo(() => {
    const s = snapshot?.spot;
    if (!s) return "text-slate-400";
    if ((s.change ?? 0) > 0) return "text-emerald-400";
    if ((s.change ?? 0) < 0) return "text-rose-400";
    return "text-slate-300";
  }, [snapshot]);

  const needsSymbol = ["Market Structure", "Dynamic S/R", "Futures Intelligence", "Option Chain", "OI Intelligence", "Change in OI", "Options Greeks", "Greeks Intelligence", "Strike Momentum", "Best Strike Finder", "Trade Finder"].includes(tab);

  return (
    <div className="min-h-screen bg-[#070a12] text-slate-200">
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-[#070a12]/95 backdrop-blur">
        {/* Row 1 — scan button top-left, brand, tickers, connection status */}
        <div className="mx-auto flex max-w-[1800px] items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4 sm:py-3">
          {/* SCAN button — top-left, always visible on every screen size */}
          <button
            onClick={() => void scanNow()}
            disabled={scan.scanning}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-sky-600 px-2.5 py-2 text-[11px] font-bold uppercase tracking-wider text-white transition active:bg-sky-700 disabled:opacity-60 sm:px-3"
            title={`Scan now${scan.autoScan ? ` — auto-scan every ${Math.round(SCAN_INTERVAL_MS / 1000)}s` : " — auto-scan off"}`}
            aria-label="Scan now"
          >
            <span className={scan.scanning ? "inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" : "text-[13px] leading-none"}>
              {scan.scanning ? "" : "⟳"}
            </span>
            <span className="hidden xs:inline sm:inline">
              {scan.scanning ? (scan.elapsedSeconds > 0 ? `SCANNING ${scan.elapsedSeconds}s` : "SCANNING") : "SCAN"}
            </span>
          </button>

          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-violet-600 text-[12px] font-black text-white sm:h-9 sm:w-9 sm:text-[13px]">
              DE
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-[12px] font-bold tracking-[0.12em] text-slate-100 sm:text-[15px] sm:tracking-[0.16em]">DYNAMIC ENGINE</h1>
              <p className="hidden text-[10px] uppercase tracking-[0.14em] text-slate-500 sm:block">Market structure · S/R · Options intelligence</p>
            </div>
          </div>

          {/* Top-right: Upstox access token entry box */}
          <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
            <div className="hidden items-center gap-3 md:flex">
              <TickerChip label="NIFTY 50" snapshot={nifty} />
              <TickerChip label="SENSEX" snapshot={sensex} />
            </div>

            {/* Auto-scan toggle + countdown (desktop) */}
            <button
              onClick={() => setAutoScan(!scan.autoScan)}
              className="hidden items-center gap-1.5 rounded border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-300 lg:flex"
              title={scan.autoScan ? `Auto-scan ON — next in ${scan.secondsUntilNext}s. Click to pause.` : "Auto-scan is paused. Click to resume."}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${scan.autoScan ? "bg-emerald-500 pulse-dot" : "bg-slate-600"}`} />
              <span className="mono">{scan.autoScan ? `AUTO ${scan.secondsUntilNext}s` : "AUTO OFF"}</span>
            </button>

            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="rounded border border-slate-700 bg-slate-900 px-1.5 py-1.5 text-[11px] text-slate-200"
              aria-label="Timeframe"
            >
              {TIMEFRAMES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>

            <button
              onClick={() => setTab(connected ? "Diagnostics" : "Settings")}
              className={`hidden items-center gap-1.5 rounded px-2 py-1.5 lg:flex ${connected ? "bg-emerald-500/10 text-emerald-300" : "text-slate-400"}`}
              title={connected ? "Run Upstox diagnostics" : "Enter your Upstox token in the box to the right"}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full pulse-dot ${connected ? "bg-emerald-500" : session.connection === "CONNECTING" ? "bg-amber-500" : "bg-rose-500"}`} />
              <span className="hidden text-[10px] font-bold uppercase tracking-[0.14em] xl:inline">
                {connected ? "UPSTOX CONNECTED" : session.connection === "CONNECTING" ? "VALIDATING…" : "NO TOKEN"}
              </span>
            </button>

            {/* Upstox access token entry box — top right */}
            <TokenEntry onNavigateToSettings={() => setTab("Settings")} />

            {/* Mobile menu toggle */}
            <button
              onClick={() => setNavOpen((v) => !v)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-700 text-slate-300 xl:hidden"
              aria-label="Toggle navigation"
              aria-expanded={navOpen}
            >
              <span className="text-[16px] leading-none">{navOpen ? "✕" : "☰"}</span>
            </button>
          </div>
        </div>

        {/* Row 2 — mobile ticker strip (visible only on small screens) */}
        <div className="flex items-center gap-2 overflow-x-auto scroll-thin px-3 pb-1 md:hidden">
          <TickerChip label="NIFTY 50" snapshot={nifty} />
          <TickerChip label="SENSEX" snapshot={sensex} />
          <span className="mono shrink-0 text-[10px] text-slate-500">
            {scan.scanning
              ? `scanning ${scan.elapsedSeconds}s…${scan.coldStart ? " (first scan warms caches)" : ""}`
              : scan.autoScan
                ? `auto ${scan.secondsUntilNext}s · ${scan.scanCount} scans`
                : `auto off · ${scan.scanCount} scans`}
          </span>
        </div>

        {/* Row 3 — desktop navigation (always visible on xl+) */}
        <nav className="mx-auto hidden max-w-[1800px] gap-1 overflow-x-auto scroll-thin px-3 pb-2 xl:flex">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-[11px] font-semibold tracking-wide transition ${
                tab === t ? "bg-sky-600/20 text-sky-300 ring-1 ring-sky-600/40" : "text-slate-500 hover:bg-slate-800/60 hover:text-slate-300"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>

        {/* Row 3 (mobile) — collapsible navigation drawer */}
        {navOpen ? (
          <nav className="max-h-[65vh] overflow-y-auto scroll-thin border-t border-slate-800 px-3 pb-3 pt-2 xl:hidden">
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setTab(t);
                    setNavOpen(false);
                  }}
                  className={`rounded-md px-3 py-2.5 text-left text-[12px] font-semibold ${
                    tab === t ? "bg-sky-600/25 text-sky-300 ring-1 ring-sky-600/40" : "bg-slate-900/60 text-slate-400"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-2">
              <button
                onClick={() => void scanNow()}
                disabled={scan.scanning}
                className="rounded bg-sky-600 px-3 py-2 text-[11px] font-bold uppercase text-white disabled:opacity-60"
              >
                {scan.scanning ? "Scanning…" : "Scan now"}
              </button>
              <button
                onClick={() => setAutoScan(!scan.autoScan)}
                className="rounded border border-slate-700 px-3 py-2 text-[11px] font-semibold text-slate-300"
              >
                Auto-scan: {scan.autoScan ? `ON (${Math.round(SCAN_INTERVAL_MS / 1000)}s)` : "OFF"}
              </button>
              {(["NIFTY", "SENSEX"] as const).map((sym) => (
                <button
                  key={sym}
                  onClick={() => setSymbol(sym)}
                  className={`rounded px-3 py-2 text-[11px] font-semibold ${symbol === sym ? "bg-slate-100 text-slate-900" : "bg-slate-800 text-slate-400"}`}
                >
                  {sym}
                </button>
              ))}
              <button
                onClick={() => {
                  setNavOpen(false);
                  setTab("Settings");
                }}
                className="rounded border border-sky-700 px-3 py-2 text-[11px] font-semibold text-sky-300"
              >
                Token settings →
              </button>
            </div>
          </nav>
        ) : null}
      </header>

      <main className="safe-bottom mx-auto max-w-[1800px] space-y-3 px-3 py-3 sm:px-4 sm:py-4">
        {needsSymbol ? (
          <div className="sticky top-[52px] z-20 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-[#070a12]/95 px-2 py-2 backdrop-blur sm:top-[56px] sm:px-3">
            <span className="text-[9px] uppercase tracking-widest text-slate-500 sm:text-[10px]">Instrument</span>
            {(["NIFTY", "SENSEX"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className={`rounded px-3 py-1.5 text-[12px] font-semibold ${
                  symbol === s ? "bg-slate-100 text-slate-900" : "bg-slate-800 text-slate-400"
                }`}
              >
                {s}
              </button>
            ))}
            <span className="mono ml-auto text-[12px] text-slate-500">
              {snapshot?.spot.ltp ? `${fmt(snapshot.spot.ltp)}` : "—"}{" "}
              <span className={headerTone}>{snapshot?.spot.pctChange !== null && snapshot?.spot.pctChange !== undefined ? `${snapshot.spot.pctChange}%` : ""}</span>
            </span>
          </div>
        ) : null}

        {loading && !snapshot ? <StatusBadge status="LOADING" /> : null}
        {tab === "Dashboard" ? <DashboardView snapshot={snapshot} /> : null}
        {tab === "NIFTY" ? <SymbolView snapshot={snapshots.NIFTY ?? null} symbol="NIFTY" /> : null}
        {tab === "SENSEX" ? <SymbolView snapshot={snapshots.SENSEX ?? null} symbol="SENSEX" /> : null}
        {tab === "Market Structure" ? <StructurePanel snapshot={snapshot} /> : null}
        {tab === "Dynamic S/R" ? <SrPanel snapshot={snapshot} /> : null}
        {tab === "Futures Intelligence" ? <FuturesPanel snapshot={snapshot} /> : null}
        {tab === "Option Chain" ? <OptionChainTable snapshot={snapshot} /> : null}
        {tab === "OI Intelligence" ? <OiPanel snapshot={snapshot} /> : null}
        {tab === "Change in OI" ? <OiChangePanel snapshot={snapshot} /> : null}
        {tab === "Options Greeks" ? <GreeksPanel snapshot={snapshot} /> : null}
        {tab === "Greeks Intelligence" ? <GreeksIntelligencePanel snapshot={snapshot} /> : null}
        {tab === "Strike Momentum" ? <StrikeMomentumPanel snapshot={snapshot} /> : null}
        {tab === "Best Strike Finder" ? <StrikeFinderPanel snapshot={snapshot} /> : null}
        {tab === "Trade Finder" ? <TradeFinderPanel snapshot={snapshot} /> : null}
        {tab === "Historical Replay" ? <ReplayView symbol={symbol} timeframe={timeframe} /> : null}
        {tab === "Alerts" ? <AlertsView snapshot={snapshot} /> : null}
        {tab === "Settings" ? <SettingsView /> : null}
        {tab === "Diagnostics" ? <DiagnosticsView symbol={symbol} /> : null}
        {tab === "Data Foundation" ? <DataFoundationPanel snapshot={snapshot} /> : null}
        {tab === "Docs" ? <DocsView /> : null}

        {!loading && snapshot && snapshot.dataFoundation.verdict === "FAILED" ? (
          <div className="rounded-lg border border-rose-700/50 bg-rose-500/5 p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[12px] font-bold uppercase tracking-widest text-rose-300">No market data is being displayed</div>
                <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-slate-400">
                  The engines are running but Upstox returned no usable market data for {symbol}
                  {errors[symbol] ? ` (API error: ${errors[symbol]})` : ""}. Nothing is simulated, so every module reports UNAVAILABLE until the data
                  source responds. Run <em>Diagnostics</em> to see exactly which Upstox call is failing and why.
                </p>
              </div>
              <button
                onClick={() => setTab("Diagnostics")}
                className="rounded bg-rose-600 px-3 py-1.5 text-[11px] font-semibold text-white"
              >
                Run diagnostics
              </button>
            </div>
            <ul className="mt-3 space-y-1 text-[11px] text-slate-500">
              {snapshot.dataQuality.entries
                .filter((e) => e.status !== "LIVE")
                .slice(0, 6)
                .map((e) => (
                  <li key={e.module}>
                    • <span className="mono text-slate-400">{e.module}</span> [{e.status}] {e.message}
                  </li>
                ))}
            </ul>
          </div>
        ) : null}

        {!connected ? (
          <div className="rounded-lg border border-amber-700/40 bg-amber-500/5 p-3 text-[11px] text-amber-300/90">
            <strong className="font-semibold">Live verification pending.</strong> No Upstox access token is connected, so every market-data module reports
            UNAVAILABLE and no trade recommendation is produced. Connect a real token in <em>Settings</em> to enable live analysis. All engines, scoring,
            zone logic and NO TRADE gating are fully implemented and unit-tested offline.
          </div>
        ) : null}
      </main>

      <footer className="safe-bottom mx-auto max-w-[1800px] px-3 pb-6 pt-2 text-[10px] leading-relaxed text-slate-600 sm:px-4">
        DYNAMIC ENGINE provides trade intelligence and recommendations only — it does not place orders. Scores are engineering heuristics, not statistically
        validated probabilities. Missing or stale market data is always surfaced as UNAVAILABLE / STALE / INVALID rather than substituted.
      </footer>
    </div>
  );
}

function TickerChip({ label, snapshot }: { label: string; snapshot: Pick<AnalysisSnapshot, "spot"> | null }) {
  if (!snapshot) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{label}</span>
        <span className="mono text-[14px] text-slate-500">—</span>
        <StatusBadge status="LOADING" small />
      </div>
    );
  }
  const spot = snapshot.spot;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{label}</span>
      <span className="mono text-[14px] font-semibold text-slate-100">{fmt(spot.ltp)}</span>
      <span className={`mono text-[11px] ${(spot.change ?? 0) > 0 ? "text-emerald-400" : (spot.change ?? 0) < 0 ? "text-rose-400" : "text-slate-400"}`}>
        {spot.change === null ? "n/a" : `${spot.change > 0 ? "+" : ""}${fmt(spot.change)} (${spot.pctChange ?? "n/a"}%)`}
      </span>
      <StatusBadge status={spot.status} small />
    </div>
  );
}
