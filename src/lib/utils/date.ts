/**
 * Timezone & date utilities — single source of truth.
 *
 * The business operates in Europe/Berlin, so every display, every query
 * boundary, and every URL date string resolves against that zone. Storage is
 * always UTC; this module converts between UTC and Berlin wall-clock.
 *
 * DST is handled correctly in parseDateBoundary via two-pass convergence,
 * so the CET↔CEST transition never shifts a "start of day" boundary by ±1h.
 *
 * Override with env APP_TIMEZONE only if you're sure — mixing zones across
 * the app is the original bug we fixed, not a feature.
 */

export const APP_TZ = process.env.APP_TIMEZONE ?? "Europe/Berlin";

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
export function tzOffsetMinutes(instant: Date, tz: string = APP_TZ): number {
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
 * Format a Date as "YYYY-MM-DD" in the app's business timezone (APP_TZ =
 * Berlin by default). Used for URL query params (e.g. ?from=2026-04-21).
 *
 * Deliberately NOT using the browser's local zone: a user in Moscow clicking
 * "today" should see the same day boundary the back-end uses for Berlin-time
 * filtering. Otherwise a 23:30 Moscow call (which is 21:30 Berlin and the
 * same Berlin day as a 00:05 Berlin call) can land on the wrong day in the
 * picker. Single-zone policy, no exceptions.
 */
export function fmtLocalDate(d: Date): string {
  // en-CA yields "YYYY-MM-DD" — intentional; ru-RU would give "DD.MM.YYYY".
  return d.toLocaleDateString("en-CA", { timeZone: APP_TZ });
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
 * Example: parseDateBoundary("2026-04-21", "start") in Europe/Berlin
 * returns the UTC instant 2026-04-20T22:00:00Z (= 2026-04-21 00:00 CEST).
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

// ─── Civil-date arithmetic ────────────────────────────────────────
//
// "Civil" = the YYYY-MM-DD label as humans use it, with no zone attached.
// We do day arithmetic on those strings via a UTC pivot so the math is
// timezone-free; the conversion to actual UTC instants happens via
// `parseDateBoundary` at the SQL boundary. Centralised here so dashboard,
// tracking, analytics, and ETL routes don't each carry their own copy.

/** Today's civil date (YYYY-MM-DD) in APP_TZ. The only "today" the dashboard
 *  cares about — using server UTC default would shift to yesterday in the
 *  ~2h after Berlin midnight (e.g. 00:30 Berlin Apr 29 = 22:30 UTC Apr 28). */
export function todayCivil(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: APP_TZ });
}

/** Add `n` civil days to "YYYY-MM-DD". TZ-free: uses Date.UTC purely as a
 *  Gregorian calendar pivot, never as an instant. The output is independent
 *  of process timezone or DST. */
export function addDaysCivil(dateStr: string, n: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) throw new Error(`Bad civil date: ${dateStr}`);
  const [, y, m, d] = match;
  const t = Date.UTC(Number(y), Number(m) - 1, Number(d)) + n * 86_400_000;
  const o = new Date(t);
  const yy = o.getUTCFullYear().toString().padStart(4, "0");
  const mm = (o.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = o.getUTCDate().toString().padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** UTC Date instant for 00:00 Berlin of `civilStr`. The single safe way to
 *  build a "this civil day" Date in client code: `new Date(y, m, d)` is
 *  browser-local-midnight (off by ±1–2 h in non-Berlin browsers), and the
 *  picker would silently send the wrong civil day to the API after going
 *  through fmtLocalDate. */
export function berlinCivilDate(civilStr: string): Date {
  const d = parseDateBoundary(civilStr, "start");
  if (!d) throw new Error(`Bad civil date: ${civilStr}`);
  return d;
}

/** "Today" as a UTC instant representing 00:00 Berlin of today's Berlin civil
 *  date. Use this anywhere the picker / page wants a Date object for the
 *  current day — never `new Date()` + setHours(0). */
export function todayBerlinDate(): Date {
  return berlinCivilDate(todayCivil());
}

/** End-of-day in Berlin for the civil day that `d` falls in (UTC instant for
 *  23:59:59.999 Berlin). Use this in place of `d.setHours(23,59,59,999)`
 *  whenever the intent is "the last millisecond of this Berlin day" —
 *  setHours uses browser-local midnight which drifts by ±1–2h in non-Berlin
 *  browsers. */
export function endOfBerlinDay(d: Date): Date {
  const civil = d.toLocaleDateString("en-CA", { timeZone: APP_TZ });
  const end = parseDateBoundary(civil, "end");
  if (!end) throw new Error(`Bad civil date from instant: ${civil}`);
  return end;
}

/** Start-of-day in Berlin for the civil day that `d` falls in. Mirror of
 *  endOfBerlinDay. */
export function startOfBerlinDay(d: Date): Date {
  const civil = d.toLocaleDateString("en-CA", { timeZone: APP_TZ });
  const start = parseDateBoundary(civil, "start");
  if (!start) throw new Error(`Bad civil date from instant: ${civil}`);
  return start;
}

/** Berlin civil components (y/m/d) of any UTC instant. Useful when you need
 *  to compare two Date objects "do they represent the same Berlin civil day"
 *  without relying on browser-local getters. */
export function berlinCivilComponents(d: Date): { y: number; m: number; d: number } {
  const civil = d.toLocaleDateString("en-CA", { timeZone: APP_TZ });
  return {
    y: Number(civil.slice(0, 4)),
    m: Number(civil.slice(5, 7)),
    d: Number(civil.slice(8, 10)),
  };
}

/** Civil-date difference in days (a − b). Positive when a > b. */
export function diffDaysCivil(a: string, b: string): number {
  const ma = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  const mb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  if (!ma || !mb) throw new Error(`Bad civil date: ${a} or ${b}`);
  const ua = Date.UTC(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3]));
  const ub = Date.UTC(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]));
  return Math.round((ua - ub) / 86_400_000);
}
