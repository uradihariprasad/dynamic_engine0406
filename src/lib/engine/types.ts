export type DataStatus = "LIVE" | "PARTIAL" | "STALE" | "UNAVAILABLE" | "INVALID" | "DISCONNECTED";

export type ZoneKind = "support" | "resistance";

export type ZoneStatus =
  | "CANDIDATE"
  | "VALIDATED"
  | "ACTIVE"
  | "STRENGTHENING"
  | "WEAKENING"
  | "BREAKOUT_RISK"
  | "BREAKDOWN_RISK"
  | "BROKEN"
  | "INVALIDATED"
  | "ROLE_REVERSAL_CANDIDATE"
  | "EXPIRED";

export type StrengthClass = "VERY_STRONG" | "STRONG" | "MODERATE" | "WEAK" | "VERY_WEAK";

export type TrendState = "BULLISH" | "BEARISH" | "SIDEWAYS" | "UNCLEAR";

export interface Evidence {
  available: string[];
  missing: string[];
  contradictory: string[];
  /** Available evidence weight / total configured weight (0..1). */
  coverage: number;
  /** Per-component 0..1 quality for available components, null when unavailable. */
  components: Record<string, number | null>;
  sourceReliability: number;
}

export type ZoneSourceKind =
  | "SWING_LOW"
  | "SWING_HIGH"
  | "WICK_REJECTION_LOW"
  | "WICK_REJECTION_HIGH"
  | "BODY_REJECTION"
  | "CONSOLIDATION_BOUNDARY"
  | "FAILED_BREAKOUT"
  | "FAILED_BREAKDOWN"
  | "PRIOR_SESSION_HIGH"
  | "PRIOR_SESSION_LOW"
  | "PRIOR_CLOSE"
  | "OPENING_RANGE_HIGH"
  | "OPENING_RANGE_LOW"
  | "VOLUME_NODE"
  | "OI_CLUSTER"
  | "BREAKOUT_LEVEL"
  | "BREAKDOWN_LEVEL"
  | "SESSION_HIGH"
  | "SESSION_LOW";

export interface ZoneSource {
  kind: ZoneSourceKind;
  price: number;
  timeframe: string;
  ts: number;
  weight: number;
  note: string;
}

export interface Zone {
  id: string;
  symbol: string;
  kind: ZoneKind;
  lower: number;
  upper: number;
  center: number;
  width: number;
  widthPct: number;
  score: number;
  prevScore: number | null;
  scoreChange5m: number | null;
  scoreChange15m: number | null;
  classification: StrengthClass;
  status: ZoneStatus;
  statusReason: string;
  tests: number;
  createdAt: number;
  lastTestedAt: number | null;
  sources: ZoneSource[];
  evidence: Evidence;
  timeframeConfluence: string[];
  oiOnly: boolean;
  scoreHistory: Array<{ t: number; score: number }>;
}

export interface SrLevelSelection {
  role: "IMMEDIATE_SUPPORT" | "PRIMARY_SUPPORT" | "IMMEDIATE_RESISTANCE" | "PRIMARY_RESISTANCE";
  zone: Zone;
  distanceFromSpot: number;
  reason: string;
}

export interface SrLevels {
  immediateSupport: SrLevelSelection | null;
  primarySupport: SrLevelSelection | null;
  immediateResistance: SrLevelSelection | null;
  primaryResistance: SrLevelSelection | null;
  unavailable: string[];
}

export interface Pivot {
  ts: number;
  price: number;
  type: "HIGH" | "LOW";
  index: number;
  confirmedBy: number;
}

export interface StructureEvent {
  ts: number;
  type: "BOS" | "CHoCH" | "RETEST" | "FAILED_BREAKOUT" | "FAILED_BREAKDOWN" | "BREAKOUT" | "BREAKDOWN" | "REVERSAL";
  direction: "BULLISH" | "BEARISH";
  level: number;
  detail: string;
  confirmed: boolean;
}

export interface MarketStructure {
  status: DataStatus;
  message: string;
  trend: TrendState;
  htfTrend: TrendState;
  ltfTrend: TrendState;
  swingHighs: Pivot[];
  swingLows: Pivot[];
  highs: { rising: boolean | null; label: "HH" | "LH" | "EQH" };
  lows: { rising: boolean | null; label: "HL" | "LL" | "EQL" };
  events: StructureEvent[];
  lastHigh: number | null;
  lastLow: number | null;
  rangeHigh: number | null;
  rangeLow: number | null;
  structureBiasScore: number | null;
  explanation: string[];
}

