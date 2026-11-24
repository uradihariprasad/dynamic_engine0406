# DYNAMIC ENGINE

Real-time dynamic market structure, support/resistance, options-chain, Greeks, strike-selection and intraday trade intelligence for **NIFTY 50** and **SENSEX**, powered exclusively by **Upstox** market data.

> **This build is a Next.js (App Router) + TypeScript + PostgreSQL/Drizzle application.**
> The original brief described a Python/FastAPI + Vite stack. The runtime available for this
> project is Node/Next.js, so the same modular architecture was implemented in TypeScript with
> React on the front end and Drizzle/PostgreSQL on the back end. Everything else in the brief —
> Upstox-only data, no mocks, no fabricated values, explicit UNAVAILABLE reporting, explainable
> scoring, NO TRADE gating — is implemented and unit-tested. See "Stack deviation" below.

---

## 1. What it does

| Capability | Implementation |
| --- | --- |
| Spot market data | `GET /v2/market-quote/quotes` for `NSE_INDEX\|Nifty 50` and `BSE_INDEX\|Sensex` |
| Candles (1m/2m/5m/15m/30m/1h) | Upstox **v3** historical + intraday candles; automatic **v2** fallback with session-anchored aggregation |
| Market structure | Confirmed fractal pivots (right-side bars required → no look-ahead), HH/HL/LH/LL, BOS, CHoCH, failed breakout/breakdown, retest |
| Dynamic S/R | Candidate extraction → ATR/tick/dispersion-driven clustering → evidence-weighted 0–100 score → lifecycle status |
| Four mandatory levels | Immediate/Primary Support and Resistance, always distinct, never fabricated |
| Zone strength engine | price structure 25 · reaction 20 · volume profile 15 · OI confluence 15 · futures 10 · quotes 10 · liquidity/session 5 |
| Strengthening / weakening | Independent of the strength score, driven by persisted score deltas + rejection quality |
| Volume profile | POC / developing POC / VAH / VAL / HVN / LVN, labelled **ESTIMATED** when OHLCV-derived |
| Futures intelligence | Basis, OI change, volume change, long buildup / short buildup / short covering / long unwinding (aggregate read only) |
| Options chain | Full CE/PE chain per expiry from `/v2/option/chain` with OI, volume, bid/ask, Greeks, IV |
| OI intelligence | Current totals, rolling 5m/15m changes, session-cumulative change from persisted snapshots |
| Greeks | Consumed exactly as delivered by Upstox (source `UPSTOX`); never calculated, never fabricated |
| Bid/ask intelligence | Spread, spread %, mid, displayed bid/ask quantity imbalance when available |
| Strike momentum | Premium momentum, relative volume, OI change, Greeks per strike, CE/PE rankings |
| Best strike finder | ATM derived from listed strikes; ATM/ITM/OTM compared; best CALL and best PUT ranked with reasons + rejections |
| Trade finder | Setup score + contract suitability score + evidence coverage → CALL BUY / PUT BUY / **NO TRADE** |
| Trade monitoring | WATCHLIST → WAITING_FOR_ENTRY → ENTRY_TRIGGERED → ACTIVE → TARGET/STOP states, MISSED/EXPIRED |
| Historical replay | Candle-by-candle replay with strict look-ahead protection and outcome measurement |
| Alerts | 24 event types, deduplicated in PostgreSQL |
| Data quality | Per-module LIVE / PARTIAL / STALE / UNAVAILABLE / INVALID / DISCONNECTED with freshness tracking |

## 2. Quick start

```bash
npm install
cp .env.example .env            # set DATABASE_URL
npx drizzle-kit push            # create tables
npm run dev                     # http://localhost:3000
```

Then open **Settings → Upstox Session**, paste your Upstox access token and press **Connect**.
The token is validated against `/v2/profile/profile` and kept **only in backend runtime memory**.

Without a token every module reports `UNAVAILABLE`, no recommendation is produced, and the UI
clearly states that live verification is **PENDING**.

### Production

```bash
npm run build
npm run start
```

`render.yaml` is included for one-click Render deployment (web service + managed PostgreSQL).

## 3. Upstox endpoints used

| Purpose | Endpoint |
| --- | --- |
| Token validation | `GET /v2/profile/profile` |
| Spot / futures quotes & depth | `GET /v2/market-quote/quotes` |
| Historical candles | `GET /v3/historical-candle/{key}/{unit}/{interval}/{to}/{from}` (fallback `GET /v2/historical-candle/...`) |
| Intraday candles | `GET /v3/historical-candle/intraday/{key}/{unit}/{interval}` |
| Option expiries | `GET /v2/option/expiry` |
| Option contracts (lot size / symbol mapping) | `GET /v2/option/contract` |
| Option chain + Greeks | `GET /v2/option/chain` |
| Market status | `GET /v2/market/status` |
| Instrument master | `https://assets.upstox.com/market-quote/instruments/exchange/{NSE|BSE|NSE_FO|BSE_FO}.json.gz` |

