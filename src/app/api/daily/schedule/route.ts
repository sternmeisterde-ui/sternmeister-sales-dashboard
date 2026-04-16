// GET /api/daily/schedule?date=2026-02-28 — get schedule for a date
// GET /api/daily/schedule?month=2026-04 — get schedule for entire month
// PUT /api/daily/schedule — set schedule entries
import { NextRequest, NextResponse } from "next/server";
import { getFullScheduleForDate, getScheduleForMonth, setSchedule } from "@/lib/db/queries-daily";
import { clearCache } from "@/lib/kommo/cache";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const dateStr = url.searchParams.get("date");
    const monthStr = url.searchParams.get("month");

    if (monthStr) {
      const schedule = await getScheduleForMonth(monthStr);
      return NextResponse.json({ month: monthStr, schedule });
    }

    if (dateStr) {
      const schedule = await getFullScheduleForDate(dateStr);
      return NextResponse.json({ date: dateStr, schedule });
    }

    return NextResponse.json({ error: "Missing date or month parameter" }, { status: 400 });
  } catch (error) {
    console.error("Schedule GET error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

function scheduleValueToIsOnLine(val: string | null | undefined): boolean {
  if (!val || val === "-" || val === "о" || val === "О") return false;
  return true; // "8", "4", any number = working
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();

    // Bulk update with scheduleValue: { entries: [{ userId, date, scheduleValue }] }
    if (body.entries && Array.isArray(body.entries)) {
      for (const entry of body.entries) {
        const isOnLine = scheduleValueToIsOnLine(entry.scheduleValue);
        await setSchedule(entry.userId, entry.date, isOnLine, entry.scheduleValue ?? null);
      }
      clearCache();
      return NextResponse.json({ ok: true, count: body.entries.length });
    }

    // Single update: { userId, date, isOnLine, scheduleValue? }
    const { userId, date, isOnLine, scheduleValue } = body;
    if (!userId || !date) {
      return NextResponse.json(
        { error: "Missing required fields: userId, date" },
        { status: 400 }
      );
    }

    const effectiveIsOnLine = scheduleValue !== undefined
      ? scheduleValueToIsOnLine(scheduleValue)
      : (isOnLine ?? true);

    await setSchedule(userId, date, effectiveIsOnLine, scheduleValue ?? null);
    clearCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Schedule PUT error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
