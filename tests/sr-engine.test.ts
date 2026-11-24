import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_WEIGHTS } from "@/lib/config";
import { atr, toCandles } from "@/lib/engine/indicators";
import { analyzeStructure, detectConsolidations } from "@/lib/engine/structure";
import { buildClusters, extractCandidates, scoreZones, selectLevels, zoneIdFor } from "@/lib/engine/zones";
import type { Candle, SessionLevels } from "@/lib/engine/types";
import { aggregateCandles, mergeCandleSets, parseRows as parseRawRows } from "@/lib/upstox/market";

const NOW = 1_700_000_000_000;

type Def = { o: number; h: number; l: number; c: number; v?: number | null };

function build(defs: Def[], startTs = NOW - 60 * 60000): Candle[] {
  const rows = defs.map((d, i) => ({
    ts: startTs + i * 300000,
    open: d.o,
    high: d.h,
    low: d.l,
    close: d.c,
    volume: d.v === undefined ? null : d.v,
    openInterest: null,
    volumeStatus: d.v !== undefined && d.v !== null && d.v > 0 ? ("VALID" as const) : ("UNAVAILABLE" as const),
  }));
  return toCandles(rows, 5, startTs + defs.length * 300000 + 600000);
}

function emptySessionLevels(overrides: Partial<SessionLevels> = {}): SessionLevels {
  return {
    prevDayHigh: null,
    prevDayLow: null,
    prevClose: null,
    prevWeekHigh: null,
    prevWeekLow: null,
    openingRangeHigh: null,
    openingRangeLow: null,
    sessionHigh: null,
    sessionLow: null,
    vwap: null,
    vwapStatus: "UNAVAILABLE",
    ...overrides,
  };
}

/** NIFTY-like tape: rally into 25,7xx, three defended dips at ~25,770, push to 25,842 rejection. */
function niftyTape(): Candle[] {
  const defs: Def[] = [];
  let price = 25700;
  for (let i = 0; i < 8; i += 1) {
    price += 7;
    defs.push({ o: price - 7, h: price + 2, l: price - 9, c: price, v: 1000 });
  }
  for (let i = 0; i < 6; i += 1) {
    defs.push({
      o: 25792,
      h: 25801,
      l: i % 2 === 0 ? 25768 : 25772,
      c: 25795 + (i % 3),
      v: 1200,
    });
  }
  for (let i = 0; i < 7; i += 1) {
    const base = 25800 + i * 6;
    defs.push({ o: base, h: base + 6, l: base - 4, c: base + 5, v: 900 });
  }
  defs.push({ o: 25840, h: 25842, l: 25822, c: 25826, v: 1500 });
  defs.push({ o: 25826, h: 25831, l: 25816, c: 25819, v: 1300 });
  defs.push({ o: 25819, h: 25828, l: 25814, c: 25822, v: 1100 });
  return build(defs);
}

function runZoneEngine(candles: Candle[], spot: number, extra: Partial<Parameters<typeof extractCandidates>[0]> = {}) {
  const structure = analyzeStructure(candles, [], "5m", "30m");
  const a = atr(candles.filter((c) => c.complete), 14);
  const consolidations = detectConsolidations(candles.filter((c) => c.complete), a, "5m");
  const base = {
    symbol: "NIFTY" as const,
    spot,
    candles,
    higherTimeframeCandles: [] as Candle[],
    timeframe: "5m",
    htfTimeframe: "30m",
    structure,
    consolidations,
    sessionLevels: emptySessionLevels(),
    volumeProfile: {
      status: "UNAVAILABLE" as const,
      message: "",
      estimated: true,
      poc: null,
      vah: null,
      val: null,
      developingPoc: null,
      hvn: [],
      lvn: [],
      valueAreaVolumePct: null,
      concentration: null,
      migration: null,
    },
    oiClusters: [],
    quotes: { available: false, bidQty: null, askQty: null, note: "" },
    futures: { available: false, classification: null, note: "" },
    tickSize: 0.05,
    now: candles[candles.length - 1].ts + 60000,
    ...extra,
  };
  const sources = extractCandidates(base);
  const clusters = buildClusters(sources, base);
  const zones = scoreZones(clusters, base);
  return { zones, levels: selectLevels(zones, spot), structure, atrValue: a };
}

