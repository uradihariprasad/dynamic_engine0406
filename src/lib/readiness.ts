/**
 * Centralized data-readiness evaluator.
 *
 * The pipeline runs engines ONLY when their prerequisite source data has been
 * fetched, validated and (where required) persisted. A module is never executed
 * against missing or invalid records, and never reports a fabricated result just
 * to fill the screen.
 *
 * Dependency matrix (module → required source data):
 *   OPTION_CHAIN         → valid underlying key + expiry + contract chain rows
 *   GREEKS               → option contracts + actual Greeks in the chain response
 *   OI_INTELLIGENCE      → current chain OI (+ persisted observations for rolling windows)
 *   STRIKE_MOMENTUM      → chain quotes + historical premium/OI observations
 *   BEST_STRIKE_FINDER   → chain + liquidity + momentum inputs + underlying spot
 *   FUTURES              → resolved futures contract + quote
 *   FUTURES_POSITIONING  → futures quote + comparable reference snapshot
 *   TRADE_FINDER         → underlying spot + candles + S/R + futures + options + suitability
 */

export type ReadinessState =
  | "NOT_STARTED"
  | "FETCHING"
  | "VALIDATING"
  | "READY"
  | "PARTIAL"
  | "WAITING_FOR_HISTORY"
  | "BLOCKED"
  | "FAILED"
  | "STALE";

export const READINESS_MODULE = [
  "OPTION_CHAIN",
  "GREEKS",
  "OI_INTELLIGENCE",
  "STRIKE_MOMENTUM",
  "BEST_STRIKE_FINDER",
  "FUTURES",
  "FUTURES_POSITIONING",
  "TRADE_FINDER",
] as const;

export type ReadinessModule = (typeof READINESS_MODULE)[number];

export interface ReadinessEvaluation {
  module: ReadinessModule;
  state: ReadinessState;
  /** True only when the engine may run. */
  ready: boolean;
  /** Prerequisites that are satisfied. */
  present: string[];
  /** Prerequisites that are missing. */
  missing: string[];
  /** History-dependent items still accumulating. */
  pendingHistory: string[];
  /** Human-readable explanation shown in the UI. */
  reason: string;
  /** Actionable next step when not ready. */
  action: string | null;
}

export interface ReadinessInputs {
  sessionConnected: boolean;
  spot: { status: string; ltp: number | null; prevClose: number | null };
  candles: { status: string; count: number; lastTs: string | null; stale: boolean };
  structureOk: boolean;
  levelsOk: boolean;
  /** Verified underlying instrument key. */
  instrumentKey: string | null;
  /** Expiry selected from documented contract discovery. */
  expiry: string | null;
  /** Contract rows returned by expiry discovery. */
  contractRowCount: number;
  /** Validated option-chain strikes. */
  chainStrikes: number;
  /** Strikes carrying at least one tradable price. */
  chainPricedStrikes: number;
  chainMessage: string | null;
  /** Greeks availability per contract (not all-or-nothing). */
  greeksAvailable: boolean;
  greeksCoveragePct: number | null;
  /** Persisted OI/premium observations. */
  oiPersistenceOk: boolean;
  oiPersistenceError: string | null;
  oiSnapshotCount: number;
  oldestOiAt: string | null;
  has5mHistory: boolean;
  has15mHistory: boolean;
  hasBaseline: boolean;
  /** Futures. */
  futuresResolved: boolean;
  futuresLtp: number | null;
  futuresOi: number | null;
  futuresMessage: string | null;
  futuresReferenceAgeMinutes: number | null;
  futuresObservationCount: number;
  futuresPersistenceOk: boolean;
  futuresPersistenceError: string | null;
  /** Contract suitability inputs. */
  liquidityOk: boolean;
  spreadOk: boolean;
  bestCallAvailable: boolean;
  bestPutAvailable: boolean;
}

function evaluation(
  module: ReadinessModule,
  state: ReadinessState,
  present: string[],
  missing: string[],
  pendingHistory: string[],
  reason: string,
  action: string | null = null,
): ReadinessEvaluation {
  return {
    module,
    state,
    ready: state === "READY" || state === "PARTIAL",
    present,
    missing,
    pendingHistory,
    reason,
    action,
  };
}

const HISTORY_ACTION = "Snapshots accumulate automatically each cycle. Keep the app running; 5-minute values appear after ~5 minutes of observations, 15-minute after ~15 minutes.";

