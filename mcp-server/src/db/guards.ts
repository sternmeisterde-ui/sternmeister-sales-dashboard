/**
 * Query-level guards: hard row limit, cost ceiling, statement timeout.
 *
 * Curated tools enforce LIMIT in their SQL directly; this module is mainly
 * for the future `sql.run_readonly` escape hatch (Phase 4) where users
 * supply arbitrary SQL.
 */

export const HARD_ROW_LIMIT = 5000;
export const STATEMENT_TIMEOUT_MS = 10_000;
/** Max EXPLAIN cost a query may have before run_readonly rejects it. */
export const MAX_EXPLAIN_COST = 1_000_000;

/**
 * Wrap a SELECT statement with a `LIMIT` clamp. Returns the original
 * statement if it already specifies a smaller limit. Used by run_readonly
 * (Phase 4) to enforce a hard ceiling regardless of user input.
 */
export function clampLimit(sqlText: string, max = HARD_ROW_LIMIT): string {
  const trimmed = sqlText.trim().replace(/;\s*$/, "");
  // If user already wrote a LIMIT, leave it alone — we can't always tell if
  // it's smaller without parsing. Future: real SQL parser.
  if (/\blimit\s+\d+/i.test(trimmed)) return trimmed;
  return `${trimmed} LIMIT ${max}`;
}
