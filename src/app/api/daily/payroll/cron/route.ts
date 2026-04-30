// GET /api/daily/payroll/cron?secret=<CRON_SECRET>[&month=YYYY-MM]
//   Computes + persists payroll for both departments. Called by the Dokploy
//   scheduler at month-end. Defaults to the previous calendar month in
//   Europe/Berlin so a cron firing at 23:00 on the last day of the month
//   resolves to the *just-completed* month consistently.
//
// Auth: same CRON_SECRET pattern as /api/analytics/sync/cron — header
// `x-cron-secret` or query `?secret=`. No browser session.
//
// Suggested Dokploy schedule (Europe/Berlin):
//   - last day of month, 23:50  →  closes the month right after work ends
//   - or:  1st of month, 02:00  →  uses previousMonthBerlin() to compute prior

import { type NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { payrollRuns } from "@/lib/db/schema-existing";
import { computePayroll, previousMonthBerlin, type PayrollRow } from "@/lib/daily/payroll";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function isValidMonth(s: string | null): s is string {
  return !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

async function persistRun(
  rows: PayrollRow[],
  department: "b2g" | "b2b",
  periodMonth: string,
): Promise<number> {
  let written = 0;
  for (const r of rows) {
    const existing = await db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.department, department),
          eq(payrollRuns.periodMonth, periodMonth),
          eq(payrollRuns.userId, r.userId),
        ),
      )
      .limit(1);

    const values = {
      department,
      periodMonth,
      userId: r.userId,
      managerName: r.managerName,
      dailyRate: r.dailyRate !== null ? r.dailyRate.toFixed(2) : null,
      statusBreakdown: r.statusBreakdown,
      equivFullDays: r.equivFullDays.toFixed(2),
      bonusAmount: r.bonusAmount.toFixed(2),
      grossAmount: r.grossAmount.toFixed(2),
      computedAt: new Date(),
    };

    if (existing.length > 0) {
      await db.update(payrollRuns).set(values).where(eq(payrollRuns.id, existing[0].id));
    } else {
      await db.insert(payrollRuns).values(values);
    }
    written++;
  }
  return written;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret =
    req.headers.get("x-cron-secret") ??
    req.nextUrl.searchParams.get("secret");

  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[payroll cron] CRON_SECRET env var not set");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  if (!secret || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const overrideMonth = req.nextUrl.searchParams.get("month");
  const month = isValidMonth(overrideMonth) ? overrideMonth : previousMonthBerlin();

  console.log(`[payroll cron] running for period=${month}`);

  const summary: Record<string, { rows: number; persisted: number }> = {};
  try {
    for (const dept of ["b2g", "b2b"] as const) {
      const rows = await computePayroll(dept, month);
      const persisted = await persistRun(rows, dept, month);
      summary[dept] = { rows: rows.length, persisted };
      console.log(`[payroll cron] ${dept}: ${persisted}/${rows.length} rows persisted`);
    }
    return NextResponse.json({ success: true, month, summary });
  } catch (err) {
    console.error("[payroll cron] failed:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg, summary }, { status: 500 });
  }
}