export function evaluateReadiness(i: ReadinessInputs): Record<ReadinessModule, ReadinessEvaluation> {
  const notConnected = !i.sessionConnected;

  /* ---------------- OPTION CHAIN ---------------- */
  const chainPresent: string[] = [];
  const chainMissing: string[] = [];
  if (i.sessionConnected) chainPresent.push("Upstox session");
  else chainMissing.push("Upstox session");
  if (i.instrumentKey) chainPresent.push("verified underlying instrument key");
  else chainMissing.push("verified underlying instrument key");
  if (i.expiry) chainPresent.push("selected expiry");
  else chainMissing.push("selected expiry (from GET /v2/option/contract)");
  if (i.chainStrikes > 0) chainPresent.push(`option chain rows (${i.chainStrikes})`);
  else chainMissing.push("option chain rows");
  if (i.chainPricedStrikes > 0) chainPresent.push(`priced contracts (${i.chainPricedStrikes})`);
  else chainMissing.push("at least one priced contract");

  const optionChain = notConnected
    ? evaluation("OPTION_CHAIN", "BLOCKED", chainPresent, chainMissing, [], "Requires a connected Upstox session.", "Connect an Upstox token in Settings.")
    : !i.instrumentKey
      ? evaluation("OPTION_CHAIN", "BLOCKED", chainPresent, chainMissing, [], "Underlying instrument key could not be verified against the instrument master.", "Check the instrument resolution diagnostic for this symbol.")
      : !i.expiry
        ? evaluation("OPTION_CHAIN", "BLOCKED", chainPresent, chainMissing, [], i.chainMessage ?? "No expiry could be selected from contract discovery.", i.chainMessage ? "Inspect the option_contract_discovery diagnostic row." : null)
        : i.chainStrikes === 0
          ? evaluation("OPTION_CHAIN", "FAILED", chainPresent, chainMissing, [], i.chainMessage ?? "Option chain returned no strike rows.", "Inspect the option_chain diagnostic row for the HTTP status and error code.")
          : i.chainPricedStrikes === 0
            ? evaluation("OPTION_CHAIN", "VALIDATING", chainPresent, chainMissing, [], `${i.chainStrikes} rows returned but none carry a tradable price — the chain is not usable for analysis.`)
            : chainMissing.length === 0
              ? evaluation("OPTION_CHAIN", "READY", chainPresent, [], [], `${i.chainStrikes} strikes validated for expiry ${i.expiry}.`)
              : evaluation("OPTION_CHAIN", "PARTIAL", chainPresent, chainMissing, [], `${i.chainStrikes} strikes available with ${chainMissing.length} gap(s).`);

  /* ---------------- GREEKS ---------------- */
  const greeksMissing: string[] = [];
  if (optionChain.ready) greeksMissing.push("");
  const greeksReady = i.chainStrikes > 0 && i.greeksAvailable;
  const greeks = notConnected
    ? evaluation("GREEKS", "BLOCKED", ["Upstox session"], ["Upstox session"], [], "Requires a connected Upstox session.", "Connect an Upstox token in Settings.")
    : !optionChain.ready
      ? evaluation("GREEKS", "BLOCKED", [], ["valid option chain"], [], "Greeks are read from the option-chain response, which is not ready.", optionChain.action)
      : greeksReady
        ? evaluation("GREEKS", i.greeksCoveragePct !== null && i.greeksCoveragePct < 100 ? "PARTIAL" : "READY", ["option contracts", "option_greeks in chain response"], [], [], `Greeks available for ${i.greeksCoveragePct === null ? "?" : Math.round(i.greeksCoveragePct)}% of contracts. Partial availability is preserved per contract — missing fields are shown as unavailable, never estimated.`)
        : evaluation("GREEKS", "PARTIAL", ["option contracts", "LTP / OI / bid-ask from chain"], ["option_greeks values in the chain response"], [], `Upstox returned valid chain data for ${i.chainStrikes} strikes but no usable Greeks. Option data is displayed; Greeks are explicitly unavailable and are NOT estimated.`, "Verify the option_chain diagnostic sample to confirm which fields Upstox returned.");

  /* ---------------- OI INTELLIGENCE ---------------- */
  const oiPending: string[] = [];
  if (!i.has5mHistory) oiPending.push("5-minute rolling OI change");
  if (!i.has15mHistory) oiPending.push("15-minute rolling OI change");
  if (!i.hasBaseline) oiPending.push("session baseline");
  const oiReady = i.chainStrikes > 0;
  const oiPersistenceProblem = !i.oiPersistenceOk && i.chainStrikes > 0;
  const oi = notConnected
    ? evaluation("OI_INTELLIGENCE", "BLOCKED", [], ["option chain", "snapshot persistence"], [], "Requires a connected Upstox session.", "Connect an Upstox token in Settings.")
    : !optionChain.ready
      ? evaluation("OI_INTELLIGENCE", "BLOCKED", [], ["valid option chain"], [], "OI intelligence derives from option-chain rows, which are not ready.", optionChain.action)
      : oiPersistenceProblem
        ? evaluation("OI_INTELLIGENCE", "FAILED", ["option chain"], ["snapshot persistence"], oiPending, `Live OI is displayed but persistence FAILED: ${i.oiPersistenceError ?? "unknown database error"}. Rolling OI comparisons cannot work without stored observations.`, "Check PostgreSQL connectivity, then verify the oi_snapshot table exists (npx drizzle-kit push).")
        : evaluation(
            "OI_INTELLIGENCE",
            oiReady && i.oiSnapshotCount > 0 ? (oiPending.length === 0 ? "READY" : "PARTIAL") : oiReady ? "PARTIAL" : "BLOCKED",
            oiReady ? ["current chain OI", "source-provided change in OI"] : [],
            oiReady ? [] : ["current chain OI"],
            oiPending,
            oiReady
              ? i.oiSnapshotCount > 0
                ? `Current OI displayed. ${i.oiSnapshotCount} observations stored${i.oldestOiAt ? ` since ${i.oldestOiAt}` : ""}. ${oiPending.length === 0 ? "All rolling windows available." : `Pending: ${oiPending.join(", ")}.`}`
                : "Current OI displayed from the live chain. Snapshot collection has just started, so rolling windows are pending."
              : "No chain OI available.",
            oiPending.length > 0 ? HISTORY_ACTION : null,
          );

  /* ---------------- STRIKE MOMENTUM ---------------- */
  const momentumPending: string[] = [];
  if (!i.has5mHistory) momentumPending.push("5-minute premium momentum");
  if (!i.has15mHistory) momentumPending.push("15-minute premium momentum");
  const momentum = notConnected
    ? evaluation("STRIKE_MOMENTUM", "BLOCKED", [], ["option chain quotes", "premium observations"], [], "Requires a connected Upstox session.", "Connect an Upstox token in Settings.")
    : !optionChain.ready
      ? evaluation("STRIKE_MOMENTUM", "BLOCKED", [], ["option chain quotes"], [], "Strike momentum requires validated option-chain quotes.", optionChain.action)
      : evaluation(
          "STRIKE_MOMENTUM",
          i.oiSnapshotCount > 0 ? (momentumPending.length === 0 ? "READY" : "PARTIAL") : "PARTIAL",
          ["current LTP per contract", "previous close", "volume", "OI", "bid/ask spread", "Greeks where supplied"],
          [],
          momentumPending,
          i.oiSnapshotCount > 0
            ? `Rankings use current quotes plus ${i.oiSnapshotCount} stored observations. ${momentumPending.length === 0 ? "Full momentum windows available." : `Pending: ${momentumPending.join(", ")}.`}`
            : "Rankings use current quotes (premium change vs previous close, volume, OI change, spread, Greeks). Historical momentum windows are pending while observations accumulate.",
          momentumPending.length > 0 ? HISTORY_ACTION : null,
        );

  /* ---------------- BEST STRIKE FINDER ---------------- */
  const finderMissing: string[] = [];
  if (!i.spot.ltp) finderMissing.push("underlying spot");
  if (!optionChain.ready) finderMissing.push("option chain");
  if (!i.liquidityOk) finderMissing.push("contracts passing the liquidity gate");
  if (!i.spreadOk) finderMissing.push("contracts passing the spread gate");
  const finder = notConnected
    ? evaluation("BEST_STRIKE_FINDER", "BLOCKED", [], ["underlying spot", "option chain", "liquidity"], [], "Requires a connected Upstox session.", "Connect an Upstox token in Settings.")
    : finderMissing.length === 0
      ? evaluation("BEST_STRIKE_FINDER", "READY", ["underlying spot", "option chain", "liquidity gate", "spread gate", "Greeks where supplied"], [], [], "ATM/ITM/OTM candidates compared on delta, premium momentum, liquidity, spread, OI, gamma, theta cost and IV.")
      : evaluation("BEST_STRIKE_FINDER", "BLOCKED", finderMissing.length < 4 ? ["upstream data present"] : [], finderMissing, [], `Best-strike selection cannot run: missing ${finderMissing.join(", ")}.`, optionChain.action);

  /* ---------------- FUTURES ---------------- */
  const futures = notConnected
    ? evaluation("FUTURES", "BLOCKED", [], ["futures contract", "futures quote"], [], "Requires a connected Upstox session.", "Connect an Upstox token in Settings.")
    : !i.futuresResolved
      ? evaluation("FUTURES", "FAILED", ["instrument master"], ["resolved futures contract"], [], i.futuresMessage ?? "No futures contract resolved from the instrument master.", "Check the futures_resolution diagnostic row for the exact reason.")
      : i.futuresLtp === null
        ? evaluation("FUTURES", "FAILED", ["resolved futures contract"], ["futures quote"], [], i.futuresMessage ?? "Futures contract resolved but no quote returned.", "Check the futures_quote diagnostic row.")
        : evaluation(
            "FUTURES",
            i.futuresOi === null ? "PARTIAL" : "READY",
            ["resolved contract", "quote LTP"],
            i.futuresOi === null ? ["open interest"] : [],
            [],
            i.futuresOi === null
              ? "LTP, volume and basis are displayed. Open interest was not supplied by Upstox for this contract, so OI-dependent classification is unavailable."
              : "Contract, quote, OI and basis validated.",
          );

  /* ---------------- FUTURES POSITIONING ---------------- */
  const positioning = notConnected
    ? evaluation("FUTURES_POSITIONING", "BLOCKED", [], ["futures quote", "reference snapshot"], [], "Requires a connected Upstox session.", "Connect an Upstox token in Settings.")
    : !futures.ready
      ? evaluation("FUTURES_POSITIONING", "BLOCKED", [], ["valid futures quote"], [], "Positioning requires a validated futures quote.", futures.action)
      : !i.futuresPersistenceOk && i.futuresObservationCount === 0
        ? evaluation("FUTURES_POSITIONING", "FAILED", ["futures quote"], ["futures snapshot persistence"], [], `Futures snapshot persistence FAILED: ${i.futuresPersistenceError ?? "unknown database error"}.`, "Check PostgreSQL connectivity, then verify the futures_snapshot table exists.")
        : i.futuresReferenceAgeMinutes === null
          ? evaluation(
              "FUTURES_POSITIONING",
              "WAITING_FOR_HISTORY",
              ["futures quote", "snapshot collection running"],
              ["comparable ~5-minute reference snapshot"],
              ["long/short buildup classification"],
              `LTP, OI, volume and basis are displayed. Positioning classification needs a reference observation for the SAME contract; ${i.futuresObservationCount} stored so far and the closest is older than the 8-minute tolerance.`,
              HISTORY_ACTION,
            )
          : evaluation("FUTURES_POSITIONING", "READY", ["futures quote", `reference snapshot (${i.futuresReferenceAgeMinutes}m old)`], [], [], `Price and OI changes compared against a ${i.futuresReferenceAgeMinutes}-minute-old snapshot of the same contract.`);

  /* ---------------- TRADE FINDER ---------------- */
  const tradeMissing: string[] = [];
  if (!i.spot.ltp) tradeMissing.push("underlying spot");
  if (i.candles.count === 0) tradeMissing.push("underlying candles");
  if (i.candles.stale) tradeMissing.push("fresh candles (current data is stale)");
  if (!i.structureOk) tradeMissing.push("market structure");
  if (!i.levelsOk) tradeMissing.push("dynamic support/resistance levels");
  if (!i.futuresResolved) tradeMissing.push("futures data");
  if (!optionChain.ready) tradeMissing.push("option chain");
  if (!i.bestCallAvailable && !i.bestPutAvailable) tradeMissing.push("at least one contract passing liquidity and spread gates");
  const trade = notConnected
    ? evaluation("TRADE_FINDER", "BLOCKED", [], tradeMissing, [], "Requires a connected Upstox session.", "Connect an Upstox token in Settings.")
    : tradeMissing.length === 0
      ? evaluation("TRADE_FINDER", "READY", ["underlying spot", "candles", "market structure", "S/R levels", "futures", "option chain", "contract liquidity"], [], [], "All prerequisites satisfied — directional setup score, contract suitability score and evidence coverage are computed independently, and NO TRADE is produced whenever evidence conflicts or is insufficient.")
      : evaluation(
          "TRADE_FINDER",
          tradeMissing.length >= 5 ? "BLOCKED" : "PARTIAL",
          tradeMissing.length < 7 ? ["partial upstream data present"] : [],
          tradeMissing,
          [],
          `Trade recommendations are gated: missing ${tradeMissing.join(", ")}. NO TRADE is reported rather than a forced recommendation.`,
          optionChain.action,
        );

  return { OPTION_CHAIN: optionChain, GREEKS: greeks, OI_INTELLIGENCE: oi, STRIKE_MOMENTUM: momentum, BEST_STRIKE_FINDER: finder, FUTURES: futures, FUTURES_POSITIONING: positioning, TRADE_FINDER: trade };
}

export function readinessSummary(evals: Record<ReadinessModule, ReadinessEvaluation>): { ready: number; total: number; blocked: number; waitingForHistory: number; failed: number } {
  const all = Object.values(evals);
  return {
    ready: all.filter((e) => e.state === "READY" || e.state === "PARTIAL").length,
    total: all.length,
    blocked: all.filter((e) => e.state === "BLOCKED").length,
    waitingForHistory: all.filter((e) => e.state === "WAITING_FOR_HISTORY").length,
    failed: all.filter((e) => e.state === "FAILED").length,
  };
}
