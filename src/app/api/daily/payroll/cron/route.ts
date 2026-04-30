// GET /api/daily/payroll/cron[?month=YYYY-MM]
//   Header: `x-cron-secret: <CRON_SECRET>`
//
//   Computes + persists payroll for both departments. Called by the Dokploy
//   scheduler at month-end. Defaults to the previous calendar month in
//   Europe/Berlin so a cron firing at 23:00 on the last day of the month
//   resolves to the *just-completed* month consistently.
//
// Auth: header-only (the secret must NEVER appear in a URL — proxy logs +
// referer headers would leak it). No browser session.
//
// Suggested Dokploy schedule (Europe/Berlin):
//   - last day of month, 23:50  →  closes the month right after work ends
//   - or:  1st of month, 02:00  →  uses previousMonthBerlin() to compute prior

import { type NextRequest, NextResponse } from "next/server";
import { computePayroll, previousMonthBerlin } from "@/lib/daily/payroll";
import { persistPayrollRows } from "@/lib/daily/payroll-persist";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function isValidMonth(s: string | null): s is string {
  return !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");

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
      const persisted = await persistPayrollRows(rows, dept, month);
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
