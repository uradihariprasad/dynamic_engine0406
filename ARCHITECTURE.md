# DYNAMIC ENGINE — Architecture

## 1. Layering

```
React terminal (src/app/page.tsx + src/components/**)
        │  fetch /api/analysis/{symbol}?timeframe=… every 5s
        ▼
Route handlers (src/app/api/**)
        │
        ▼
Pipeline orchestrator (src/lib/pipeline.ts)
   ├── Upstox transport  (src/lib/upstox/client.ts)   rate limit · backoff · circuit breaker
   ├── Session registry  (src/lib/upstox/session.ts)  in-memory token only
   ├── Market data svc   (src/lib/upstox/market.ts)   quotes · candles · chain · status
   ├── Instrument master (src/lib/upstox/instruments.ts)
   ├── Structure engine  (src/lib/engine/structure.ts)
   ├── Indicator engine  (src/lib/engine/indicators.ts)  ATR · VWAP · volume profile
   ├── Dynamic S/R engine(src/lib/engine/zones.ts)       candidates · clusters · scoring · levels
   ├── Futures engine    (src/lib/engine/futures.ts)
   ├── Options engine    (src/lib/engine/options.ts)     OI · strike intel · strike selection
   ├── Trade engine      (src/lib/engine/trade.ts)       setup score · plans · scenarios
   ├── Replay engine     (src/lib/engine/replay.ts)
   ├── Alert service     (src/lib/alerts.ts)
   └── Persistence       (src/db/schema.ts, Drizzle + PostgreSQL)
```

Every arrow is one-directional: engines never read HTTP state, and the pipeline is the only
component that talks to both Upstox and PostgreSQL.

## 2. Pipeline cycle

1. **Spot** quote → LTP/OHLC/session levels/freshness.
2. **Candles** — v3 history + v3 intraday merged, validated, aggregated to the requested timeframe; the newest bucket is flagged `forming` and excluded from analysis.
3. **Higher timeframe** context is aggregated from complete lower-timeframe candles only.
4. **Structure** — confirmed pivots, HH/HL/LH/LL, BOS/CHoCH, failed breakout/breakdown, retest, consolidations.
5. **Volume profile** (POC/VAH/VAL/HVN/LVN) and **session references** (PDH/PDL/PC/PWH/PWL/ORH/ORL/session H/L/VWAP).
6. **Futures** — nearest contract, quote, persisted 5-minute-ago reference snapshot → price/OI/volume classification.
7. **Option chain** — expiries → contracts (lot size, trading symbol) → chain rows → OI snapshot persistence → rolling OI changes → strike intel → strike selection.
8. **Dynamic S/R** — candidate extraction → clustering → scoring → lifecycle status → the four mandatory levels.
9. **Trade engine** — directional setup score, contract suitability score, evidence coverage, conditions, entry/stop/targets, scenarios, monitoring state.
10. **Data quality + alerts + persistence**, then a snapshot is cached for `ANALYSIS_TTL_MS` and returned.

NIFTY and SENSEX run **completely independent** instances of steps 1–10 (separate instruments,
expiries, snapshots, zones, recommendations). Nothing is shared except code.

## 3. Dynamic S/R engine detail

**Candidates** (`extractCandidates`): confirmed swing lows/highs (both timeframes), wick-rejection
extremes (with follow-through weighting), body-rejection expansion candles, consolidation
boundaries with acceptance counts, failed breakout/breakdown levels, prior-day/week and
opening-range references, volume nodes, and OI clusters (provenance preserved, flagged `oiOnly`).

**Clustering** (`buildClusters`): greedy price-ordered clustering with tolerance
`max(0.42 × ATR, 6 × tickSize, 0.02% × spot)`. Zones are then labelled support/resistance from
price context relative to spot — never by assumption. Single low-weight clusters are dropped,
except OI clusters, which are retained with explicit provenance.

