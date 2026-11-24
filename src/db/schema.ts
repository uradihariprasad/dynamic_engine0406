import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * DYNAMIC ENGINE persistence layer.
 *
 * SECURITY: the Upstox access token is NEVER stored in plaintext anywhere.
 * A session record stores only AES-256-GCM ciphertext (see src/lib/session-store.ts),
 * which requires the server-side SESSION_SECRET to decrypt. Browser storage, logs
 * and API responses never receive the token — only a masked preview.
 */

export const upstoxSessionStore = pgTable("upstox_session_store", {
  id: text("id").primaryKey(), // singleton row: "singleton"
  ciphertext: text("ciphertext").notNull(), // base64 AES-256-GCM ciphertext of the token
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  maskedToken: text("masked_token").notNull(),
  tokenFingerprint: text("token_fingerprint").notNull(), // sha256 prefix, identifies a token without revealing it
  userName: text("user_name"),
  userId: text("user_id"),
  exchanges: jsonb("exchanges"),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull(),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Rolling transport metrics for the diagnostics dashboard. */
export const apiCallLog = pgTable(
  "api_call_log",
  {
    id: serial("id").primaryKey(),
    endpoint: text("endpoint").notNull(),
    ok: integer("ok").notNull(), // 1 = ok, 0 = failure
    httpStatus: integer("http_status"),
    errorCode: text("error_code"),
    message: text("message"),
    latencyMs: integer("latency_ms"),
    recordCount: integer("record_count"),
    validation: text("validation"), // VALID | INVALID | EMPTY | PARTIAL
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_call_log_idx").on(t.createdAt)],
);

/** Cached instrument-master lookups (index key, futures, option contracts). */
export const instrumentCache = pgTable(
  "instrument_cache",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    kind: text("kind").notNull(), // index | future | option_ce | option_pe
    instrumentKey: text("instrument_key").notNull(),
    tradingSymbol: text("trading_symbol"),
    expiry: text("expiry"),
    strike: doublePrecision("strike"),
    lotSize: integer("lot_size"),
    tickSize: doublePrecision("tick_size"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("instrument_cache_unique").on(t.symbol, t.kind, t.instrumentKey, t.expiry),
    index("instrument_cache_symbol_idx").on(t.symbol),
  ],
);

/** Validated candles (history + intraday merged). */
export const candleCache = pgTable(
  "candle_cache",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    instrumentKey: text("instrument_key").notNull(),
    timeframe: text("timeframe").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: doublePrecision("volume"),
    openInterest: doublePrecision("open_interest"),
    volumeStatus: text("volume_status").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("candle_cache_unique").on(t.instrumentKey, t.timeframe, t.ts),
    index("candle_cache_symbol_idx").on(t.symbol, t.timeframe, t.ts),
  ],
);

/** Time-series OI snapshots used for rolling 5m / 15m / session-cumulative OI changes. */
export const oiSnapshot = pgTable(
  "oi_snapshot",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    expiry: text("expiry").notNull(),
    strike: doublePrecision("strike").notNull(),
    optionType: text("option_type").notNull(),
    instrumentKey: text("instrument_key").notNull(),
    oi: doublePrecision("oi"),
    prevOi: doublePrecision("prev_oi"),
    volume: doublePrecision("volume"),
    ltp: doublePrecision("ltp"),
    prevClose: doublePrecision("prev_close"),
    bidPrice: doublePrecision("bid_price"),
    askPrice: doublePrecision("ask_price"),
    bidQty: doublePrecision("bid_qty"),
    askQty: doublePrecision("ask_qty"),
    delta: doublePrecision("delta"),
    gamma: doublePrecision("gamma"),
    theta: doublePrecision("theta"),
    vega: doublePrecision("vega"),
    iv: doublePrecision("iv"),
    pop: doublePrecision("pop"),
    sourceTs: timestamp("source_ts", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("oi_snapshot_lookup_idx").on(t.symbol, t.expiry, t.strike, t.optionType, t.receivedAt),
    index("oi_snapshot_contract_idx").on(t.instrumentKey, t.receivedAt),
    index("oi_snapshot_received_idx").on(t.receivedAt),
  ],
);

/** Futures positioning snapshots. */
export const futuresSnapshot = pgTable(
  "futures_snapshot",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    expiry: text("expiry").notNull(),
    instrumentKey: text("instrument_key").notNull(),
    ltp: doublePrecision("ltp"),
    volume: doublePrecision("volume"),
    oi: doublePrecision("oi"),
    prevOi: doublePrecision("prev_oi"),
    spot: doublePrecision("spot"),
    sourceTs: timestamp("source_ts", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("futures_snapshot_lookup_idx").on(t.symbol, t.expiry, t.receivedAt)],
);

/** Dynamic S/R zone registry (structural, volume, OI provenance preserved). */
export const zoneRegistry = pgTable(
  "zone_registry",
  {
    id: text("id").primaryKey(),
    symbol: text("symbol").notNull(),
    kind: text("kind").notNull(),
    lower: doublePrecision("lower").notNull(),
    upper: doublePrecision("upper").notNull(),
    center: doublePrecision("center").notNull(),
    score: doublePrecision("score").notNull(),
    status: text("status").notNull(),
    classification: text("classification").notNull(),
    oiOnly: boolean("oi_only").notNull().default(false),
    tests: integer("tests").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull(),
  },
  (t) => [index("zone_registry_symbol_idx").on(t.symbol, t.kind, t.updatedAt)],
);

/** Zone strength history (used for 5m / 15m score deltas + strengthening/weakening). */
export const zoneScoreHistory = pgTable(
  "zone_score_history",
  {
    id: serial("id").primaryKey(),
    zoneId: text("zone_id").notNull(),
    symbol: text("symbol").notNull(),
    score: doublePrecision("score").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("zone_score_history_idx").on(t.zoneId, t.capturedAt)],
);

/** Trade recommendation history + monitoring state. */
export const recommendation = pgTable(
  "recommendation",
  {
    id: text("id").primaryKey(),
    symbol: text("symbol").notNull(),
    action: text("action").notNull(),
    direction: text("direction"),
    status: text("status").notNull(),
    optionType: text("option_type"),
    strike: doublePrecision("strike"),
    expiry: text("expiry"),
    tradingSymbol: text("trading_symbol"),
    instrumentKey: text("instrument_key"),
    spot: doublePrecision("spot"),
    premium: doublePrecision("premium"),
    entryLow: doublePrecision("entry_low"),
    entryHigh: doublePrecision("entry_high"),
    stopLoss: doublePrecision("stop_loss"),
    target1: doublePrecision("target1"),
    target2: doublePrecision("target2"),
    riskReward: doublePrecision("risk_reward"),
    setupScore: doublePrecision("setup_score"),
    suitabilityScore: doublePrecision("suitability_score"),
    evidenceCoverage: doublePrecision("evidence_coverage"),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recommendation_symbol_idx").on(t.symbol, t.createdAt)],
);

/** Deduplicated event-driven alerts. */
export const alertEvent = pgTable(
  "alert_event",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    type: text("type").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("alert_event_dedupe_idx").on(t.symbol, t.dedupeKey)],
);

/** Data-quality subsystem audit trail. */
export const dataQualityEvent = pgTable(
  "data_quality_event",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    module: text("module").notNull(),
    status: text("status").notNull(),
    message: text("message").notNull(),
    freshnessMs: bigint("freshness_ms", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("data_quality_event_idx").on(t.symbol, t.createdAt)],
);

/** Historical replay / validation runs. */
export const replayRun = pgTable("replay_run", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  tradeDate: text("trade_date").notNull(),
  timeframe: text("timeframe").notNull(),
  expiry: text("expiry"),
  metrics: jsonb("metrics").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