export interface VolumeProfileResult {
  status: DataStatus;
  message: string;
  estimated: boolean;
  poc: number | null;
  vah: number | null;
  val: number | null;
  developingPoc: number | null;
  hvn: number[];
  lvn: number[];
  valueAreaVolumePct: number | null;
  concentration: number | null;
  migration: "UP" | "DOWN" | "STABLE" | null;
}

export interface SessionLevels {
  prevDayHigh: number | null;
  prevDayLow: number | null;
  prevClose: number | null;
  prevWeekHigh: number | null;
  prevWeekLow: number | null;
  openingRangeHigh: number | null;
  openingRangeLow: number | null;
  sessionHigh: number | null;
  sessionLow: number | null;
  vwap: number | null;
  vwapStatus: "VALID" | "ESTIMATED" | "UNAVAILABLE";
}

export interface AtrInfo {
  value: number | null;
  timeframe: string;
  period: number;
  status: DataStatus;
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  volumeStatus: "VALID" | "UNAVAILABLE";
  complete: boolean;
  forming: boolean;
}

export interface FuturesIntel {
  status: DataStatus;
  message: string;
  instrumentKey: string | null;
  tradingSymbol: string | null;
  expiry: string | null;
  lotSize: number | null;
  ltp: number | null;
  spot: number | null;
  basis: number | null;
  basisPct: number | null;
  volume: number | null;
  oi: number | null;
  changeInOi: number | null;
  changeInOiPct: number | null;
  priceChange: number | null;
  volumeChange: number | null;
  classification: "LONG_BUILDUP" | "SHORT_BUILDUP" | "SHORT_COVERING" | "LONG_UNWINDING" | "NEUTRAL" | "UNAVAILABLE";
  interpretation: string[];
  participation: "NOT_INFERRED" | null;
  /** Structured persistence result for the latest futures snapshot write. */
  futuresPersist?: StorageResultView;
  /** Observations stored for this contract+expiry. */
  futuresObservationCount?: number;
  /** True when no comparable reference snapshot exists yet. */
  referencePending?: boolean;
}

import type { GreeksAssessment } from "@/lib/engine/greeks";
import type { BuyerSellerResult, ParticipationResult, QuotePressureResult } from "@/lib/engine/participation";

export interface OptionLegIntel {
  optionType: "CE" | "PE";
  instrumentKey: string | null;
  ltp: number | null;
  prevClose: number | null;
  premiumChange: number | null;
  premiumChangePct: number | null;
  /** Direction of premium movement — never collapsed into an absolute value. */
  premiumMomentumDirection?: "RISING" | "FALLING" | "FLAT" | "UNAVAILABLE";
  /** |% change| magnitude, separate from direction. */
  momentumStrength?: number | null;
  /** Signed momentum quality: positive = moving in the favourable direction. */
  momentumQuality?: number | null;
  momentum1m?: number | null;
  momentum5m?: number | null;
  momentum15m?: number | null;
  /** Layer A — Greeks sensitivity/risk assessment. */
  greeksAssessment?: GreeksAssessment;
  /** Layer B — premium/OI/volume participation pattern. */
  participation?: ParticipationResult;
  /** Layer B2 — buyer/seller participation label. */
  buyerSeller?: BuyerSellerResult;
  /** Layer C — displayed bid/ask quote pressure. */
  quotePressure?: QuotePressureResult;
  volume: number | null;
  oi: number | null;
  prevOi: number | null;
  sessionOiChange: number | null;
  changeInOi: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  bidQty: number | null;
  askQty: number | null;
  spread: number | null;
  spreadPct: number | null;
  mid: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  ivChange: number | null;
  momentumScore: number | null;
  relativeVolume: number | null;
  participationRead: string;
  tradingSymbol: string | null;
  lotSize: number | null;
}

export interface StrikeIntel {
  strike: number;
  atmDistance: number;
  isAtm: boolean;
  ce: OptionLegIntel;
  pe: OptionLegIntel;
  oiConcentrationShare: number | null;
  clusterLabel: "BULLISH_CLUSTER" | "BEARISH_CLUSTER" | "BALANCED" | null;
}