**Width** = `max(0.18 × ATR, 2 × tickSize, 0.06% × spot, 2.2 × dispersion)` — derived from ATR,
local volatility, reaction dispersion and tick size. Fixed intervals are impossible by construction.

**Scoring** (`scoreZones` → `buildEvidence`): each of the seven configured components returns
`0..1` or `null` when the evidence is unavailable. The score is the weighted sum of *available*
components only, so missing data contributes **zero** and never becomes positive evidence.
`evidence.coverage` reports available weight / 100 separately. Contradictions are listed explicitly.

**Lifecycle** (`computeStatus`): two consecutive closes beyond the zone → `INVALIDATED`;
one close beyond → `BROKEN`; pressing into the zone → `BREAKOUT_RISK` / `BREAKDOWN_RISK`;
score deltas and rejection quality → `STRENGTHENING` / `WEAKENING`; otherwise `ACTIVE`,
`VALIDATED`, `CANDIDATE`. Zones that sit on the wrong side of spot without defending evidence of
their own kind become `ROLE_REVERSAL_CANDIDATE` and are excluded from Immediate/Primary selection.

**Level selection** (`selectLevels`): nearest active support at/below spot → Immediate Support;
highest-scoring *different* support → Primary Support (same logic above spot for resistance).
When a second distinct zone does not exist the level is reported as unavailable with a reason.

## 4. Scoring weights (initial engineering weights, not validated probabilities)

* Zone strength — price structure 25, reaction 20, volume profile 15, OI confluence 15, futures 10, quotes 10, liquidity/session 5.
* Directional setup — spot structure/momentum 25, S/R behaviour 20, futures 10, OI change 20, premium momentum 15, context/volatility 10.
* Contract suitability — delta 20, premium momentum 20, volume/relative volume 15, spread/liquidity 15, OI 10, gamma 5, theta cost 10, IV/Vega 5.

Thresholds: setup ≥ 62, suitability ≥ 60, coverage ≥ 55%, spread ≤ 1.5%, option volume ≥ 5,000.

## 5. Trade engine rules

* Underlying spot evidence must support the bias (structure or S/R behaviour ≥ 0.15 alignment).
* At least two independent directional evidence sources must be available — a single indicator can never determine direction.
* Bullish and bearish scores must differ by ≥ 8 points.
* The contract must clear volume, spread, delta-availability and coverage gates.
* Entry, stop and targets are derived from actual zone boundaries and ATR buffers; premium stop/targets are delta/gamma projections explicitly labelled `ESTIMATED`.
* Entry states: `READY`, `WAIT_FOR_RETEST`, `MISSED_ENTRY`, `NOT_APPLICABLE` — stale moves are never chased.
* Monitoring advances the state (WATCHLIST → WAITING_FOR_ENTRY → ENTRY_TRIGGERED → ACTIVE → TARGET_1/2_HIT → STOP_LOSS_HIT → MISSED/EXPIRED).

## 6. Data integrity guarantees

* No mock, simulated, random or hardcoded market data exists in the runtime path.
* Unavailable fields are surfaced as `UNAVAILABLE` / `NOT AVAILABLE` with a reason.
* Stale data is flagged `STALE` and is never silently treated as live.
* OI totals, rolling OI changes and session-cumulative changes are tracked as separate values with their own timestamps.
* Historical replay never reads candles with `ts > step` to build a zone; future data is used only to measure outcomes.
* The access token never reaches the database, logs, localStorage, sessionStorage or any API response.

## 7. Database tables

`instrument_cache`, `candle_cache`, `oi_snapshot`, `futures_snapshot`, `zone_registry`,
`zone_score_history`, `recommendation`, `alert_event`, `data_quality_event`, `replay_run`.

Persistence is best-effort and never blocks analysis: OI snapshots power rolling OI changes,
zone score history powers strengthening/weakening, and recommendations/alerts power monitoring
and the alert feed.
