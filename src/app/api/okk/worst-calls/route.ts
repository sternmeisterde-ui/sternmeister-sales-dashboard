import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkWorstCalls, okkManagers } from "@/lib/db/schema-okk";
import { eq, and, gte, lte, sql } from "drizzle-orm";

/**
 * GET /api/okk/worst-calls?department=b2g&from=YYYY-MM-DD&to=YYYY-MM-DD&line=1
 *
 * Returns worst call tracking data for the date range.
 * Shows per-manager: how many worst calls sent, how many responded.
 */
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const deptParam = sp.get("department") ?? "b2g";
    const department = deptParam === "b2b" ? "b2b" : "b2g";
    const fromParam = sp.get("from");
    const toParam = sp.get("to");
    const lineParam = sp.get("line");

    const db = getOkkDbForDepartment(department as "b2g" | "b2b");

    // Default: last 7 days
    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setDate(defaultFrom.getDate() - 7);
    const fromDate = fromParam || defaultFrom.toISOString().slice(0, 10);
    const toDate = toParam || now.toISOString().slice(0, 10);

    // Get all active managers (role=manager only) with optional line filter
    const managerConditions = [
      eq(okkManagers.isActive, true),
      eq(okkManagers.role, "manager"),
    ];
    if (lineParam && lineParam !== "all") {
      managerConditions.push(eq(okkManagers.line, lineParam));
    }

    const managers = await db
      .select({ id: okkManagers.id, name: okkManagers.name, line: okkManagers.line })
      .from(okkManagers)
      .where(and(...managerConditions))
      .orderBy(okkManagers.name);

    // Get worst_calls for date range
    const worstCalls = await db
      .select({
        id: okkWorstCalls.id,
        managerId: okkWorstCalls.managerId,
        score: okkWorstCalls.score,
        period: okkWorstCalls.period,
        periodDate: okkWorstCalls.periodDate,
        responded: okkWorstCalls.responded,
        respondedAt: okkWorstCalls.respondedAt,
        responseAdequate: okkWorstCalls.responseAdequate,
        sentAt: okkWorstCalls.sentAt,
      })
      .from(okkWorstCalls)
      .where(
        and(
          gte(okkWorstCalls.periodDate, fromDate),
          lte(okkWorstCalls.periodDate, toDate),
        )
      );

    // Build per-manager summary
    const managerMap = new Map<string, {
      id: string;
      name: string;
      line: string | null;
      totalSent: number;
      totalResponded: number;
      totalAdequate: number;
      missedResponses: Array<{ date: string; period: string; score: number }>;
      entries: Array<{ date: string; period: string; score: number; responded: boolean; adequate: boolean | null }>;
    }>();

    for (const mgr of managers) {
      managerMap.set(mgr.id, {
        id: mgr.id,
        name: mgr.name,
        line: mgr.line,
        totalSent: 0,
        totalResponded: 0,
        totalAdequate: 0,
        missedResponses: [],
        entries: [],
      });
    }

    for (const wc of worstCalls) {
      if (!wc.managerId) continue;
      const mgr = managerMap.get(wc.managerId);
      if (!mgr) continue; // manager not in current filter (wrong line)

      mgr.totalSent++;
      const entry = {
        date: wc.periodDate,
        period: wc.period,
        score: wc.score,
        responded: wc.responded ?? false,
        adequate: wc.responseAdequate,
      };
      mgr.entries.push(entry);

      if (wc.responded) {
        mgr.totalResponded++;
        if (wc.responseAdequate) mgr.totalAdequate++;
      } else {
        mgr.missedResponses.push({
          date: wc.periodDate,
          period: wc.period,
          score: wc.score,
        });
      }
    }

    const result = [...managerMap.values()]
      .map((mgr) => ({
        ...mgr,
        responseRate: mgr.totalSent > 0 ? Math.round((mgr.totalResponded / mgr.totalSent) * 100) : null,
        hasMissed: mgr.missedResponses.length > 0,
      }))
      .sort((a, b) => (b.missedResponses.length - a.missedResponses.length) || a.name.localeCompare(b.name));

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("[Worst Calls API]", error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