export interface OiIntel {
  status: DataStatus;
  message: string;
  totalCeOi: number | null;
  totalPeOi: number | null;
  combinedOi: number | null;
  pcr: number | null;
  pcrBasis: string;
  ce5mChange: number | null;
  pe5mChange: number | null;
  ce15mChange: number | null;
  pe15mChange: number | null;
  ceSessionChange: number | null;
  peSessionChange: number | null;
  snapshotCount: number;
  oldestSnapshotAt: string | null;
  baselineAt: string | null;
  oiClusters: Array<{ strike: number; side: "CE" | "PE"; oi: number; share: number; kind: string }>;
  additions: Array<{ strike: number; side: "CE" | "PE"; change: number; window: string }>;
  reductions: Array<{ strike: number; side: "CE" | "PE"; change: number; window: string }>;
  interpretation: string[];
  greeksAvailable: boolean;
  bidAskQtyAvailable: boolean;
}

export interface ContractCandidate {
  strike: number;
  optionType: "CE" | "PE";
  classification: "ATM" | "ITM" | "OTM";
  atmDistance: number;
  leg: OptionLegIntel;
  /** LEGACY combined score retained for backwards compatibility. */
  suitabilityScore: number | null;
  coverage: number;
  components: Record<string, number | null>;
  reasons: string[];
  rejections: string[];
  risks: string[];
  tradable: boolean;
  /** B — Greeks Suitability Score: contract sensitivity and risk (0..100). */
  greeksSuitabilityScore: number | null;
  greeksSuitabilityClass: string | null;
  greeksCoverage: number | null;
  /** C — Execution Quality Score: can this contract be entered and exited (0..100). */
  executionQualityScore: number | null;
  executionCoverage: number | null;
  executionComponents: Record<string, number | null>;
  /** Composite ranking that preserves all three separate scores. */
  compositeScore: number | null;
  /** B2 — OI Participation Score: does OI behaviour support this directional trade (0..100). */
  oiParticipationScore: number | null;
  oiParticipationAlignment: "SUPPORTIVE" | "NEUTRAL" | "CONTRADICTORY" | "UNAVAILABLE" | null;
  oiParticipationReasons: string[];
  /** Composite ranking that includes OI participation (A/B2/B/C preserved separately). */
  compositeWithOiScore: number | null;
  /** Mandatory conditions that failed — non-empty means the candidate is ineligible. */
  disqualifications: string[];
}

export interface StrikeSelection {
  status: DataStatus;
  message: string;
  spot: number | null;
  atmStrike: number | null;
  expiry: string | null;
  bestCall: ContractCandidate | null;
  bestPut: ContractCandidate | null;
  alternatives: ContractCandidate[];
  rationale: string[];
}

export interface TradePlan {
  action: "CALL_BUY" | "PUT_BUY" | "NO_TRADE";
  direction: "bullish" | "bearish" | "neutral";
  status: DataStatus;
  headline: string;
  setupScore: number | null;
  setupCoverage: number;
  setupComponents: Record<string, number | null>;
  entryTrigger: string;
  entryLow: number | null;
  entryHigh: number | null;
  entryState: "READY" | "WAIT_FOR_RETEST" | "MISSED_ENTRY" | "NOT_APPLICABLE";
  stopLoss: number | null;
  stopBasis: string;
  target1: number | null;
  target2: number | null;
  targetBasis: string;
  riskReward: number | null;
  invalidation: string[];
  conditionsMet: string[];
  conditionsFailed: string[];
  spotAtSignal: number | null;
  premium: number | null;
  contract: ContractCandidate | null;
  noTradeReasons: string[];
  updatedAt: string;
}

export interface ScenarioIntel {
  name: "BULLISH" | "BEARISH" | "CONSOLIDATION";
  likelihoodScore: number | null;
  coverage: number;
  conditions: string[];
  supporting: string[];
  contradictory: string[];
  trigger: string;
  invalidation: string;
  zones: string[];
}

export interface DataQualityEntry {
  module: string;
  status: DataStatus;
  message: string;
  freshnessMs: number | null;
  lastUpdate: string | null;
  sourceTs: string | null;
  receivedAt: string | null;
}

export interface DataQualityReport {
  overall: DataStatus;
  entries: DataQualityEntry[];
  notes: string[];
  connected: boolean;
}

