// GET  /api/daily/payroll?month=YYYY-MM&department=b2g[&persist=1]
//   Compute the monthly timesheet for a department. Preview by default.
//   Pass &persist=1 (admin only) to also write the snapshot into payroll_runs.
//
// GET  /api/daily/payroll/runs?month=YYYY-MM&department=b2g
//   See payroll/runs/route.ts — returns previously persisted snapshots.
//
// Behaviour mirrors the sibling Daily endpoints: department param picks the
// right master_managers slice; auth is admin-only because rates are sensitive.

import { type NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { payrollRuns } from "@/lib/db/schema-existing";
import { computePayroll, type PayrollRow } from "@/lib/daily/payroll";

function isValidMonth(s: string | null): s is string {
  return !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

function isDept(s: string | null): s is "b2g" | "b2b" {
  return s === "b2g" || s === "b2b";
}

async function persistRun(
  rows: PayrollRow[],
  department: "b2g" | "b2b",
  periodMonth: string,
): Promise<number> {
  let written = 0;
  for (const r of rows) {
    // Upsert by (department, periodMonth, userId): re-running the cron must
    // overwrite the prior snapshot, not append.
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
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const month = url.searchParams.get("month");
  const dept = url.searchParams.get("department");
  const persist = url.searchParams.get("persist") === "1";

  if (!isValidMonth(month)) {
    return NextResponse.json({ error: "Invalid or missing month (YYYY-MM)" }, { status: 400 });
  }
  if (!isDept(dept)) {
    return NextResponse.json({ error: "Invalid or missing department" }, { status: 400 });
  }

  try {
    const rows = await computePayroll(dept, month);
    let persisted = 0;
    if (persist) persisted = await persistRun(rows, dept, month);

    return NextResponse.json({
      success: true,
      department: dept,
      month,
      rows,
      persisted,
    });
  } catch (err) {
    console.error("[payroll GET]", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST — explicit "save snapshot now" trigger. Same payload semantics as GET
// with persist=1 but kept as a separate verb for clarity in the UI later.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const month = typeof body.month === "string" ? body.month : null;
  const dept = typeof body.department === "string" ? body.department : null;

  if (!isValidMonth(month)) {
    return NextResponse.json({ error: "Invalid or missing month (YYYY-MM)" }, { status: 400 });
  }
  if (!isDept(dept)) {
    return NextResponse.json({ error: "Invalid or missing department" }, { status: 400 });
  }

  try {
    const rows = await computePayroll(dept, month);
    const persisted = await persistRun(rows, dept, month);
    return NextResponse.json({ success: true, department: dept, month, rows, persisted });
  } catch (err) {
    console.error("[payroll POST]", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