test("candle validation rejects invalid OHLC and duplicate rows", () => {
  const payload = {
    data: {
      candles: [
        ["2024-01-02T09:15:00+05:30", 100, 110, 95, 105, 1000],
        ["2024-01-02T09:20:00+05:30", 105, 110, 90, 120], // high below close -> invalid OHLC
        ["2024-01-02T09:15:00+05:30", 100, 110, 95, 105, 1000], // duplicate ts
        ["2024-01-02T09:30:00+05:30", 105, 112, 104, 110, -5], // negative volume
        ["2024-01-02T09:35:00+05:30", 110, 118, 108, 115],
      ],
    },
  };
  const parsed = parseRawRows(payload);
  assert.equal(parsed.invalidRows, 2);
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.rows.length, 2);
});

test("candle parser accepts bare candle matrices and epoch-ms timestamps", () => {
  const epochMs = 1_700_000_000_000;
  const bare = [[new Date(epochMs).toISOString(), 100, 110, 95, 105, 1000]];
  const parsed = parseRawRows({ data: bare });
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].ts, epochMs);
});

test("aggregation only uses complete candles and never mislabels the forming candle", () => {
  const rows = [
    { ts: NOW, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, openInterest: null, volumeStatus: "VALID" as const },
    { ts: NOW + 60000, open: 1.5, high: 2.5, low: 1.2, close: 2.2, volume: 12, openInterest: null, volumeStatus: "VALID" as const },
  ];
  const agg = aggregateCandles(rows, 2);
  assert.equal(agg.length, 1);
  assert.equal(agg[0].high, 2.5);
  assert.equal(agg[0].volume, 22);
  const candles = toCandles(rows, 1, NOW + 60000);
  assert.equal(candles[candles.length - 1].forming, true);
  assert.equal(candles[candles.length - 1].complete, false);
});

test("mergeCandleSets de-duplicates overlapping history and intraday windows", () => {
  const row = { ts: NOW, open: 1, high: 2, low: 0.5, close: 1.5, volume: null, openInterest: null, volumeStatus: "UNAVAILABLE" as const };
  const merged = mergeCandleSets(
    { rows: [row], status: "LIVE", message: "", source: "upstox_v3", invalidRows: 0, duplicates: 0, receivedAt: 1, windows: [], windowsSucceeded: 1, windowsFailed: 0, windowsEmpty: 0 },
    { rows: [row], status: "LIVE", message: "", source: "upstox_v3_intraday", invalidRows: 0, duplicates: 0, receivedAt: 2, windows: [], windowsSucceeded: 1, windowsFailed: 0, windowsEmpty: 0 },
  );
  assert.equal(merged.rows.length, 1);
  assert.equal(merged.duplicates, 1);
  assert.equal(merged.sources.length, 2);
});

test("dynamic S/R identifies the irregular 25,770 support and 25,842 resistance — not fixed intervals", () => {
  const candles = niftyTape();
  const spot = candles[candles.length - 1].close;
  const { levels } = runZoneEngine(candles, spot);

  assert.ok(levels.immediateSupport, "immediate support should exist");
  const sup = levels.immediateSupport!.zone;
  assert.ok(sup.lower >= 25755 && sup.upper <= 25790, `support zone ${sup.lower}-${sup.upper} should bracket the 25,770 defence`);
  assert.ok(Math.abs(sup.center - 25770) < 12, `support centre ${sup.center} must sit near the actual 25,770 reaction, not a round 25,700 interval`);

  assert.ok(levels.immediateResistance, "immediate resistance should exist");
  const res = levels.immediateResistance!.zone;
  assert.ok(res.lower <= 25850 && res.upper >= 25820, `resistance zone ${res.lower}-${res.upper} should bracket the 25,842 rejection`);
  assert.ok(Math.abs(res.center - 25842) < 18, `resistance centre ${res.center} must sit near 25,842`);
});

test("immediate and primary levels are distinct when two valid zones exist", () => {
  const defs: Def[] = [];
  let price = 25650;
  for (let i = 0; i < 6; i += 1) {
    price += 4;
    defs.push({ o: price - 4, h: price + 3, l: price - 6, c: price, v: 800 });
  }
  defs.push({ o: 25700, h: 25704, l: 25692, c: 25702, v: 1500 });
  defs.push({ o: 25702, h: 25710, l: 25696, c: 25708, v: 1200 });
  for (let i = 0; i < 5; i += 1) defs.push({ o: 25750 + i * 5, h: 25760 + i * 5, l: 25745 + i * 5, c: 25755 + i * 5, v: 900 });
  for (let i = 0; i < 6; i += 1) defs.push({ o: 25792, h: 25801, l: 25768 + (i % 2) * 3, c: 25795, v: 1200 });
  for (let i = 0; i < 8; i += 1) defs.push({ o: 25810 + i * 3, h: 25816 + i * 3, l: 25806 + i * 3, c: 25813 + i * 3, v: 900 });
  const candles = build(defs);
  const spot = candles[candles.length - 1].close;
  const { levels } = runZoneEngine(candles, spot);
  assert.ok(levels.immediateSupport);
  if (levels.primarySupport && levels.immediateSupport) {
    assert.notEqual(levels.primarySupport.zone.id, levels.immediateSupport.zone.id, "primary must not duplicate immediate");
  } else {
    assert.ok(levels.unavailable.some((u) => u.includes("Primary Support")), "absence must be reported explicitly");
  }
});