export interface TradeInputs {
  spot: number | null;
  structure: MarketStructure;
  zones: Zone[];
  levels: SrLevels;
  futures: FuturesIntel;
  oi: OiIntel;
  selection: {
    bestCall: ContractCandidate | null;
    bestPut: ContractCandidate | null;
    atmStrike: number | null;
    expiry: string | null;
  };
  momentum: {
    lastClose: number | null;
    change5m: number | null;
    change15m: number | null;
    bias: "BULLISH" | "BEARISH" | "NEUTRAL";
    strength: number | null;
  };
  atrValue: number | null;
  volumeProfile: VolumeProfileResult;
  chainStatus: DataStatus;
  greeksAvailable: boolean;
  bidAskQtyAvailable: boolean;
  candlesStatus: DataStatus;
  now: number;
}

export interface ReadinessEvaluationView {
  module: string;
  state: "NOT_STARTED" | "FETCHING" | "VALIDATING" | "READY" | "PARTIAL" | "WAITING_FOR_HISTORY" | "BLOCKED" | "FAILED" | "STALE";
  ready: boolean;
  present: string[];
  missing: string[];
  pendingHistory: string[];
  reason: string;
  action: string | null;
}

export interface StorageResultView {
  ok: boolean;
  operation: string;
  table: string;
  symbol: string | null;
  expiry: string | null;
  recordCount: number;
  error: string | null;
  durationMs: number;
  at: string;
  skipped: boolean;
  skipReason: string | null;
}

export interface DataFoundationView {
  /** Overall verdict for this symbol's data foundation. */
  verdict: "READY" | "PARTIAL" | "BLOCKED" | "FAILED";
  reason: string;
  /** Per-module readiness evaluations in dependency order. */
  modules: ReadinessEvaluationView[];
  /** Structured persistence results from the latest cycle. */
  storage: StorageResultView[];
  /** Counts used by diagnostics. */
  counts: {
    oiSnapshotCount: number;
    oldestOiAt: string | null;
    newestOiAt: string | null;
    distinctOiObservations: number;
    premiumObservationCount: number;
    futuresObservationCount: number;
    oiReadOk: boolean;
    oiReadError: string | null;
    chainStrikes: number;
    chainPricedStrikes: number;
    contractRowCount: number;
    expiryCount: number;
    greeksCoveragePct: number | null;
  };
}

export type OiWindowAvailability = "AVAILABLE" | "WAITING_FOR_HISTORY" | "INSUFFICIENT_DATA";

export interface OiParticipationView {
  pattern: string;
  premiumDirection: string;
  oiDirection: string;
  oiMagnitude: string;
  oiBasis: { value: number | null; pct: number | null; window: string; source: string };
  premiumBasis: { value: number | null; pct: number | null; window: string; source: string };
  volumeConfirms: boolean | null;
  volumeReason: string;
  confidence: string;
  evidenceCoverage: number;
  present: string[];
  missing: string[];
  interpretation: string;
  caveat: string;
}

export interface ContractOiMeasurementsView {
  identityKey: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  currentOi: number | null;
  previousSessionOi: number | null;
  changeInOi: number | null;
  changeInOiPct: number | null;
  sourceProvidedChange: number | null;
  hasSourceProvidedChange: boolean;
  discrepancyNote: string | null;
  sessionBaselineOi: number | null;
  sessionBaselineAt: string | null;
  sessionCumulativeChange: number | null;
  sessionCumulativeChangePct: number | null;
  combinedTotalOi: number | null;
  windows: Record<"m1" | "m5" | "m15", { change: number | null; pct: number | null; referenceAt: string | null; referenceOi: number | null; availability: OiWindowAvailability; ageMinutes: number | null }>;
  observationCount: number;
  oldestObservationAt: string | null;
  newestObservationAt: string | null;
  stale: boolean;
  unavailableReasons: string[];
}

export interface StrikeOiRowView {
  strike: number;
  isAtm: boolean;
  ce: ContractOiMeasurementsView;
  pe: ContractOiMeasurementsView;
  ceParticipation: OiParticipationView | null;
  peParticipation: OiParticipationView | null;
  strikePcr: number | null;
  cluster: string;
  clusterReason: string;
}

