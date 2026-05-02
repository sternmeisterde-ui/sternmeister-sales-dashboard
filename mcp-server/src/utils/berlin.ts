/**
 * Berlin civil-day boundaries — done in Postgres via AT TIME ZONE so the
 * IANA tzdata handles DST automatically (Europe/Berlin = +01:00 winter,
 * +02:00 summer).
 *
 * Usage in domain handlers:
 *
 *   import { berlinDayRange, berlinDayBoundaryHalfOpen } from "../../utils/berlin.js";
 *   const range = berlinDayBoundaryHalfOpen(from, to); // sql fragments
 *   ... .where(and(
 *     gte(callCreatedAt, range.fromExpr),
 *     lt(callCreatedAt, range.toExclusiveExpr),
 *   ))
 *
 * Why not JS-side TZ math:
 *   The previous `new Date('${date}T00:00:00+01:00')` helper was off by an
 *   hour during CEST (March-October). Pushing the boundary computation to
 *   Postgres lets the canonical IANA tz database do the conversion at
 *   query time — no zoneinfo dependency in the Node process.
 */

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

// 'Europe/Berlin' embedded as a SQL literal everywhere — the Neon HTTP
// driver does not accept bound parameters in AT TIME ZONE position
// (Postgres syntax requires text/expr but the prepared-statement plan
// rejects parameter substitution there). The string is pinned and never
// taken from user input, so a literal is safe.
const TZ_LITERAL = "'Europe/Berlin'";

export interface BerlinRange {
  /** Inclusive lower bound (00:00 Berlin, converted to UTC). */
  fromExpr: SQL<unknown>;
  /** EXCLUSIVE upper bound (00:00 of to+1, converted to UTC). Half-open. */
  toExclusiveExpr: SQL<unknown>;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build a half-open `[from, to+1day)` Berlin-civil-day range as Postgres
 * SQL fragments. Use these in `gte(col, fromExpr)` + `lt(col, toExclusiveExpr)`.
 *
 * `from` and `to` MUST be ISO date strings (`YYYY-MM-DD`); the validation
 * is paranoid because they're inlined as parameters and a malformed string
 * would crash with an opaque cast error.
 */
export function berlinDayBoundaryHalfOpen(
  from: string,
  to: string,
): BerlinRange {
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
    throw new Error(`berlinDayBoundaryHalfOpen: bad ISO date (from=${from}, to=${to})`);
  }
  return {
    fromExpr: sql.raw(`('${from}'::date::timestamp AT TIME ZONE ${TZ_LITERAL})`),
    toExclusiveExpr: sql.raw(`(('${to}'::date + 1)::timestamp AT TIME ZONE ${TZ_LITERAL})`),
  };
}

/**
 * Wrap a TIMESTAMPTZ column in `AT TIME ZONE 'Europe/Berlin'` for use as
 * the date_trunc argument. Ensures bucketing is done in Berlin civil time,
 * not UTC.
 */
export function berlinDateTruncExpr(
  groupBy: "day" | "week" | "month",
  col: SQL<unknown> | unknown,
): SQL<unknown> {
  // Belt-and-suspenders enum check: even though caller's Zod parses this,
  // pin a whitelist here so a future refactor that bypasses Zod can't
  // inject SQL via group_by.
  if (groupBy !== "day" && groupBy !== "week" && groupBy !== "month") {
    throw new Error(`invalid group_by: ${groupBy}`);
  }
  return sql`date_trunc(${sql.raw(`'${groupBy}'`)}, (${col}) AT TIME ZONE ${sql.raw(TZ_LITERAL)})`;
}
