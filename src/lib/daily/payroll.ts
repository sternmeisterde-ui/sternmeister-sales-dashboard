// End-of-month payroll calculator.
//
// Joins master_managers with manager_schedule for a given month, applies the
// per-status payroll factors (see schedule-payroll.ts), and produces one row
// per manager. Pure compute — does not read or write payroll_runs. The API
// layer is responsible for persistence.
//
// Caller passes period as 'YYYY-MM' string; we operate in calendar-day terms
// (the schedule table stores YYYY-MM-DD strings, no TZ math needed here).

import { and, eq, gte, lte, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { masterManagers, managerSchedule, managerBonuses } from "@/lib/db/schema-existing";
import { SCHEDULE_STATUSES, payrollFactorFor, type ScheduleCode } from "./schedule-payroll";

export interface PayrollRow {
  userId: string;
  managerName: string;
  department: "b2g" | "b2b";
  dailyRate: number | null;          // null = rate not set yet
  statusBreakdown: Record<string, number>;
  equivFullDays: number;             // Σ (count × payrollFactor)
  baseAmount: number;                // equivFullDays × dailyRate (0 if rate is null)
  bonusAmount: number;               // manager_bonuses.amount for this month, 0 if none
  bonusNote: string | null;          // optional "за что"
  grossAmount: number;               // baseAmount + bonusAmount
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

  // b2b: soft-deleted (удалённые) менеджеры участвуют в расчёте — иначе
  // менеджер, удалённый 1-го числа, выпал бы из табеля за полностью
  // отработанный прошлый месяц. Ниже их строки оставляем только если в месяце
  // есть смены или премия, чтобы старые уволенные не копились в каждом табеле.
  const managerConds = [eq(masterManagers.department, department)];
  if (department !== "b2b") managerConds.push(eq(masterManagers.isActive, true));

  const managers = await db
    .select({
      id: masterManagers.id,
      name: masterManagers.name,
      dailyRate: masterManagers.dailyRate,
      isActive: masterManagers.isActive,
    })
    .from(masterManagers)
    .where(and(...managerConds))
    .orderBy(masterManagers.name);

  if (managers.length === 0) return [];
  const managerIds = managers.map((m) => m.id);

  // Filter schedule rows by manager id list — defends against cross-department
  // collisions if a manager is ever transferred (same UUID, new department),
  // and also lets Postgres skip rows from the other department's managers.
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
        inArray(managerSchedule.userId, managerIds),
      ),
    );

  // Manual monthly premiums for this period — at most one row per manager.
  const bonusRows = await db
    .select({
      userId: managerBonuses.userId,
      amount: managerBonuses.amount,
      note: managerBonuses.note,
    })
    .from(managerBonuses)
    .where(
      and(
        eq(managerBonuses.periodMonth, periodMonth),
        inArray(managerBonuses.userId, managerIds),
      ),
    );
  const bonusByUser = new Map<string, { amount: number; note: string | null }>();
  for (const b of bonusRows) {
    const n = Number.parseFloat(b.amount);
    bonusByUser.set(b.userId, {
      amount: Number.isFinite(n) ? n : 0,
      note: b.note ?? null,
    });
  }

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

  // Неактивные попадают в табель только за месяцы, где они реально работали
  // (есть смены) или получили премию — см. комментарий у managerConds.
  const visibleManagers = managers.filter(
    (m) => m.isActive || breakdownByUser.has(m.id) || bonusByUser.has(m.id),
  );

  return visibleManagers.map((m): PayrollRow => {
    const breakdown = breakdownByUser.get(m.id) ?? {};
    let equivFullDays = 0;
    for (const [code, count] of Object.entries(breakdown)) {
      equivFullDays += count * payrollFactorFor(code as ScheduleCode);
    }
    // Round equiv days to 2 decimals to keep it tidy ("0.5 + 0.5 + 1 = 2.00").
    equivFullDays = Math.round(equivFullDays * 100) / 100;

    const rate = m.dailyRate !== null ? Number.parseFloat(m.dailyRate) : null;
    const base = rate !== null && Number.isFinite(rate)
      ? Math.round(equivFullDays * rate * 100) / 100
      : 0;

    const bonus = bonusByUser.get(m.id);
    const bonusAmount = bonus ? Math.round(bonus.amount * 100) / 100 : 0;
    const bonusNote = bonus?.note ?? null;
    const gross = Math.round((base + bonusAmount) * 100) / 100;

    return {
      userId: m.id,
      managerName: m.name,
      department,
      dailyRate: rate,
      statusBreakdown: breakdown,
      equivFullDays,
      baseAmount: base,
      bonusAmount,
      bonusNote,
      grossAmount: gross,
    };
  });
}

/**
 * Default period for cron runs: the calendar month that just closed in
 * Europe/Berlin. Called on or after the 1st of the new month → returns
 * previous month. Called on the 1st itself → also returns previous month.
 *
 * Uses formatToParts (not regex on the formatted string) so locale / ICU
 * formatting changes can't silently break the parse.
 */
export function previousMonthBerlin(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const yPart = parts.find((p) => p.type === "year")?.value;
  const mPart = parts.find((p) => p.type === "month")?.value;
  const y = yPart ? Number.parseInt(yPart, 10) : NaN;
  const m = mPart ? Number.parseInt(mPart, 10) : NaN; // 1..12
  if (!Number.isFinite(y) || !Number.isFinite(m)) {
    throw new Error("Failed to read Berlin date components");
  }
  // m=1 (January) → previous = December of y-1
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  return `${prevY}-${pad2(prevM)}`;
}