export interface OiIntelligenceView {
  status: string;
  message: string;
  totalCeOi: number | null;
  totalPeOi: number | null;
  combinedOi: number | null;
  pcr: number | null;
  pcrChange: number | null;
  ce5mChange: number | null;
  pe5mChange: number | null;
  ce15mChange: number | null;
  pe15mChange: number | null;
  ceSessionChange: number | null;
  peSessionChange: number | null;
  ce5mPct: number | null;
  pe5mPct: number | null;
  ce15mPct: number | null;
  pe15mPct: number | null;
  windows: { m1: OiWindowAvailability; m5: OiWindowAvailability; m15: OiWindowAvailability; session: OiWindowAvailability };
  snapshotCount: number;
  distinctObservations: number;
  oldestSnapshotAt: string | null;
  newestSnapshotAt: string | null;
  baselineAt: string | null;
  rows: StrikeOiRowView[];
  highestOiStrikes: Array<{ strike: number; side: "CE" | "PE"; oi: number }>;
  largestAdditions: Array<{ strike: number; side: "CE" | "PE"; change: number; pct: number | null; window: string }>;
  largestReductions: Array<{ strike: number; side: "CE" | "PE"; change: number; pct: number | null; window: string }>;
  buildupClusters: Array<{ strike: number; side: "CE" | "PE"; change: number; pct: number | null }>;
  unwindingClusters: Array<{ strike: number; side: "CE" | "PE"; change: number; pct: number | null }>;
  freshParticipation: number;
  weakeningParticipation: number;
  interpretation: string[];
  unavailableReasons: string[];
  priceConfirmationNote: string;
}

export interface AnalysisSnapshot {
  symbol: string;
  timeframe: string;
  generatedAt: string;
  marketStatus: string | null;
  sessionConnected: boolean;
  /** Owning process id — surfaces session consistency in diagnostics. */
  processId?: string;
  lastRequestAt?: string | null;
  lastError?: string | null;
  spot: {
    status: DataStatus;
    message: string;
    ltp: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    prevClose: number | null;
    change: number | null;
    pctChange: number | null;
    volume: number | null;
    volumeStatus: "VALID" | "UNAVAILABLE";
    sourceTs: string | null;
    freshnessMs: number | null;
    /** Which Upstox field supplied the previous close. */
    prevCloseSource: "prev_close_price" | "ohlc.close" | "none";
    /** Instrument key that actually produced this quote. */
    resolvedKey: string | null;
  };
  candles: {
    status: DataStatus;
    message: string;
    source: string[];
    count: number;
    formingCount: number;
    first: string | null;
    last: string | null;
    atr: AtrInfo;
  };
  chart: {
    timeframe: string;
    candles: Candle[];
    zones: Zone[];
    levels: SrLevels;
    session: SessionLevels;
    vwap: number | null;
  };
  structure: MarketStructure;
  volumeProfile: VolumeProfileResult;
  sessionLevels: SessionLevels;
  zones: Zone[];
  levels: SrLevels;
  futures: FuturesIntel;
  optionChain: {
    status: DataStatus;
    message: string;
    expiry: string | null;
    expiries: string[];
    strikes: StrikeIntel[];
    oi: OiIntel;
    spot: number | null;
  };
  greeks: {
    status: DataStatus;
    message: string;
    source: "UPSTOX" | "CALCULATED" | "UNAVAILABLE";
    distribution: {
      strike: number;
      ceDelta: number | null;
      peDelta: number | null;
      ceGamma: number | null;
      peGamma: number | null;
      ceTheta: number | null;
      peTheta: number | null;
      ceVega: number | null;
      peVega: number | null;
      ceIv: number | null;
      peIv: number | null;
    }[];
  };
  strikeMomentum: {
    status: DataStatus;
    message: string;
    ceRanked: ContractCandidate[];
    peRanked: ContractCandidate[];
  };
  selection: StrikeSelection;
  trade: TradePlan;
  scenarios: ScenarioIntel[];
  dataQuality: DataQualityReport;
  /** Data-readiness gate results + storage status. Always present. */
  dataFoundation: DataFoundationView;
  /** Dedicated Change-in-OI intelligence engine output. */
  oiIntelligence: OiIntelligenceView;
  alertsRecent: Array<{ type: string; title: string; message: string; createdAt: string; severity: string }>;
  notes: string[];
}
