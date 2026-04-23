// Business hours calculator — Europe/Berlin timezone
// Working days: Monday through Saturday (Sun=off)
// Working hours: 09:00–18:00 Berlin local time (= 32 400 s/day)
//
// Verified against integrator SLA data (§4 of docs/mysql-analytics.md):
//   Lead created Sat 22:58 → first call Mon 09:11 ≈ 660s business (11 min on Mon)
//   Lead created Fri 18:15 → first call Mon 09:11 ≈ 32 400s (one full Sat workday)

const TZ = "Europe/Berlin";
const WORK_START = 9 * 3600;  // 09:00:00 in seconds
const WORK_END = 18 * 3600;   // 18:00:00 in seconds

function berlinSecondOfDay(d: Date): number {
  const p = new Intl.DateTimeFormat("en", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const n = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return n("hour") * 3600 + n("minute") * 60 + n("second");
}

function berlinYMD(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function berlinIsWorkday(d: Date): boolean {
  const w = new Intl.DateTimeFormat("en", {
    timeZone: TZ,
    weekday: "long",
  }).format(d);
  return w !== "Sunday";
}

/**
 * Returns business-hours seconds between two UTC dates.
 * Counts Mon–Sat 09:00–18:00 Berlin time. Sunday is always off.
 */
export function businessHoursSeconds(startUtc: Date, endUtc: Date): number {
  if (endUtc <= startUtc) return 0;

  const startYMD = berlinYMD(startUtc);
  const endYMD = berlinYMD(endUtc);

  let total = 0;
  let cur = new Date(startUtc);
  let lastDay = "";
  let guard = 500;

  while (guard-- > 0) {
    const dayYMD = berlinYMD(cur);
    if (dayYMD > endYMD) break;

    if (dayYMD !== lastDay) {
      lastDay = dayYMD;

      if (berlinIsWorkday(cur)) {
        const lo = dayYMD === startYMD ? berlinSecondOfDay(startUtc) : 0;
        const hi = dayYMD === endYMD ? berlinSecondOfDay(endUtc) : 86400;
        const s = Math.max(lo, WORK_START);
        const e = Math.min(hi, WORK_END);
        if (s < e) total += e - s;
      }
    }

    // Advance ~24 UTC hours — safe for Berlin DST (transitions happen at 02:00/03:00,
    // well inside the 24h window, never skipping or double-counting a workday)
    cur = new Date(cur.getTime() + 24 * 3600 * 1000);
  }

  return total;
}

/** Same but counts ALL calendar seconds (for sla_first_call_calendar_seconds) */
export function calendarSeconds(startUtc: Date, endUtc: Date): number {
  return Math.max(0, Math.floor((endUtc.getTime() - startUtc.getTime()) / 1000));
}

/**
 * Returns the UTC timestamp of 09:00 Berlin time on the Berlin calendar date of `d`.
 * Handles DST automatically (CEST=UTC+2 in summer, CET=UTC+1 in winter).
 * Used as the "shift start" reference point for SLA-from-shift calculation.
 */
export function shiftStartUtc(d: Date): Date {
  const ymd = berlinYMD(d); // "YYYY-MM-DD" in Berlin time
  // Probe UTC hours 6..9 — one of these will be 09:00 Berlin regardless of DST
  for (const utcH of [6, 7, 8, 9]) {
    const candidate = new Date(`${ymd}T${String(utcH).padStart(2, "0")}:00:00Z`);
    if (berlinSecondOfDay(candidate) === 9 * 3600) return candidate;
  }
  return new Date(`${ymd}T07:00:00Z`); // fallback (CEST)
}

/**
 * Seconds from 09:00 Berlin on the day of firstCallAt to firstCallAt.
 * Shows how deep into the workday the first call happened — resets to 09:00 each day.
 * Returns 0 if the call was made before 09:00 Berlin (e.g., from a previous shift).
 */
export function secondsFromShiftStart(firstCallAt: Date): number {
  const shift = shiftStartUtc(firstCallAt);
  return Math.max(0, Math.floor((firstCallAt.getTime() - shift.getTime()) / 1000));
}
