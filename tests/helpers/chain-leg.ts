/**
 * Test-only mirror of the option-chain leg parser in src/lib/upstox/market.ts.
 * Verifies the documented `market_data` / `option_greeks` mapping.
 */
export interface ParsedLeg {
  instrumentKey: string | null;
  ltp: number | null;
  prevClose: number | null;
  volume: number | null;
  oi: number | null;
  prevOi: number | null;
  bidPrice: number | null;
  bidQty: number | null;
  askPrice: number | null;
  askQty: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  pop: number | null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function parseLegTestHelper(raw: unknown): ParsedLeg {
  const leg = (raw ?? {}) as Record<string, unknown>;
  const md = (leg.market_data ?? {}) as Record<string, unknown>;
  const greeks = (leg.option_greeks ?? {}) as Record<string, unknown>;
  return {
    instrumentKey: typeof leg.instrument_key === "string" ? leg.instrument_key : null,
    ltp: num(md.ltp),
    prevClose: num(md.close_price),
    volume: num(md.volume),
    oi: num(md.oi),
    prevOi: num(md.prev_oi),
    bidPrice: num(md.bid_price),
    bidQty: num(md.bid_qty),
    askPrice: num(md.ask_price),
    askQty: num(md.ask_qty),
    delta: num(greeks.delta),
    gamma: num(greeks.gamma),
    theta: num(greeks.theta),
    vega: num(greeks.vega),
    iv: num(greeks.iv),
    pop: num(greeks.pop),
  };
}
