/**
 * Test-only mirrors of the quote-response key normalisation used in
 * src/lib/upstox/market.ts. Keeping them here lets us assert the matching rules
 * without making a network call.
 */

export function normalizeKeyTestHelper(k: string): string {
  return k.replace(/\|/g, ":").replace(/\s+/g, " ").trim().toUpperCase();
}

export function pickEntryTestHelper(
  map: Record<string, Record<string, unknown>>,
  key: string,
): Record<string, unknown> | null {
  const wanted = normalizeKeyTestHelper(key);
  for (const [k, v] of Object.entries(map)) {
    if (normalizeKeyTestHelper(k) === wanted) return v;
  }
  return null;
}
