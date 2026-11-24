"use client";

import { useEffect, useState } from "react";
import type { AnalysisSnapshot } from "@/lib/engine/types";
import type { ReplayResult } from "@/lib/engine/replay";
import { PriceChart } from "@/components/PriceChart";
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
import { useSessionContext, type ConnectionState } from "@/components/session-context";
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
} from "@/components/ui";

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

export function DashboardView({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  if (!snapshot) return <Unavailable reason="Awaiting first analysis cycle." />;
  const spot = snapshot.spot;
  const strongestSupport = snapshot.zones.filter((z) => z.kind === "support").sort((a, b) => b.score - a.score)[0] ?? null;
  const strongestResistance = snapshot.zones.filter((z) => z.kind === "resistance").sort((a, b) => b.score - a.score)[0] ?? null;
  return (
    <div className="space-y-3">
      <Panel
        title={`Dashboard — ${snapshot.symbol}`}
        subtitle="Live spot, market structure, active zones and the current evidence-based recommendation."
        status={snapshot.dataQuality.overall}
        right={<StatusBadge status={snapshot.sessionConnected ? "LIVE" : "UNAVAILABLE"} />}
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          <Metric label="LTP" value={fmt(spot.ltp)} tone={spot.change !== null && spot.change > 0 ? "green" : spot.change !== null && spot.change < 0 ? "red" : "neutral"} hint={`${fmt(spot.change)} (${fmt(spot.pctChange)}%)`} />
          <Metric label="Open / Prev close" value={`${fmt(spot.open)} / ${fmt(spot.prevClose)}`} />
          <Metric label="Day high / low" value={`${fmt(spot.high)} / ${fmt(spot.low)}`} />
          <Metric label="Market status" value={snapshot.marketStatus ?? "UNAVAILABLE"} mono={false} />
          <Metric label="Market structure" value={snapshot.structure.trend} tone={snapshot.structure.trend === "BULLISH" ? "green" : snapshot.structure.trend === "BEARISH" ? "red" : "muted"} hint={`HTF ${snapshot.structure.htfTrend}`} />
          <Metric label="Directional bias" value={snapshot.trade.direction.toUpperCase()} tone={snapshot.trade.direction === "bullish" ? "green" : snapshot.trade.direction === "bearish" ? "red" : "muted"} />
          <Metric label="ATR" value={fmt(snapshot.candles.atr.value)} hint={`${snapshot.timeframe} · period ${snapshot.candles.atr.period}`} />
          <Metric label="Candles" value={snapshot.candles.count} hint={`${snapshot.candles.formingCount} forming`} />
          <Metric label="Immediate support" value={snapshot.levels.immediateSupport ? fmt(snapshot.levels.immediateSupport.zone.upper) : "UNAVAILABLE"} tone="green" />
          <Metric label="Immediate resistance" value={snapshot.levels.immediateResistance ? fmt(snapshot.levels.immediateResistance.zone.lower) : "UNAVAILABLE"} tone="red" />
          <Metric label="Data quality" value={snapshot.dataQuality.overall} mono={false} />
          <Metric label="Last update" value={fmtTime(snapshot.generatedAt)} mono={false} />
        </div>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Strongest zones" status={snapshot.candles.status}>
          <div className="space-y-2">
            <ZoneRow zone={strongestSupport} label="Strongest support" />
            <ZoneRow zone={strongestResistance} label="Strongest resistance" />
          </div>
        </Panel>
        <Panel title="Current recommendation" status={snapshot.trade.status}>
          <div className="mono text-[16px] font-bold text-slate-100">{snapshot.trade.headline}</div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            <Metric label="Setup score" value={snapshot.trade.setupScore ?? "n/a"} />
            <Metric label="Suitability" value={snapshot.trade.contract?.suitabilityScore ?? "n/a"} />
            <Metric label="Entry range" value={snapshot.trade.entryLow === null ? "n/a" : `${fmt(snapshot.trade.entryLow)}–${fmt(snapshot.trade.entryHigh)}`} />
            <Metric label="R:R" value={snapshot.trade.riskReward === null ? "n/a" : `1 : ${snapshot.trade.riskReward}`} />
          </div>
          <div className="mt-2 text-[11px] text-slate-400">{snapshot.trade.entryTrigger}</div>
        </Panel>
      </div>

      <PriceChart
        candles={snapshot.chart.candles}
        zones={snapshot.zones}
        levels={snapshot.levels}
        vwap={snapshot.sessionLevels.vwap}
        prevDayHigh={snapshot.sessionLevels.prevDayHigh}
        prevDayLow={snapshot.sessionLevels.prevDayLow}
      />

      <ScenarioPanel snapshot={snapshot} />
      <DataQualityPanel snapshot={snapshot} />
    </div>
  );
}

function ZoneRow({ zone, label }: { zone: AnalysisSnapshot["zones"][number] | null; label: string }) {
  if (!zone) {
    return (
      <div className="panel-flat px-3 py-2">
        <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
        <div className="mt-1 text-[12px] text-slate-500">UNAVAILABLE — no distinct valid zone</div>
      </div>
    );
  }
  return (
    <div className="panel-flat px-3 py-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
          <div className="mono text-[14px] font-semibold text-slate-100">
            {fmt(zone.lower)} – {fmt(zone.upper)}
          </div>
        </div>
        <div className="text-right">
          <ScoreBar score={zone.score} />
          <div className={`text-[10px] font-semibold ${zone.status.includes("WEAK") || zone.status.includes("RISK") || zone.status.includes("BROKEN") ? "text-rose-400" : "text-emerald-400"}`}>
            {zone.status.replace("_", " ")} · {Math.round(zone.evidence.coverage * 100)}% evidence
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Price + S/R combined view (NIFTY / SENSEX tabs)
 * ------------------------------------------------------------------ */

export function SymbolView({ snapshot, symbol }: { snapshot: AnalysisSnapshot | null; symbol: string }) {
  if (!snapshot) return <Unavailable reason={`Awaiting first analysis cycle for ${symbol}.`} />;
  return (
    <div className="space-y-3">
      <Panel
        title={`${symbol} — ${snapshot.timeframe} structure and dynamic zones`}
        subtitle="Chart and S/R panel are synchronised from the same authoritative engine response."
        status={snapshot.dataQuality.overall}
      >
        <PriceChart
          candles={snapshot.chart.candles}
          zones={snapshot.zones}
          levels={snapshot.levels}
          vwap={snapshot.sessionLevels.vwap}
          prevDayHigh={snapshot.sessionLevels.prevDayHigh}
          prevDayLow={snapshot.sessionLevels.prevDayLow}
          height={460}
        />
      </Panel>
      <SrPanel snapshot={snapshot} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Historical replay
 * ------------------------------------------------------------------ */

export function ReplayView({ symbol, timeframe }: { symbol: string; timeframe: string }) {
  const [date, setDate] = useState(new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/replay?symbol=${symbol}&timeframe=${timeframe}&date=${date}`, { cache: "no-store" });
      const json = (await res.json()) as { ok: boolean; replay?: ReplayResult; error?: string };
      if (json.ok && json.replay) setResult(json.replay);
      else setError(json.error ?? "Replay failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Replay failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe]);

  const m = result?.metrics ?? null;
  return (
    <div className="space-y-3">
      <Panel
        title="Historical Replay & Strategy Validation"
        subtitle="Replays candle-by-candle using only candles with ts <= step. OI, Greeks and option premiums are NOT replayed because Upstox does not expose historical option-chain snapshots — those modules report UNAVAILABLE rather than being simulated."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-[9px] uppercase tracking-widest text-slate-500">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mono mt-1 block rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[12px] text-slate-200"
            />
          </div>
          <button onClick={run} disabled={loading} className="rounded bg-sky-600 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50">
            {loading ? "Running…" : "Run replay"}
          </button>
          <div className="text-[11px] text-slate-500">
            {symbol} · {timeframe} · {result?.bars ?? 0} bars · {result?.frames.length ?? 0} evaluation steps
          </div>
        </div>
        {error ? <div className="mt-3 text-[11px] text-rose-400">{error}</div> : null}
        {result ? (
          <>
            <div className="mt-3"><StatusBadge status={result.status} /> <span className="ml-2 text-[11px] text-slate-400">{result.message}</span></div>
            {m ? (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                <Metric label="Zone touches" value={m.zoneTouchCount} />
                <Metric label="Rejections" value={m.rejectionCount} />
                <Metric label="Rejection rate" value={m.rejectionRate === null ? "n/a" : `${m.rejectionRate}%`} />
                <Metric label="Breakdowns" value={m.breakdownCount} />
                <Metric label="Breakouts" value={m.breakoutCount} />
                <Metric label="Avg zone survival (bars)" value={m.avgZoneSurvivalBars ?? "n/a"} />
                <Metric label="Avg score (held)" value={m.avgScoreOfHeldZones ?? "n/a"} tone="green" />
                <Metric label="Avg score (failed)" value={m.avgScoreOfFailedZones ?? "n/a"} tone="red" />
                <Metric label="Calibration spread" value={m.strengthCalibrationSpread ?? "n/a"} hint="higher = better calibration" />
                <Metric label="CALL setups (underlying)" value={m.callSetupCount} hint={m.callSetupForwardMoveAvg === null ? undefined : `avg fwd move ${m.callSetupForwardMoveAvg}%`} />
                <Metric label="PUT setups (underlying)" value={m.putSetupCount} hint={m.putSetupForwardMoveAvg === null ? undefined : `avg fwd move ${m.putSetupForwardMoveAvg}%`} />
                <Metric label="Bars analysed" value={m.barsAnalysed} />
              </div>
            ) : null}
            <div className="mt-3 max-h-72 overflow-y-auto scroll-thin rounded border border-slate-800">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <Th>Time</Th>
                    <Th align="right">Spot</Th>
                    <Th>Trend</Th>
                    <Th>Immediate support</Th>
                    <Th>Primary support</Th>
                    <Th>Immediate resistance</Th>
                    <Th>Primary resistance</Th>
                    <Th align="right">Zones</Th>
                  </tr>
                </thead>
                <tbody>
                  {[...(result.frames ?? [])].reverse().map((f, i) => (
                    <tr key={i}>
                      <Td tone="mono">{fmtTime(new Date(f.ts).toISOString())}</Td>
                      <Td align="right" tone="mono">{fmt(f.spot)}</Td>
                      <Td tone={f.trend === "BULLISH" ? "text-emerald-400" : f.trend === "BEARISH" ? "text-rose-400" : "text-slate-400"}>{f.trend}</Td>
                      <Td tone="mono">{f.immediateSupport ? `${fmt(f.immediateSupport.lower)}–${fmt(f.immediateSupport.upper)} (${f.immediateSupport.score})` : "unavailable"}</Td>
                      <Td tone="mono">{f.primarySupport ? `${fmt(f.primarySupport.lower)}–${fmt(f.primarySupport.upper)} (${f.primarySupport.score})` : "unavailable"}</Td>
                      <Td tone="mono">{f.immediateResistance ? `${fmt(f.immediateResistance.lower)}–${fmt(f.immediateResistance.upper)} (${f.immediateResistance.score})` : "unavailable"}</Td>
                      <Td tone="mono">{f.primaryResistance ? `${fmt(f.primaryResistance.lower)}–${fmt(f.primaryResistance.upper)} (${f.primaryResistance.score})` : "unavailable"}</Td>
                      <Td align="right" tone="mono">{f.zones}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="mt-3 space-y-1 text-[11px] text-amber-300/80">
              {(result.unavailable ?? []).map((u, i) => (
                <li key={i}>• {u}</li>
              ))}
            </ul>
            <div className="mt-2 text-[10px] text-slate-500">Look-ahead guard: {result.lookAheadGuard}</div>
          </>
        ) : null}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Alerts
 * ------------------------------------------------------------------ */

interface AlertRow {
  id: number;
  symbol: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  createdAt: string;
}

export function AlertsView({ snapshot }: { snapshot: AnalysisSnapshot | null }) {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`/api/alerts?limit=150`, { cache: "no-store" });
        const json = (await res.json()) as { ok: boolean; alerts: AlertRow[] };
        if (json.ok) setAlerts(json.alerts);
      } catch {
        // ignore
      }
    };
    void load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-3">
      <Panel title="Live event snapshot" status={snapshot ? "LIVE" : "UNAVAILABLE"}>
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
          {(snapshot?.alertsRecent ?? []).map((a, i) => (
            <div key={i} className="panel-flat px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-200">{a.title}</span>
                <StatusBadge status={a.severity === "CRITICAL" ? "INVALID" : a.severity === "WARNING" ? "PARTIAL" : "LIVE"} small />
              </div>
              <div className="mt-1 text-[10px] text-slate-500">{a.message}</div>
            </div>
          ))}
          {(snapshot?.alertsRecent ?? []).length === 0 ? <Unavailable reason="No validated events in this cycle — alerts are only generated from confirmed engine events." /> : null}
        </div>
      </Panel>
      <Panel title="Alert history (deduplicated, persisted in PostgreSQL)">
        <div className="max-h-[420px] overflow-y-auto scroll-thin">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Symbol</Th>
                <Th>Type</Th>
                <Th>Severity</Th>
                <Th>Title</Th>
                <Th>Message</Th>
                <Th>Time</Th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <Td className="font-semibold">{a.symbol}</Td>
                  <Td tone="text-slate-300">{a.type}</Td>
                  <Td>{a.severity}</Td>
                  <Td tone="text-slate-200">{a.title}</Td>
                  <Td tone="text-slate-400">{a.message}</Td>
                  <Td tone="mono">{fmtDateTime(a.createdAt)}</Td>
                </tr>
              ))}
              {alerts.length === 0 ? (
                <tr>
                  <Td tone="text-slate-500">No alerts recorded yet.</Td>
                  <Td>-</Td>
                  <Td>-</Td>
                  <Td>-</Td>
                  <Td>-</Td>
                  <Td>-</Td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export function SettingsView() {
  const { state, connection, connectError, lastError, connecting, connect, disconnect, refresh } = useSessionContext();
  const [token, setToken] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string; status?: string; fix?: string | null } | null>(null);
  const [testing, setTesting] = useState(false);
  const [diagnostics, setDiagnostics] = useState<{ checks: Array<{ id: string; endpoint: string; ok: boolean; status: string; message: string; httpStatus: number | null; latencyMs: number | null }> } | null>(null);

  const runDiagnostics = async () => {
    setTesting(true);
    try {
      const res = await fetch("/api/diagnostics?symbol=NIFTY", { cache: "no-store" });
      const json = (await res.json()) as { checks: Array<{ id: string; endpoint: string; ok: boolean; status: string; message: string; httpStatus: number | null; latencyMs: number | null }> };
      setDiagnostics(json);
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    setResult(null);
    const outcome = await connect(token);
    if (outcome.ok) {
      setToken("");
      setResult({ ok: true, text: outcome.message ?? "Connected", status: outcome.tokenStatus });
      // Push a fresh analysis for both indices straight away.
      void refresh();
    } else {
      setResult({
        ok: false,
        text: outcome.error ?? "Connection failed",
        status: outcome.tokenStatus,
        fix: outcome.httpStatus === 401 ? "Regenerate the access token at https://account.upstox.com/developer/apps and paste the full value." : null,
      });
    }
  };

  const session = state.session;
  const connected = state.connected && session.active;

  return (
    <div className="space-y-3">
      <Panel
        title="Upstox Session"
        subtitle="Your access token is validated against the official GET /v2/user/profile endpoint, then held in backend runtime memory and mirrored in an AES-256-GCM encrypted shared store so it survives restarts and is visible to every backend instance. It is never stored in plaintext, never logged, and never returned to the browser."
        status={connected ? "LIVE" : connection === "CONNECTING" ? "LOADING" : "UNAVAILABLE"}
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <div>
            <label className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">Upstox access token</label>
            <textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              rows={4}
              placeholder="Paste your Upstox access token (eyJ…)"
              className="mono mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-2 text-[12px] text-slate-200"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button onClick={submit} disabled={connecting || token.trim().length < 40} className="rounded bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50">
                {connecting ? "Validating…" : "Connect"}
              </button>
              <button onClick={() => disconnect()} disabled={connecting} className="rounded border border-slate-700 px-3 py-1.5 text-[12px] font-semibold text-slate-300 disabled:opacity-50">
                Disconnect / Clear session
              </button>
              <button onClick={runDiagnostics} disabled={testing} className="rounded border border-sky-700 px-3 py-1.5 text-[12px] font-semibold text-sky-300 disabled:opacity-50">
                {testing ? "Testing…" : "Test all Upstox endpoints"}
              </button>
            </div>

            {result ? (
              <div className={`mt-3 rounded border px-3 py-2 text-[11px] ${result.ok ? "border-emerald-700/50 bg-emerald-500/5 text-emerald-300" : "border-rose-700/50 bg-rose-500/5 text-rose-300"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{result.ok ? "CONNECTED" : "NOT CONNECTED"}</span>
                  {result.status ? <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider">token: {result.status}</span> : null}
                </div>
                <div className="mt-1 text-slate-400">{result.text}</div>
                {result.fix ? <div className="mt-1 text-amber-300">Fix: {result.fix}</div> : null}
              </div>
            ) : null}
            {connectError && !result ? <div className="mt-2 text-[11px] text-rose-400">{connectError}</div> : null}
            {lastError ? <div className="mt-2 text-[11px] text-amber-400">Transport: {lastError}</div> : null}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Metric label="Token authentication" value={validationLabel(connection, result?.status)} tone={connected ? "green" : "muted"} mono={false} />
            <Metric label="Backend session" value={connected ? "CONNECTED" : connection === "CONNECTING" ? "CONNECTING" : "NOT CONNECTED"} tone={connected ? "green" : "muted"} mono={false} />
            <Metric label="Masked token" value={session.maskedToken || "—"} mono={false} />
            <Metric label="Token fingerprint" value={session.tokenFingerprint || "—"} />
            <Metric label="Connected at" value={session.connectedAt ? fmtDateTime(session.connectedAt) : "—"} mono={false} />
            <Metric label="Last validated" value={session.lastValidatedAt ? fmtDateTime(session.lastValidatedAt) : "—"} mono={false} />
            <Metric label="Session expires" value={session.expiresAt ? fmtDateTime(session.expiresAt) : "—"} mono={false} />
            <Metric label="Upstox user" value={session.userName ?? session.userId ?? "—"} mono={false} />
            <Metric label="Exchanges" value={session.exchanges.length > 0 ? session.exchanges.join(", ") : "—"} mono={false} />
            <Metric label="Owning process" value={session.processId || "—"} hint={session.restoredFromStore ? "restored from encrypted store" : undefined} />
            <Metric label="Encrypted store" value={session.storeError ? `ERROR: ${session.storeError}` : session.storeWritable ? "WRITABLE" : "NOT WRITTEN YET"} mono={false} tone={session.storeError ? "red" : "muted"} />
            <Metric label="Plaintext storage" value="none (memory + AES-256-GCM)" mono={false} tone="muted" />
          </div>
        </div>

        {diagnostics ? (
          <div className="mt-3 swipe-hint overflow-x-auto scroll-thin">
            <table className="w-full min-w-[680px] border-collapse">
              <thead>
                <tr>
                  <Th>Check</Th>
                  <Th>Endpoint</Th>
                  <Th>Status</Th>
                  <Th align="right">HTTP</Th>
                  <Th align="right">Latency</Th>
                  <Th>Message</Th>
                </tr>
              </thead>
              <tbody>
                {diagnostics.checks.map((c) => (
                  <tr key={c.id}>
                    <Td className="font-semibold text-slate-200">{c.id}</Td>
                    <Td tone="mono text-slate-500">{c.endpoint}</Td>
                    <Td><StatusBadge status={c.ok ? "LIVE" : c.status} small /></Td>
                    <Td align="right" tone="mono">{c.httpStatus ?? "—"}</Td>
                    <Td align="right" tone="mono">{c.latencyMs === null ? "—" : `${c.latencyMs}ms`}</Td>
                    <Td tone="text-slate-400">{c.message}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="mt-3 rounded border border-slate-800 bg-slate-900/50 p-3 text-[11px] text-slate-400">
          The header switches to <span className="font-semibold text-emerald-300">UPSTOX CONNECTED</span> only after Upstox confirms the token via{" "}
          <span className="mono">GET /v2/user/profile</span>. A click alone never marks the session connected. Disconnecting deletes the in-memory token and
          the encrypted store row immediately. A process restart without the encrypted store requires reconnecting.
        </div>
      </Panel>

      <Panel title="Engine configuration" subtitle="Initial engineering weights — explicitly not statistically validated probabilities.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <WeightTable
            title="Zone strength (100)"
            rows={[
              ["Price structure", 25],
              ["Reaction / acceptance", 20],
              ["Volume profile", 15],
              ["Options OI confluence", 15],
              ["Futures positioning", 10],
              ["Bid/ask quote intelligence", 10],
              ["Liquidity & session", 5],
            ]}
          />
          <WeightTable
            title="Directional setup score (100)"
            rows={[
              ["Spot structure & momentum", 25],
              ["Dynamic S/R behaviour", 20],
              ["Futures positioning", 10],
              ["OI & change in OI", 20],
              ["Premium momentum & volume", 15],
              ["Context & volatility", 10],
            ]}
          />
          <WeightTable
            title="Contract suitability (100)"
            rows={[
              ["Delta suitability", 20],
              ["Premium momentum", 20],
              ["Volume & relative volume", 15],
              ["Spread & liquidity", 15],
              ["OI & change in OI", 10],
              ["Gamma suitability", 5],
              ["Theta cost", 10],
              ["IV & Vega suitability", 5],
            ]}
          />
        </div>
      </Panel>
    </div>
  );
}

function validationLabel(connection: ConnectionState, tokenStatus?: string): string {
  if (connection === "CONNECTED") return "VALID";
  if (connection === "CONNECTING") return "VALIDATING…";
  if (connection === "LOST") return "SESSION LOST";
  if (tokenStatus) return tokenStatus;
  return "NOT TESTED";
}

function WeightTable({ title, rows }: { title: string; rows: Array<[string, number]> }) {
  return (
    <div className="panel-flat p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{title}</div>
      <ul className="mt-2 space-y-1">
        {rows.map(([k, v]) => (
          <li key={k} className="flex items-center justify-between text-[11px] text-slate-400">
            <span>{k}</span>
            <span className="mono text-slate-200">{v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Documentation view
 * ------------------------------------------------------------------ */

export function DocsView() {
  return (
    <div className="space-y-3">
      <Panel title="Workflow" subtitle="The complete DYNAMIC ENGINE decision chain.">
        <ol className="grid gap-1 text-[12px] text-slate-300 md:grid-cols-2">
          {[
            "Fetch actual NIFTY / SENSEX spot data from Upstox.",
            "Understand underlying market structure (confirmed pivots, BOS, CHoCH).",
            "Identify dynamic support and resistance zones from clustered reactions.",
            "Identify Immediate and Primary Support / Resistance (distinct, never duplicated).",
            "Score each zone 0–100 and compute evidence coverage separately.",
            "Classify strengthening / weakening / breakout / breakdown risk.",
            "Analyse futures positioning and valid traded volume.",
            "Analyse the full available option chain for the selected expiry.",
            "Compute strike-wise OI momentum (5m / 15m rolling, session cumulative).",
            "Evaluate CE and PE premium momentum with volume and relative volume.",
            "Evaluate Delta, Gamma, Theta, Vega and IV from Upstox-provided Greeks.",
            "Compare ATM, ITM and OTM contracts on liquidity, Greeks and risk.",
            "Rank the best CALL BUY and PUT BUY candidates independently.",
            "Generate an evidence-backed recommendation or explicit NO TRADE.",
            "Provide entry trigger, stop, targets, risk/reward and invalidation.",
            "Continuously monitor the setup and invalidate stale recommendations.",
          ].map((s, i) => (
            <li key={i} className="mono text-slate-400">
              {String(i + 1).padStart(2, "0")}. {s}
            </li>
          ))}
        </ol>
      </Panel>
      <Panel title="Known data-availability limits (Upstox)" status="PARTIAL">
        <ul className="space-y-1 text-[12px] text-slate-400">
          <li>• Index spot has no traded volume — spot volume is reported as UNAVAILABLE and volume profile is labelled ESTIMATED wherever derived.</li>
          <li>• /v2/option/chain provides best bid/ask price and quantity only (D0 level). Multi-level market depth is not provided, so depth-imbalance intelligence is NOT AVAILABLE.</li>
          <li>• No trade-level execution feed is exposed publicly, therefore CVD, footprint delta, executed volume delta, confirmed absorption and aggressor identification are NOT AVAILABLE and never simulated.</li>
          <li>• Historical option-chain / Greeks snapshots are not exposed; historical replay therefore leaves options modules UNAVAILABLE instead of fabricating history.</li>
          <li>• Live updates are produced by rate-limited polling of official Upstox REST endpoints. The protobuf market-data WebSocket is not implemented in this build.</li>
          <li>• Greeks are consumed exactly as delivered by Upstox (source: UPSTOX). No local pricing model is used and none is labelled otherwise.</li>
        </ul>
      </Panel>
      <Panel title="Risk & integrity rules enforced in code">
        <ul className="space-y-1 text-[12px] text-slate-400">
          <li>• No mock, simulated or hardcoded market data anywhere in the runtime path.</li>
          <li>• Missing evidence contributes zero weight — it never becomes positive evidence.</li>
          <li>• NO TRADE is produced whenever evidence is missing, conflicting, stale or below threshold.</li>
          <li>• NIFTY and SENSEX pipelines are fully independent (own instruments, expiries, zones, OI and recommendations).</li>
          <li>• No automatic order placement of any kind — intelligence only.</li>
        </ul>
      </Panel>
    </div>
  );
}
