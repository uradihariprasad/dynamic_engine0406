"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  LineSeries,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, SrLevels, Zone } from "@/lib/engine/types";

interface OverlayBand {
  top: number;
  height: number;
  color: string;
  label: string;
  strong: boolean;
}

const GREEN = "rgba(22, 199, 132, ";
const RED = "rgba(246, 70, 93, ";

export function PriceChart({
  candles,
  zones,
  levels,
  vwap,
  prevDayHigh,
  prevDayLow,
  height = 420,
}: {
  candles: Candle[];
  zones: Zone[];
  levels: SrLevels;
  vwap: number | null;
  prevDayHigh: number | null;
  prevDayLow: number | null;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [responsiveHeight, setResponsiveHeight] = useState(height);

  // Reduce chart height on small screens so the chart plus the S/R panel fit
  // without excessive scrolling.
  useEffect(() => {
    const apply = () => {
      if (typeof window === "undefined") return;
      setResponsiveHeight(window.innerWidth < 640 ? Math.min(height, 260) : height);
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [height]);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const priceLinesRef = useRef<ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]>[]>([]);
  const [bands, setBands] = useState<OverlayBand[]>([]);

  const data: CandlestickData[] = useMemo(
    () =>
      candles.map((c) => ({
        time: (Math.floor(c.ts / 1000) as UTCTimestamp) as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    [candles],
  );

  const vwapData: LineData[] = useMemo(
    () => candles.map((c) => ({ time: (Math.floor(c.ts / 1000) as UTCTimestamp) as Time, value: vwap ?? 0 })).filter((d) => vwap !== null),
    [candles, vwap],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const isTouch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    const chart = createChart(el, {
      height,
      layout: {
        background: { color: "transparent" },
        textColor: "#8698b3",
        fontSize: isTouch ? 10 : 11,
        attributionLogo: false,
      },
      grid: { vertLines: { color: "rgba(30,41,59,0.45)" }, horzLines: { color: "rgba(30,41,59,0.45)" } },
      rightPriceScale: { borderColor: "#1e293b", scaleMargins: { top: 0.12, bottom: isTouch ? 0.22 : 0.12 } },
      timeScale: { borderColor: "#1e293b", timeVisible: true, secondsVisible: false, rightOffset: 6 },
      // Touch: pan with one finger, pinch-zoom retained. Mouse: keep scroll-wheel zoom off
      // so the page still scrolls normally over the chart.
      handleScroll: isTouch ? { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false } : { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: isTouch ? { axisPressedMouseMove: true, mouseWheel: false, pinch: true } : { axisPressedMouseMove: true, mouseWheel: false, pinch: true },
      crosshair: { mode: 1 },
      // Vertical touch drag is disabled so a vertical swipe over the chart scrolls the page.
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#16c784",
      downColor: "#f6465d",
      borderUpColor: "#16c784",
      borderDownColor: "#f6465d",
      wickUpColor: "#16c784",
      wickDownColor: "#f6465d",
      priceFormat: { type: "price", precision: 2, minMove: 0.05 },
    });
    const vwapSeries = chart.addSeries(LineSeries, {
      color: "#8b5cf6",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    vwapSeriesRef.current = vwapSeries;

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth });
    chart.timeScale().subscribeVisibleTimeRangeChange(() => computeBands());

    function computeBands() {
      const series = candleSeriesRef.current;
      if (!series) return;
      const next: OverlayBand[] = [];
      const strongZones: Array<{ z: Zone; strong: boolean }> = [];
      for (const sel of [levels.immediateSupport, levels.primarySupport, levels.immediateResistance, levels.primaryResistance]) {
        if (sel) strongZones.push({ z: sel.zone, strong: true });
      }
      for (const z of zones.slice(0, 10)) {
        if (strongZones.some((s) => s.z.id === z.id)) continue;
        strongZones.push({ z, strong: false });
      }
      for (const { z, strong } of strongZones) {
        const upper = series.priceToCoordinate(z.upper);
        const lower = series.priceToCoordinate(z.lower);
        if (upper === null || lower === null) continue;
        const top = Math.min(upper, lower);
        const h = Math.max(2, Math.abs(lower - upper));
        next.push({
          top,
          height: h,
          color: `${z.kind === "support" ? GREEN : RED}${strong ? "0.18" : "0.07"})`,
          label: strong ? `${z.kind === "support" ? "S" : "R"} ${z.lower}–${z.upper}` : "",
          strong,
        });
      }
      setBands(next);
    }

    computeBands();
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      vwapSeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [responsiveHeight]);

  // Candle data (updated in place — no full chart reload)
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    candleSeriesRef.current.setData(data);
  }, [data]);

  useEffect(() => {
    if (!vwapSeriesRef.current) return;
    vwapSeriesRef.current.setData(vwap !== null ? vwapData : []);
  }, [vwapData, vwap]);

  // Price lines for the four mandatory levels
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];
    const add = (price: number, title: string, color: string) => {
      priceLinesRef.current.push(
        series.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }),
      );
    };
    if (levels.immediateSupport) add(levels.immediateSupport.zone.upper, "IMM SUP", "#16c784");
    if (levels.primarySupport) add(levels.primarySupport.zone.upper, "PRI SUP", "#0ea5a0");
    if (levels.immediateResistance) add(levels.immediateResistance.zone.lower, "IMM RES", "#f6465d");
    if (levels.primaryResistance) add(levels.primaryResistance.zone.lower, "PRI RES", "#fb7185");
    if (prevDayHigh !== null) add(prevDayHigh, "PDH", "#64748b");
    if (prevDayLow !== null) add(prevDayLow, "PDL", "#64748b");
  }, [levels, prevDayHigh, prevDayLow]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-slate-800 bg-slate-900/30" style={{ height: responsiveHeight }}>
        <div className="text-center">
          <p className="text-[12px] font-semibold uppercase tracking-widest text-slate-500">Candles unavailable</p>
          <p className="mt-1 text-[11px] text-slate-600">
            Connect an Upstox session to render real market candles. No placeholder data is shown.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative" style={{ height: responsiveHeight }}>
      <div ref={containerRef} className="h-full w-full touch-pan-y" />
      <div className="pointer-events-none absolute inset-0">
        {bands.map((b, i) => (
          <div
            key={i}
            className="absolute left-0 right-0 flex items-start justify-end pr-2"
            style={{ top: b.top, height: b.height, background: b.color, borderTop: b.strong ? "1px dashed rgba(226,232,240,0.35)" : undefined, borderBottom: b.strong ? "1px dashed rgba(226,232,240,0.35)" : undefined }}
          >
            {b.strong && b.height > 14 ? (
              <span className="mono rounded bg-slate-950/70 px-1 text-[9px] text-slate-300">{b.label}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
