/**
 * Canonical option-contract identity.
 *
 * Every Greeks, participation and quote-pressure result is keyed by this string so
 * that observations from different strikes, sides, expiries or underlyings can never
 * be combined. `instrumentKey` is included because two contracts can share a strike
 * and side across different expiries.
 */
export function contractIdentityKey(args: {
  symbol: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  instrumentKey: string | null;
}): string {
  return `${args.symbol}|${args.expiry}|${args.strike}|${args.optionType}|${args.instrumentKey ?? "unknown"}`;
}