Transport hardening: global token-bucket rate limiter, per-endpoint minimum spacing,
exponential backoff with jitter, retry-after support, circuit breaker, request timeouts.

## 4. Why the terminal might show no data

Open the **Diagnostics** tab (or `GET /api/diagnostics?symbol=NIFTY`). It calls every official
Upstox endpoint independently and reports the exact result, HTTP status, latency, a response
sample and a concrete fix. It also lists per-endpoint circuit-breaker state and the most recent
failures.

| Conclusion | Meaning |
| --- | --- |
| `NO_DATA_BECAUSE_NO_TOKEN` | No token in backend memory — connect in Settings |
| `NO_DATA_BECAUSE_MARKET_DATA_CALLS_FAILED` | Spot and candle endpoints are failing (see the failing row) |
| `PARTIAL_DATA_SOME_CALLS_FAILED` | Some optional endpoint failed; the rest of the pipeline still runs |
| `DATA_AVAILABLE` | Every Upstox endpoint responded |

Most common causes:

1. **No token connected** — every module correctly reports UNAVAILABLE; nothing is simulated.
2. **Token expired** — Upstox access tokens expire daily at ~03:30 IST; `profile` shows HTTP 401/403.
3. **Market closed** — quotes still return the last traded price; `intraday_candles_v3` may be empty, but historical candles still drive zones.
4. **Rate limiting** — the transport retries with exponential backoff; lower `UPSTOX_MAX_RPS` if it recurs.
5. **Outbound HTTPS blocked** — every row reports `DISCONNECTED`.

A red banner also appears on the dashboard whenever candle data is absent, listing the degraded
modules and their reasons, with a button that jumps straight to Diagnostics.

## 5. Testing

```bash
npx tsx --test tests/*.test.ts
```

25 tests cover: candle validation (invalid OHLC, duplicates, negative volume), aggregation and
forming-candle labelling, the irregular **25,770 support / 25,842 resistance** requirement,
clustering of compatible reactions (and refusal to merge unrelated levels), distinct
Immediate/Primary selection, OI-only provenance, strengthening vs weakening, failed vs confirmed
breakout, breakdown risk, quote-depth handling without fabrication, ATM detection from listed
strikes, CE/PE/expiry mapping, rolling 5m/15m and session-cumulative OI changes, missing-Greeks
handling, ATM/ITM/OTM ranking, illiquidity and spread rejection, CALL BUY / PUT BUY generation,
NO TRADE on missing or conflicting evidence, late-entry flagging, and score-weight consistency.

Test fixtures are synthetic candles built **inside the test suite only** — the application runtime
never generates, simulates or hardcodes market data.

## 6. Known data-availability limits (Upstox)

* Index spot has **no traded volume** → spot volume is `UNAVAILABLE`; volume profile derived from another series is labelled `ESTIMATED`.
* `/v2/option/chain` exposes **best bid/ask price + quantity (D0 level) only** → multi-level depth imbalance is `NOT AVAILABLE`.
* No public trade-level execution feed → **CVD, footprint delta, executed volume delta, confirmed absorption and aggressor identification are NOT AVAILABLE** and never simulated.
* No historical option-chain / Greeks snapshots → replay leaves options modules `UNAVAILABLE` rather than inventing history.
* Greeks are consumed as delivered (`source: UPSTOX`); no local pricing model is used.

## 7. Stack deviation

* **Backend**: Next.js Route Handlers (Node runtime) instead of FastAPI. All engine code is framework-agnostic TypeScript under `src/lib/engine/**` and can be lifted into a FastAPI service unchanged in behaviour.
* **Frontend**: React 19 + TypeScript bundled by Next.js instead of Vite; Tailwind CSS 4; TradingView Lightweight Charts v5.
* **Database**: PostgreSQL with Drizzle ORM and schema push (`npx drizzle-kit push`).
* **Streaming**: live updates are produced by rate-limited polling of official Upstox REST endpoints. The protobuf market-data WebSocket is **not implemented** in this build (documented limitation, not a silent substitution).
* `requirements.txt` is therefore not applicable; dependencies are declared in `package.json`.

## 8. Live verification status

| Item | Status |
| --- | --- |
| Engines, scoring, zone lifecycle, NO TRADE gating, OI maths, strike selection | **Verified by 25 passing tests** |
| Upstox authentication, spot, candles, futures, option chain, Greeks | **Code complete — live verification PENDING** (no Upstox token / active session available in this environment) |
| Replay on real historical candles | **Code complete — PENDING** (requires a connected session) |
| Deployment | `render.yaml` provided; build/start/health-check verified locally via `npm run build` + `/api/health` |