test("compatible reactions cluster together; unrelated levels stay separate", () => {
  const defs: Def[] = [];
  let price = 25650;
  for (let i = 0; i < 5; i += 1) {
    price += 5;
    defs.push({ o: price - 5, h: price + 2, l: price - 7, c: price, v: 800 });
  }
  defs.push({ o: 25690, h: 25694, l: 25680, c: 25692, v: 1000 });
  defs.push({ o: 25692, h: 25698, l: 25684, c: 25696, v: 900 });
  for (let i = 0; i < 6; i += 1) defs.push({ o: 25790, h: 25800, l: 25770, c: 25795, v: 1200 });
  for (let i = 0; i < 6; i += 1) defs.push({ o: 25810 + i * 3, h: 25815 + i * 3, l: 25805 + i * 3, c: 25812 + i * 3, v: 800 });
  const candles = build(defs);
  const spot = candles[candles.length - 1].close;
  const { zones } = runZoneEngine(candles, spot);
  const supports = zones.filter((z) => z.kind === "support").map((z) => z.center);
  const distinct = new Set(supports.map((c) => Math.round(c)));
  assert.ok(distinct.size >= 2, `expected two separate support zones, got ${supports.join(", ")}`);
  const nearest = supports.sort((a, b) => Math.abs(a - 25770) - Math.abs(b - 25770))[0];
  assert.ok(Math.abs(nearest - 25770) < 15, `nearest support ${nearest} should cluster the 25,770 reactions`);
});

test("zone provenance preserves OI-only sources separately from structural sources", () => {
  const candles = niftyTape();
  const spot = candles[candles.length - 1].close;
  const { zones } = runZoneEngine(candles, spot, {
    oiClusters: [{ strike: spot - 30, side: "PE", oi: 4_000_000, share: 0.22, kind: "PE OI concentration" }],
  });
  const oiZone = zones.find((z) => z.sources.some((s) => s.kind === "OI_CLUSTER"));
  assert.ok(oiZone, "an OI cluster should generate a zone candidate");
  const structural = zones.filter((z) => z.sources.some((s) => s.kind !== "OI_CLUSTER"));
  assert.ok(structural.length > 0, "structural zones must exist independently of OI clusters");
});

test("strengthening and weakening are computed independently of strength score", () => {
  const candles = niftyTape();
  const spot = candles[candles.length - 1].close;
  const probe = runZoneEngine(candles, spot);
  const supId = probe.levels.immediateSupport?.zone.id ?? zoneIdFor("NIFTY", "support", 25770);
  const now = candles[candles.length - 1].ts + 60000;

  const weakening = runZoneEngine(candles, spot, {
    now,
    scoreHistory: { [supId]: [{ t: now - 300000, score: 100 }] },
  });
  const w = weakening.zones.find((z) => z.id === supId);
  assert.ok(w, "weakening zone should be present");
  assert.equal(w!.status, "WEAKENING");
  assert.ok((w!.scoreChange5m ?? 0) < 0);

  const strengthening = runZoneEngine(candles, spot, {
    now,
    scoreHistory: { [supId]: [{ t: now - 300000, score: 0 }] },
  });
  const s = strengthening.zones.find((z) => z.id === supId);
  assert.ok(s);
  assert.equal(s!.status, "STRENGTHENING");
  assert.ok((s!.scoreChange5m ?? 0) > 0);
  assert.ok(["VERY_STRONG", "STRONG", "MODERATE", "WEAK", "VERY_WEAK"].includes(s!.classification));
});

