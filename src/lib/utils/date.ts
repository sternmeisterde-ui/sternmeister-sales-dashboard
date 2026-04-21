/**
 * Timezone & date utilities — single source of truth.
 *
 * Previously 4 different copies of formatDate were spread across API routes
 * and one used a hardcoded `+02:00` Berlin offset (which silently breaks at
 * the CET↔CEST transition) while another used `new Date(y, m-1, d)` which
 * resolves to the *server's* local TZ (= UTC on Dokploy).
 *
 * Now everything flows through this module. Storage is always UTC. Display
 * and "start of day" query boundaries go through APP_TZ (default
 * Europe/Moscow — no DST, safe for arithmetic).
 */

export const APP_TZ = process.env.APP_TIMEZONE ?? "Europe/Moscow";

// ─── Display formatting ────────────────────────────────────────────

/**
 * Format a Date as "Сегодня, HH:mm" / "Вчера, HH:mm" / "DD.MM, HH:mm",
 * using APP_TZ for every comparison so it doesn't matter whether the
 * server is UTC or the user's browser is in Kaliningrad.
 */
export function formatCallDate(date: Date | null | undefined): string {
  if (!date) return "—";
  const callDate = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(callDate.getTime())) return "—";

  const now = new Date();
  const nowKey = now.toLocaleDateString("en-CA", { timeZone: APP_TZ });
  const callKey = callDate.toLocaleDateString("en-CA", { timeZone: APP_TZ });

  const hhmm = callDate.toLocaleString("ru-RU", {
    timeZone: APP_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  if (callKey === nowKey) return `Сегодня, ${hhmm}`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = yesterday.toLocaleDateString("en-CA", { timeZone: APP_TZ });
  if (callKey === yesterdayKey) return `Вчера, ${hhmm}`;

  const day = callDate.toLocaleString("ru-RU", { timeZone: APP_TZ, day: "2-digit" });
  const month = callDate.toLocaleString("ru-RU", { timeZone: APP_TZ, month: "2-digit" });
  return `${day}.${month}, ${hhmm}`;
}

// ─── Query boundary parsing ────────────────────────────────────────

/**
 * Compute the UTC-offset (in minutes) a given instant has in a given IANA TZ.
 * Works correctly through DST transitions because it asks Intl for the
 * wall-clock breakdown of that instant.
 */
function tzOffsetMinutes(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const p: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") p[part.type] = part.value;
  const asIfUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  // Round to the nearest minute: real TZ offsets are always whole minutes,
  // and Intl truncates sub-second precision, so a raw divide can come back
  // as 179.98 instead of 180 and cascade into ±1 s errors downstream.
  return Math.round((asIfUtc - instant.getTime()) / 60_000);
}

// ─── Client-side helpers ───────────────────────────────────────────

/**
 * Format a Date as "YYYY-MM-DD" in the browser's local timezone.
 * Used for URL query params (e.g. ?from=2026-04-21) — do NOT use for
 * anything user-facing. The caller is responsible for choosing local vs. UTC:
 * this uses local to match whatever the browser's calendar picker showed.
 */
export function fmtLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse the display strings produced by formatCallDate ("Сегодня, 14:30",
 * "Вчера, 09:15", "03.04, 11:00") BACK into an approximate Date — purely for
 * client-side sort/filter. This is fragile (round-trip parsing of a human
 * string), and it's marked as legacy: API responses should include an ISO
 * field alongside the display string so clients never need this. Until that
 * migration lands, use this single implementation instead of redefining it
 * in every component.
 */
export function parseDisplayDate(dateStr: string): Date {
  const now = new Date();
  if (dateStr.startsWith("Сегодня")) return now;
  if (dateStr.startsWith("Вчера")) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  }
  const match = dateStr.match(/(\d{2})\.(\d{2})/);
  if (match) {
    const day = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10) - 1;
    return new Date(now.getFullYear(), month, day);
  }
  return now;
}

/**
 * Parse "YYYY-MM-DD" as a moment in APP_TZ (start or end of that local day)
 * and return the corresponding UTC Date.
 *
 * Example: parseDateBoundary("2026-04-21", "start") in Europe/Moscow
 * returns the UTC instant 2026-04-20T21:00:00Z (= 2026-04-21 00:00 MSK).
 *
 * Returns null if the input isn't a valid date string — callers should treat
 * this the same as "no filter."
 */
export function parseDateBoundary(
  yyyyMmDd: string,
  kind: "start" | "end",
): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m) - 1;
  const day = Number(d);

  const [h, mi, s, ms] = kind === "start" ? [0, 0, 0, 0] : [23, 59, 59, 999];
  // Classic two-pass convergence for zoned→UTC: first guess uses the
  // wall-clock-as-UTC offset, then recompute the offset at that candidate
  // instant to correct across DST transitions. Two passes is enough for any
  // civilian timezone (DST changes of up to ±2 h).
  const wallAsUtc = Date.UTC(year, month, day, h, mi, s, ms);
  const firstGuess = new Date(wallAsUtc);
  const firstOffset = tzOffsetMinutes(firstGuess, APP_TZ);
  const secondGuess = new Date(wallAsUtc - firstOffset * 60_000);
  const secondOffset = tzOffsetMinutes(secondGuess, APP_TZ);
  const utcMs = wallAsUtc - secondOffset * 60_000;
  const result = new Date(utcMs);
  return Number.isNaN(result.getTime()) ? null : result;
}
