# DYNAMIC ENGINE — HTTP API

Base URL: `/api`. All responses are JSON. No endpoint ever returns a fabricated market value.

## GET /api/health

Liveness probe. Verifies PostgreSQL connectivity.

```json
{ "ok": true }
```

## GET /api/session

```json
{ "connected": false, "session": { "sessionId": "", "maskedToken": "", "active": false, "userName": null } }
```

Only a masked token preview is exposed. The raw token never leaves the server process.

## POST /api/session

Body: `{ "token": "<upstox access token>" }`

Validates the token against `GET /v2/profile/profile`, then stores it in backend runtime memory.

* `200` → `{ "ok": true, "session": {...}, "message": "Token validated …" }`
* `400` → token missing / too short
* `401` → `{ "ok": false, "error": "<Upstox rejection reason>" }` (token was never persisted)

## DELETE /api/session

Clears the token and all in-memory caches. `{ "ok": true, "connected": false }`

## GET /api/analysis/{symbol}?timeframe={tf}

`symbol` ∈ `NIFTY | SENSEX`, `timeframe` ∈ `1m | 2m | 5m | 15m | 30m | 1h` (default `5m`).

Returns the full `AnalysisSnapshot` consumed by the terminal:

| Field | Contents |
| --- | --- |
| `spot` | LTP, OHLC, prev close, change, %change, volume status, source ts, freshness |
| `candles` | status, message, sources, counts, ATR |
| `chart` | candles for the chart, zones, four levels, session references, VWAP |
| `structure` | trend, HTF trend, swing labels, events (BOS/CHoCH/failed/retest), bias score |
| `volumeProfile` | POC, developing POC, VAH, VAL, HVN/LVN, concentration, migration |
| `zones` | every zone with bounds, score, classification, status, sources, evidence, score history |
| `levels` | immediate/primary support & resistance selections + explicit unavailable reasons |
| `futures` | contract, basis, OI, ΔOI, volume, classification, interpretation |
| `optionChain` | status, expiry, expiry list, strike intel array, OI intelligence |
| `greeks` | source (`UPSTOX` / `UNAVAILABLE`), strike-wise Greeks distribution |
| `strikeMomentum` | CE and PE rankings with per-contract evidence |
| `selection` | ATM, best CALL, best PUT, alternatives, rationale |
| `trade` | action, setup score, suitability, entry trigger/range/state, stop, targets, R:R, invalidation, NO TRADE reasons |
| `scenarios` | bullish / bearish / consolidation with conditions, evidence, trigger, invalidation |
| `dataQuality` | per-module status, messages, freshness, notes |
| `alertsRecent` | latest validated events |

## GET /api/zones/{zoneId}

Persisted zone detail: registry row plus the recorded strength history
(creation time, tests, evidence payload, score history).

## GET /api/alerts?symbol=NIFTY&limit=100

Deduplicated alert history from PostgreSQL.

## GET /api/replay?symbol=NIFTY&timeframe=5m&date=2026-01-15

Runs the historical replay engine for one trading day.

```json
{
  "ok": true,
  "replay": {
    "status": "PARTIAL",
    "bars": 75,
    "frames": [{ "ts": 0, "spot": 0, "trend": "BULLISH", "immediateSupport": {...}, "zones": 6 }],
    "metrics": { "zoneTouchCount": 12, "rejectionRate": 66.7, "strengthCalibrationSpread": 8.4 },
    "unavailable": ["Historical option-chain OI / Greeks / premium snapshots are not exposed by Upstox …"],
    "lookAheadGuard": "Zone/structure engines only received candles with ts <= replay step; …"
  }
}
```

## Error handling

* `400` — unsupported symbol/timeframe
* `401` — Upstox rejected the token
* `500` — `{ "ok": false, "error": "<message>" }`

Data failures inside the pipeline do **not** produce HTTP errors: the affected module is returned
with a degraded status (`PARTIAL` / `STALE` / `UNAVAILABLE` / `INVALID` / `DISCONNECTED`) so the
terminal can display exactly what is missing and why confidence is reduced.
