// GET /api/daily/payroll/year?year=YYYY&department=b2g
//
// Returns a manager × month grid for the «Табель» popup. One row per active
// manager in the department; one entry per month with equiv days, gross, and
// the per-status breakdown. Computes by re-using src/lib/daily/payroll.ts —
// no caching, no DB writes (preview only). The popup persists snapshots via
// POST /api/daily/payroll when needed.
//
// Admin-only — rates are sensitive.

import { type NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computePayroll } from "@/lib/daily/payroll";

export const dynamic = "force-dynamic";

interface MonthEntry {
  equivFullDays: number;
  grossAmount: number;
  statusBreakdown: Record<string, number>;
}

interface YearRow {
  userId: string;
  managerName: string;
  dailyRate: number | null;
  monthly: Record<string, MonthEntry>;     // 'YYYY-MM' → entry
  yearGrossTotal: number;
  yearEquivDaysTotal: number;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isDept(s: string | null): s is "b2g" | "b2b" {
  return s === "b2g" || s === "b2b";
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const yearStr = url.searchParams.get("year");
  const dept = url.searchParams.get("department");
  const year = yearStr ? Number.parseInt(yearStr, 10) : NaN;

  if (!Number.isFinite(year) || year < 2020 || year > 2100) {
    return NextResponse.json({ error: "Invalid year" }, { status: 400 });
  }
  if (!isDept(dept)) {
    return NextResponse.json({ error: "Invalid department" }, { status: 400 });
  }

  const months = Array.from({ length: 12 }, (_, i) => `${year}-${pad2(i + 1)}`);

  try {
    // Sequential — small (12 months), shares db pool, keeps Neon CU low.
    // Could be parallelised with Promise.all if perf becomes a concern.
    const perMonth = [] as Array<Awaited<ReturnType<typeof computePayroll>>>;
    for (const m of months) {
      perMonth.push(await computePayroll(dept, m));
    }

    // Pivot {month → managers[]} into {manager → months}
    const byUser = new Map<string, YearRow>();
    months.forEach((monthStr, idx) => {
      for (const r of perMonth[idx]) {
        let row = byUser.get(r.userId);
        if (!row) {
          row = {
            userId: r.userId,
            managerName: r.managerName,
            dailyRate: r.dailyRate,
            monthly: {},
            yearGrossTotal: 0,
            yearEquivDaysTotal: 0,
          };
          byUser.set(r.userId, row);
        }
        // dailyRate may technically vary across months once we start
        // snapshotting — for the live preview we always carry the latest seen.
        if (r.dailyRate !== null) row.dailyRate = r.dailyRate;
        row.monthly[monthStr] = {
          equivFullDays: r.equivFullDays,
          grossAmount: r.grossAmount,
          statusBreakdown: r.statusBreakdown,
        };
        row.yearGrossTotal += r.grossAmount;
        row.yearEquivDaysTotal += r.equivFullDays;
      }
    });

    const rows = Array.from(byUser.values()).map((r) => ({
      ...r,
      yearGrossTotal: Math.round(r.yearGrossTotal * 100) / 100,
      yearEquivDaysTotal: Math.round(r.yearEquivDaysTotal * 100) / 100,
    }));
    rows.sort((a, b) => a.managerName.localeCompare(b.managerName, "ru"));

    return NextResponse.json({ success: true, year, department: dept, months, rows });
  } catch (err) {
    console.error("[payroll/year]", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
