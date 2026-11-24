"use client";

import type { ReactNode } from "react";

export type DataStatus = "LIVE" | "PARTIAL" | "STALE" | "UNAVAILABLE" | "INVALID" | "DISCONNECTED" | "LOADING";

const STATUS_STYLES: Record<DataStatus, string> = {
  LOADING: "bg-sky-500/12 text-sky-300 border-sky-500/30",
  LIVE: "bg-emerald-500/12 text-emerald-300 border-emerald-500/30",
  PARTIAL: "bg-amber-500/12 text-amber-300 border-amber-500/30",
  STALE: "bg-orange-500/12 text-orange-300 border-orange-500/30",
  UNAVAILABLE: "bg-slate-500/12 text-slate-400 border-slate-500/30",
  INVALID: "bg-rose-500/12 text-rose-300 border-rose-500/30",
  DISCONNECTED: "bg-red-500/12 text-red-300 border-red-500/30",
};

export function StatusBadge({ status, small = false }: { status: string; small?: boolean }) {
  const key = (status as DataStatus) in STATUS_STYLES ? (status as DataStatus) : status === "LOADING" ? "LOADING" : "UNAVAILABLE";
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-semibold uppercase tracking-wider ${
        small ? "text-[9px]" : "text-[10px]"
      } ${STATUS_STYLES[key]}`}
    >
      {status}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  status,
  right,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  status?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel p-4 ${className}`}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-200">{title}</h2>
          {subtitle ? <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-slate-500">{subtitle}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status ? <StatusBadge status={status} /> : null}
          {right}
        </div>
      </header>
      {children}
    </section>
  );
}

export function Metric({
  label,
  value,
  hint,
  tone = "neutral",
  mono = true,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "neutral" | "green" | "red" | "amber" | "blue" | "muted";
  mono?: boolean;
}) {
  const toneClass = {
    neutral: "text-slate-100",
    green: "text-emerald-400",
    red: "text-rose-400",
    amber: "text-amber-300",
    blue: "text-sky-300",
    muted: "text-slate-500",
  }[tone];
  return (
    <div className="panel-flat px-3 py-2">
      <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className={`mt-1 text-[15px] font-semibold ${mono ? "mono" : ""} ${toneClass}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] leading-snug text-slate-500">{hint}</div> : null}
    </div>
  );
}

export function ScoreBar({ score, label }: { score: number | null; label?: string }) {
  if (score === null) return <span className="mono text-[11px] text-slate-500">n/a</span>;
  const tone = score >= 85 ? "bg-emerald-500" : score >= 70 ? "bg-emerald-400" : score >= 55 ? "bg-sky-400" : score >= 40 ? "bg-amber-400" : "bg-rose-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
      </div>
      <span className="mono text-[11px] text-slate-300">{label ?? score}</span>
    </div>
  );
}

export function Delta({ value, suffix = "" }: { value: number | null; suffix?: string }) {
  if (value === null || value === undefined) return <span className="mono text-[11px] text-slate-500">n/a</span>;
  const tone = value > 0 ? "text-emerald-400" : value < 0 ? "text-rose-400" : "text-slate-400";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={`mono text-[11px] ${tone}`}>
      {sign}
      {value}
      {suffix}
    </span>
  );
}

export function Unavailable({ reason }: { reason: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-4">
      <div className="flex items-center gap-2">
        <StatusBadge status="UNAVAILABLE" />
        <span className="text-[11px] text-slate-400">{reason}</span>
      </div>
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-4">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
      <span className="text-[11px] text-slate-400">{label}…</span>
    </div>
  );
}

export function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  return v.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const abs = Math.abs(v);
  if (abs >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${v}`;
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "n/a";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "n/a";
  return d.toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" });
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "n/a";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "n/a";
  return `${d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })} ${d.toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" })}`;
}

export function toneForNumber(v: number | null | undefined): "green" | "red" | "neutral" {
  if (v === null || v === undefined) return "neutral";
  return v > 0 ? "green" : v < 0 ? "red" : "neutral";
}

export function statusTone(status: string): "green" | "red" | "amber" | "muted" {
  switch (status) {
    case "STRENGTHENING":
    case "ACTIVE":
    case "VALIDATED":
      return "green";
    case "WEAKENING":
    case "BREAKDOWN_RISK":
    case "BREAKOUT_RISK":
    case "BROKEN":
    case "INVALIDATED":
      return "red";
    case "CANDIDATE":
    case "ROLE_REVERSAL_CANDIDATE":
      return "amber";
    default:
      return "muted";
  }
}

export function Th({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" | "center" }) {
  return (
    <th
      className={`sticky top-0 z-10 whitespace-nowrap bg-[#0c111c] px-2 py-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500 ${
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  tone,
  className = "",
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  tone?: string;
  className?: string;
}) {
  return (
    <td
      className={`whitespace-nowrap border-t border-slate-900 px-2 py-1.5 text-[11px] ${
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
      } ${tone ?? "text-slate-300"} ${className}`}
    >
      {children}
    </td>
  );
}
