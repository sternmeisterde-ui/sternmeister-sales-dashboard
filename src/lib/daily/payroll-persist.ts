// Shared persist helper for payroll snapshots.
//
// Both /api/daily/payroll (manual save) and /api/daily/payroll/cron call into
// this — keeping the upsert in one place means future fixes only happen once.
//
// Uses Drizzle's onConflictDoUpdate against the (department, period_month,
// user_id) UNIQUE INDEX created in scripts/payroll-migration.sql, eliminating
// the select-then-insert/update TOCTOU race that the previous duplicate
// implementations had.

import { db } from "@/lib/db";
import { payrollRuns } from "@/lib/db/schema-existing";
import type { PayrollRow } from "./payroll";

export async function persistPayrollRows(
  rows: PayrollRow[],
  department: "b2g" | "b2b",
  periodMonth: string,
): Promise<number> {
  if (rows.length === 0) return 0;

  const now = new Date();
  const values = rows.map((r) => ({
    department,
    periodMonth,
    userId: r.userId,
    managerName: r.managerName,
    dailyRate: r.dailyRate !== null ? r.dailyRate.toFixed(2) : null,
    statusBreakdown: r.statusBreakdown,
    equivFullDays: r.equivFullDays.toFixed(2),
    bonusAmount: r.bonusAmount.toFixed(2),
    grossAmount: r.grossAmount.toFixed(2),
    computedAt: now,
  }));

  // Single multi-row INSERT … ON CONFLICT DO UPDATE — atomic, no TOCTOU,
  // and one round-trip instead of N.
  await db
    .insert(payrollRuns)
    .values(values)
    .onConflictDoUpdate({
      target: [payrollRuns.department, payrollRuns.periodMonth, payrollRuns.userId],
      set: {
        managerName: sqlExcluded("manager_name"),
        dailyRate: sqlExcluded("daily_rate"),
        statusBreakdown: sqlExcluded("status_breakdown"),
        equivFullDays: sqlExcluded("equiv_full_days"),
        bonusAmount: sqlExcluded("bonus_amount"),
        grossAmount: sqlExcluded("gross_amount"),
        computedAt: now,
      },
    });

  return rows.length;
}

// Tiny helper: Postgres' EXCLUDED pseudo-table is the "incoming row" inside
// ON CONFLICT DO UPDATE. Drizzle exposes it via sql, but typing the column
// name twice is noisy — wrap it once.
import { sql } from "drizzle-orm";
function sqlExcluded(column: string) {
  return sql.raw(`EXCLUDED.${column}`);
}
