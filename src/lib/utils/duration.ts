// Shared duration formatter for per-lead drill rows in the Termin tab.
//
// Aggregates (chart lines, tiles) keep decimal-day precision because the
// AVG would lose accuracy if rounded per-row. But for a SINGLE deal,
// "20.8 дн" reads as nonsense — there's no fractional day for one lead;
// the .8 is the hours portion. This helper renders the same value as
// "20 дн 19 ч" so the user sees what's actually happening.

/**
 * Format a duration expressed in fractional days as a Russian
 * human-readable string. Hour-precision; minutes are not displayed.
 *
 * Examples:
 *   0.5    → "12 ч"
 *   1.0    → "1 дн"
 *   1.5    → "1 дн 12 ч"
 *   20.83  → "20 дн 20 ч"
 *   null   → "—"
 */
export function formatDaysDuration(days: number | null | undefined): string {
  if (days == null) return "—";

  const totalHours = Math.round(days * 24);
  if (totalHours <= 0) return "<1 ч";

  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;

  if (d === 0) return `${h} ч`;
  if (h === 0) return `${d} дн`;
  return `${d} дн ${h} ч`;
}
