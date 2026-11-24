export type SymbolKey = "NIFTY" | "SENSEX";

export interface SymbolConfig {
  key: SymbolKey;
  label: string;
  /**
   * Canonical index instrument key used for EVERY API call (quote, candles,
   * option contract, option chain). Verified against the instrument master at
   * runtime by resolveIndexInstrument().
   */
  indexKey: string;
  /**
   * Alternate key spellings to try if the canonical key returns no quote entry.
   * Upstox has published both "BSE_INDEX|SENSEX" (instrument master) and
   * "BSE_INDEX|Sensex" (some doc examples); we probe in order and use what works.
   */
  alternateIndexKeys: string[];
  indexName: string;
  quoteCode: string;
  exchange: "NSE" | "BSE";
  derivativesExchange: "NSE_FO" | "BSE_FO";
  /** Exact underlying_symbol used to match futures/options in the instrument master. */
  underlyingName: string;
  sessionOpen: string;
  sessionClose: string;
}

export const SYMBOL_CONFIGS: Record<SymbolKey, SymbolConfig> = {
  NIFTY: {
    key: "NIFTY",
    label: "NIFTY 50",
    indexKey: "NSE_INDEX|Nifty 50",
    alternateIndexKeys: ["NSE_INDEX|Nifty 50"],
    indexName: "Nifty 50",
    quoteCode: "NSE_INDEX:Nifty 50",
    exchange: "NSE",
    derivativesExchange: "NSE_FO",
    underlyingName: "NIFTY",
    sessionOpen: "09:15",
    sessionClose: "15:30",
  },
  SENSEX: {
    key: "SENSEX",
    label: "SENSEX",
    // Verified against the Upstox instrument master: the BSE SENSEX index row is
    //   { instrument_key: "BSE_INDEX|SENSEX", trading_symbol: "SENSEX", segment: "BSE_INDEX" }
    // "BSE_INDEX|Sensex" appears in some documentation examples and is kept as a fallback.
    indexKey: "BSE_INDEX|SENSEX",
    alternateIndexKeys: ["BSE_INDEX|SENSEX", "BSE_INDEX|Sensex"],
    indexName: "BSE SENSEX",
    quoteCode: "BSE_INDEX:Sensex",
    exchange: "BSE",
    derivativesExchange: "BSE_FO",
    underlyingName: "SENSEX",
    sessionOpen: "09:15",
    sessionClose: "15:30",
  },
};

export const SYMBOL_KEYS: SymbolKey[] = ["NIFTY", "SENSEX"];

export const TIMEFRAMES = ["1m", "2m", "5m", "15m", "30m", "1h"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const PRIMARY_TIMEFRAME: Timeframe = "5m";

export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  "1m": 1,
  "2m": 2,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
};

export interface ScoringWeights {
  zone: {
    priceStructure: number;
    reaction: number;
    volumeProfile: number;
    oiConfluence: number;
    futures: number;
    quotes: number;
    liquiditySession: number;
  };
  setup: {
    spotStructure: number;
    srBehaviour: number;
    futures: number;
    oiChange: number;
    premiumMomentum: number;
    contextVolatility: number;
  };
  suitability: {
    delta: number;
    premiumMomentum: number;
    volume: number;
    spreadLiquidity: number;
    oi: number;
    gamma: number;
    thetaCost: number;
    ivVega: number;
  };
  thresholds: {
    minSetupScore: number;
    minSuitabilityScore: number;
    minEvidenceCoverage: number;
    maxSpreadPct: number;
    minOptionVolume: number;
  };
}

/** Execution Quality Score weights. Sum = 100. Separate from Greeks and directional scores. */
export const EXECUTION_WEIGHTS = {
  volume: 30,
  relativeVolume: 10,
  spread: 30,
  bidAskQuantities: 15,
  quoteFreshness: 15,
} as const;

export const EXECUTION_THRESHOLDS = {
  /** Maximum acceptable spread as a percentage of mid. */
  maxSpreadPct: 1.5,
  /** Minimum cumulative session volume for a contract to be considered executable. */
  minVolume: 5000,
  /** Maximum age of the quote before it is considered stale (ms). */
  maxQuoteAgeMs: 120000,
} as const;

export const DEFAULT_WEIGHTS: ScoringWeights = {
  zone: {
    priceStructure: 25,
    reaction: 20,
    volumeProfile: 15,
    oiConfluence: 15,
    futures: 10,
    quotes: 10,
    liquiditySession: 5,
  },
  setup: {
    spotStructure: 25,
    srBehaviour: 20,
    futures: 10,
    oiChange: 20,
    premiumMomentum: 15,
    contextVolatility: 10,
  },
  suitability: {
    delta: 20,
    premiumMomentum: 20,
    volume: 15,
    spreadLiquidity: 15,
    oi: 10,
    gamma: 5,
    thetaCost: 10,
    ivVega: 5,
  },
  thresholds: {
    minSetupScore: 62,
    minSuitabilityScore: 60,
    minEvidenceCoverage: 0.55,
    maxSpreadPct: 1.5,
    minOptionVolume: 5000,
  },
};
