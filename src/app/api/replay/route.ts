import { SYMBOL_KEYS, TIMEFRAMES, type SymbolKey, type Timeframe } from "@/lib/config";
import { runReplay } from "@/lib/engine/replay";
import { fetchHistoryCandles } from "@/lib/upstox/market";
import { isConnected } from "@/lib/upstox/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbolParam = (url.searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  const tfParam = (url.searchParams.get("timeframe") ?? "5m").toLowerCase();
  const date = url.searchParams.get("date") ?? new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  if (!SYMBOL_KEYS.includes(symbolParam as SymbolKey)) {
    return Response.json({ ok: false, error: `Unsupported symbol ${symbolParam}` }, { status: 400 });
  }
  if (!TIMEFRAMES.includes(tfParam as Timeframe)) {
    return Response.json({ ok: false, error: `Unsupported timeframe ${tfParam}` }, { status: 400 });
  }
  if (!isConnected()) {
    return Response.json({
      ok: true,
      replay: {
        status: "UNAVAILABLE",
        message: "Historical candles require a connected Upstox session — connect from Settings to run replay.",
        symbol: symbolParam,
        tradeDate: date,
        timeframe: tfParam,
        bars: 0,
        frames: [],
        metrics: null,
        zonesSample: [],
        unavailable: ["No Upstox session"],
        lookAheadGuard: "Engines receive only candles with ts <= replay step.",
      },
    });
  }

  try {
    const history = await fetchHistoryCandles(symbolParam as SymbolKey, tfParam as Timeframe, 30);
    const replay = runReplay({
      symbol: symbolParam as SymbolKey,
      tradeDate: date,
      timeframe: tfParam as Timeframe,
      rows: history.rows,
    });
    return Response.json({ ok: true, replay, candleSource: history.source, candleMessage: history.message });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Replay failed" }, { status: 500 });
  }
}