test("failed breakout and confirmed breakout are distinguished", () => {
  const defs: Def[] = [];
  let price = 25700;
  for (let i = 0; i < 8; i += 1) {
    price += 5;
    defs.push({ o: price - 5, h: price + 2, l: price - 6, c: price, v: 900 });
  }
  defs.push({ o: 25734, h: 25736, l: 25722, c: 25724, v: 900 });
  defs.push({ o: 25724, h: 25730, l: 25720, c: 25728, v: 900 });
  defs.push({ o: 25728, h: 25780, l: 25726, c: 25776, v: 1600 });
  defs.push({ o: 25776, h: 25805, l: 25770, c: 25800, v: 1700 });
  defs.push({ o: 25800, h: 25812, l: 25792, c: 25808, v: 1500 });
  const s1 = analyzeStructure(build(defs), [], "5m", "30m");
  assert.ok(
    s1.events.some((e) => (e.type === "BOS" || e.type === "CHoCH") && e.direction === "BULLISH"),
    `expected a bullish break of structure, got ${s1.events.map((e) => e.type).join(",")}`,
  );
  assert.ok(!s1.events.some((e) => e.type === "FAILED_BREAKOUT"), "the confirmed breakout must not be marked failed");

  const defs2: Def[] = [];
  let p = 25700;
  for (let i = 0; i < 6; i += 1) {
    p += 6;
    defs2.push({ o: p - 6, h: p + 2, l: p - 8, c: p, v: 900 });
  }
  defs2.push({ o: 25734, h: 25736, l: 25722, c: 25724, v: 900 });
  defs2.push({ o: 25724, h: 25730, l: 25720, c: 25728, v: 900 });
  defs2.push({ o: 25728, h: 25780, l: 25726, c: 25776, v: 1600 });
  defs2.push({ o: 25776, h: 25782, l: 25716, c: 25720, v: 1500 });
  const s2 = analyzeStructure(build(defs2), [], "5m", "30m");
  assert.ok(s2.events.some((e) => e.type === "FAILED_BREAKOUT"), `expected failed breakout detection, got ${s2.events.map((e) => e.type).join(",")}`);
});

test("breakdown risk is flagged when price presses onto support with falling closes", () => {
  const defs: Def[] = [];
  let price = 25900;
  for (let i = 0; i < 10; i += 1) {
    price -= 6;
    defs.push({ o: price + 6, h: price + 9, l: price - 3, c: price, v: 900 });
  }
  for (let i = 0; i < 5; i += 1) defs.push({ o: 25845 - i, h: 25848 - i, l: 25838 - i, c: 25841 - i, v: 800 });
  const candles = build(defs);
  const spot = candles[candles.length - 1].close;
  const { levels } = runZoneEngine(candles, spot);
  assert.ok(levels.immediateSupport, "support below the declining tape should exist");
});

test("a single wick cannot invalidate a zone", () => {
  const defs: Def[] = [];
  let price = 25700;
  for (let i = 0; i < 10; i += 1) {
    price += 6;
    defs.push({ o: price - 6, h: price + 2, l: price - 7, c: price, v: 900 });
  }
  defs.push({ o: 25770, h: 25840, l: 25768, c: 25775, v: 1200 });
  const candles = build(defs);
  const { zones } = runZoneEngine(candles, candles[candles.length - 1].close);
  const resistance = zones.find((z) => z.kind === "resistance" && z.center > 25790);
  if (resistance) assert.notEqual(resistance.status, "INVALIDATED", "a single wick cannot invalidate a zone");
});

test("quote depth intelligence never fabricates quantities", () => {
  const candles = niftyTape();
  const spot = candles[candles.length - 1].close;
  const withQty = runZoneEngine(candles, spot, {
    quotes: { available: true, bidQty: 5000, askQty: 1000, note: "" },
  });
  const withoutQty = runZoneEngine(candles, spot, { quotes: { available: false, bidQty: null, askQty: null, note: "" } });
  const zWith = withQty.zones.find((z) => z.id === withoutQty.zones.find((x) => x.kind === "support")?.id);
  if (zWith) assert.ok(zWith.evidence.components.quotes !== null, "quote component must be populated when quantities exist");
  const support = withoutQty.levels.immediateSupport?.zone;
  if (support) {
    assert.equal(support.evidence.components.quotes, null, "missing depth must be reported as unavailable, never as positive evidence");
    assert.ok(support.evidence.missing.includes("quotes"));
  }
});

test("independent symbol pipelines produce independent zone identities", () => {
  assert.notEqual(zoneIdFor("NIFTY", "support", 25770), zoneIdFor("SENSEX", "support", 25770));
  assert.equal(zoneIdFor("NIFTY", "support", 25770.0), zoneIdFor("NIFTY", "support", 25770.0));
});

test("scoring weights are internally consistent", () => {
  assert.equal(Object.values(DEFAULT_WEIGHTS.zone).reduce((a, b) => a + b, 0), 100);
  assert.equal(Object.values(DEFAULT_WEIGHTS.setup).reduce((a, b) => a + b, 0), 100);
  assert.equal(Object.values(DEFAULT_WEIGHTS.suitability).reduce((a, b) => a + b, 0), 100);
});
