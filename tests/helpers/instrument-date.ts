/**
 * Test-only mirror of the instrument-master expiry conversion.
 * The master publishes `expiry` as epoch milliseconds; this asserts the conversion
 * handles every observed shape and never fabricates a date.
 */
export function toIsoDateFix(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  }
  if (typeof value === "string") {
    if (!value) return null;
    if (/^\d{10,13}$/.test(value)) {
      const num = Number(value);
      const ms = num < 1e12 ? num * 1000 : num;
      const d = new Date(ms);
      return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}
