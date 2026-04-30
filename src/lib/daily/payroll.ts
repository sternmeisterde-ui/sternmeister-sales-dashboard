// End-of-month payroll calculator.
//
// Joins master_managers with manager_schedule for a given month, applies the
// per-status payroll factors (see schedule-payroll.ts), and produces one row
// per manager. Pure compute — does not read or write payroll_runs. The API
// layer is responsible for persistence.
//
// Caller passes period as 'YYYY-MM' string; we operate in calendar-day terms
// (the schedule table stores YYYY-MM-DD strings, no TZ math needed here).

import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { masterManagers, managerSchedule } from "@/lib/db/schema-existing";
import { SCHEDULE_STATUSES, payrollFactorFor, type ScheduleCode } from "./schedule-payroll";

export interface PayrollRow {
  userId: string;
  managerName: string;
  department: "b2g" | "b2b";
  dailyRate: number | null;          // null = rate not set yet
  statusBreakdown: Record<string, number>;
  equivFullDays: number;             // Σ (count × payrollFactor)
  grossAmount: number;               // equivFullDays × dailyRate (0 if rate is null)
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Returns first/last day of a YYYY-MM month as YYYY-MM-DD strings. */
function monthBounds(periodMonth: string): { from: string; to: string } {
  const [yStr, mStr] = periodMonth.split("-");
  const y = Number.parseInt(yStr, 10);
  const m = Number.parseInt(mStr, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    throw new Error(`Invalid periodMonth: ${periodMonth} (expected YYYY-MM)`);
  }
  // Last day of month: day 0 of next month.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${yStr}-${pad2(m)}-01`, to: `${yStr}-${pad2(m)}-${pad2(last)}` };
}

/**
 * Compute payroll rows for a given (department, month). Active managers only.
 * Returns one row per manager — even those with zero scheduled days, so the
 * caller can show the full team and decide whether to drop empty rows.
 */
export async function computePayroll(
  department: "b2g" | "b2b",
  periodMonth: string,
): Promise<PayrollRow[]> {
  const { from, to } = monthBounds(periodMonth);

  const managers = await db
    .select({
      id: masterManagers.id,
      name: masterManagers.name,
      dailyRate: masterManagers.dailyRate,
    })
    .from(masterManagers)
    .where(
      and(
        eq(masterManagers.department, department),
        eq(masterManagers.isActive, true),
      ),
    )
    .orderBy(masterManagers.name);

  if (managers.length === 0) return [];

  const scheduleRows = await db
    .select({
      userId: managerSchedule.userId,
      scheduleValue: managerSchedule.scheduleValue,
    })
    .from(managerSchedule)
    .where(
      and(
        gte(managerSchedule.scheduleDate, from),
        lte(managerSchedule.scheduleDate, to),
      ),
    );

  // userId → { code: count }
  const breakdownByUser = new Map<string, Record<string, number>>();
  for (const s of SCHEDULE_STATUSES) {
    // Pre-seed empty maps so every known code shows up in the output even at 0.
    // (Done lazily below per-user — this just documents the codes.)
    void s;
  }

  for (const row of scheduleRows) {
    const code = (row.scheduleValue ?? "").trim();
    if (!code) continue;
    let bucket = breakdownByUser.get(row.userId);
    if (!bucket) {
      bucket = {};
      breakdownByUser.set(row.userId, bucket);
    }
    bucket[code] = (bucket[code] ?? 0) + 1;
  }

  return managers.map((m): PayrollRow => {
    const breakdown = breakdownByUser.get(m.id) ?? {};
    let equivFullDays = 0;
    for (const [code, count] of Object.entries(breakdown)) {
      equivFullDays += count * payrollFactorFor(code as ScheduleCode);
    }
    // Round equiv days to 2 decimals to keep it tidy ("0.5 + 0.5 + 1 = 2.00").
    equivFullDays = Math.round(equivFullDays * 100) / 100;

    const rate = m.dailyRate !== null ? Number.parseFloat(m.dailyRate) : null;
    const gross = rate !== null && Number.isFinite(rate)
      ? Math.round(equivFullDays * rate * 100) / 100
      : 0;

    return {
      userId: m.id,
      managerName: m.name,
      department,
      dailyRate: rate,
      statusBreakdown: breakdown,
      equivFullDays,
      grossAmount: gross,
    };
  });
}

/**
 * Default period for cron runs: the calendar month that just closed in
 * Europe/Berlin. Called on or after the 1st of the new month → returns
 * previous month. Called on the 1st itself → also returns previous month.
 */
export function previousMonthBerlin(now: Date = new Date()): string {
  // Anchor on Berlin local components so a UTC-midnight-1st cron run still
  // resolves to the right period when Berlin is already in the new month.
  const berlinNow = new Date(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(now).replace(
      /(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+):(\d+)/,
      "$3-$1-$2T$4:$5:$6",
    ),
  );
  const y = berlinNow.getUTCFullYear();
  const m = berlinNow.getUTCMonth();   // 0-based
  // m=0 (January) → previous = December of y-1
  const prevY = m === 0 ? y - 1 : y;
  const prevM = m === 0 ? 12 : m;      // already 1-based for previous
  return `${prevY}-${pad2(prevM)}`;
}
