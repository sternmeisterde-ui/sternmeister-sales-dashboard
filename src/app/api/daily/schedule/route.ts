// GET /api/daily/schedule?date=2026-02-28 — get schedule for a date
// PUT /api/daily/schedule — set schedule for a manager on a date
import { NextRequest, NextResponse } from "next/server";
import { getFullScheduleForDate, bulkSetSchedule, setSchedule } from "@/lib/db/queries-daily";
import { clearCache } from "@/lib/kommo/cache";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const dateStr = url.searchParams.get("date");
    if (!dateStr) {
      return NextResponse.json({ error: "Missing date parameter" }, { status: 400 });
    }

    const schedule = await getFullScheduleForDate(dateStr);
    return NextResponse.json({ date: dateStr, schedule });
  } catch (error) {
    console.error("Schedule GET error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();

    // Support bulk update: { date, entries: [{ userId, isOnLine }] }
    if (body.entries && Array.isArray(body.entries)) {
      if (!body.date) {
        return NextResponse.json({ error: "Missing date" }, { status: 400 });
      }
      await bulkSetSchedule(body.date, body.entries);
      clearCache();
      return NextResponse.json({ ok: true });
    }

    // Single update: { userId, date, isOnLine }
    const { userId, date, isOnLine } = body;
    if (!userId || !date || isOnLine === undefined) {
      return NextResponse.json(
        { error: "Missing required fields: userId, date, isOnLine" },
        { status: 400 }
      );
    }

    await setSchedule(userId, date, isOnLine);
    clearCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Schedule PUT error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
