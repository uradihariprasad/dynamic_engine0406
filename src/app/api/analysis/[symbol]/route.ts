import { PRIMARY_TIMEFRAME, SYMBOL_KEYS, TIMEFRAMES, type SymbolKey, type Timeframe } from "@/lib/config";
import { getAnalysis } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await context.params;
  const upper = symbol.toUpperCase();
  if (!SYMBOL_KEYS.includes(upper as SymbolKey)) {
    return Response.json({ ok: false, error: `Unsupported symbol ${upper}. Supported: ${SYMBOL_KEYS.join(", ")}` }, { status: 400 });
  }
  const url = new URL(request.url);
  const tfParam = (url.searchParams.get("timeframe") ?? PRIMARY_TIMEFRAME).toLowerCase();
  if (!TIMEFRAMES.includes(tfParam as Timeframe)) {
    return Response.json({ ok: false, error: `Unsupported timeframe ${tfParam}. Supported: ${TIMEFRAMES.join(", ")}` }, { status: 400 });
  }
  try {
    const snapshot = await getAnalysis(upper as SymbolKey, tfParam as Timeframe);
    return Response.json({ ok: true, snapshot });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "Analysis failed" },
      { status: 500 },
    );
  }
}
