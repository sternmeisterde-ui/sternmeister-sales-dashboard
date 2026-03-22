// GET /api/daily/active-managers?date=2026-03-22&department=b2g
// POST /api/daily/active-managers — save active managers for a date
import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { getDailyDb, dailyActiveManagers } from "@/lib/db/daily-db";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const dateStr = url.searchParams.get("date");
    const department = url.searchParams.get("department") || "b2g";

    if (!dateStr) {
      return NextResponse.json({ error: "Missing date" }, { status: 400 });
    }

    const db = getDailyDb();
    const rows = await db
      .select()
      .from(dailyActiveManagers)
      .where(
        and(
          eq(dailyActiveManagers.date, dateStr),
          eq(dailyActiveManagers.department, department)
        )
      );

    return NextResponse.json({
      date: dateStr,
      department,
      hasActiveManagers: rows.length > 0,
      managers: rows.map((r) => ({
        managerId: r.managerId,
        managerName: r.managerName,
        line: r.line,
      })),
    });
  } catch (error) {
    console.error("Active managers GET error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { date, department = "b2g", managers } = body;

    if (!date || !managers || !Array.isArray(managers)) {
      return NextResponse.json(
        { error: "Missing required fields: date, managers[]" },
        { status: 400 }
      );
    }

    const db = getDailyDb();

    // Delete existing entries for this date+department
    await db
      .delete(dailyActiveManagers)
      .where(
        and(
          eq(dailyActiveManagers.date, date),
          eq(dailyActiveManagers.department, department)
        )
      );

    // Insert new entries
    if (managers.length > 0) {
      await db.insert(dailyActiveManagers).values(
        managers.map((m: { managerId: string; managerName: string; line?: string }) => ({
          date,
          department,
          managerId: m.managerId,
          managerName: m.managerName,
          line: m.line || null,
        }))
      );
    }

    return NextResponse.json({ ok: true, count: managers.length });
  } catch (error) {
    console.error("Active managers POST error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
