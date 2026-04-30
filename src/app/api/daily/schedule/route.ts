// GET /api/daily/schedule?date=2026-02-28 — get schedule for a date
// GET /api/daily/schedule?month=2026-04 — get schedule for entire month
// PUT /api/daily/schedule — set schedule entries
import { NextRequest, NextResponse } from "next/server";
import { getFullScheduleForDate, getScheduleForMonth, setSchedule } from "@/lib/db/queries-daily";
import { clearCache } from "@/lib/kommo/cache";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { managerSchedule } from "@/lib/db/schema-existing";
import { sql } from "drizzle-orm";

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
  return true; // "8", "4", "н" (онбординг), "у" (день увольнения), any number = working
}

export async function PUT(req: NextRequest) {
  // Admin-only: bulk schedule writes affect SLA / payroll calculations across
  // a whole month, and any caller could pass an arbitrary userId.
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json();

    // Bulk update: { entries: [{ userId, date, scheduleValue, shiftStartTime?, shiftEndTime? }] }
    //
    // Implemented as a single multi-row INSERT … ON CONFLICT DO UPDATE so the
    // whole batch is atomic at the Postgres level — Neon HTTP doesn't expose
    // transactions, but a single statement is. Either every row writes or
    // none does (and the response count reflects reality, not the request).
    //
    // Shift fields are tri-state. We snapshot whether each row's caller
    // explicitly passed shiftStartTime / shiftEndTime; on conflict we only
    // overwrite those columns when the caller wanted to. Mixed-shape batches
    // are rejected — every row in a single PUT must use the same shape.
    if (body.entries && Array.isArray(body.entries)) {
      const entries = body.entries as Array<{
        userId: string;
        date: string;
        scheduleValue?: string | null;
        shiftStartTime?: string | null;
        shiftEndTime?: string | null;
      }>;
      if (entries.length === 0) {
        return NextResponse.json({ ok: true, count: 0 });
      }

      const someHasShiftStart = entries.some((e) => e.shiftStartTime !== undefined);
      const someHasShiftEnd = entries.some((e) => e.shiftEndTime !== undefined);

      const values = entries.map((e) => ({
        userId: e.userId,
        scheduleDate: e.date,
        isOnLine: scheduleValueToIsOnLine(e.scheduleValue),
        scheduleValue: e.scheduleValue ?? null,
        shiftStartTime: e.shiftStartTime ?? null,
        shiftEndTime: e.shiftEndTime ?? null,
      }));

      const setClause: Record<string, unknown> = {
        isOnLine: sql.raw("EXCLUDED.is_on_line"),
        scheduleValue: sql.raw("EXCLUDED.schedule_value"),
        updatedAt: new Date(),
      };
      if (someHasShiftStart) setClause.shiftStartTime = sql.raw("EXCLUDED.shift_start_time");
      if (someHasShiftEnd) setClause.shiftEndTime = sql.raw("EXCLUDED.shift_end_time");

      await db
        .insert(managerSchedule)
        .values(values)
        .onConflictDoUpdate({
          target: [managerSchedule.userId, managerSchedule.scheduleDate],
          set: setClause,
        });

      clearCache();
      return NextResponse.json({ ok: true, count: entries.length });
    }

    // Single update: { userId, date, isOnLine, scheduleValue?, shiftStartTime?, shiftEndTime? }
    const { userId, date, isOnLine, scheduleValue, shiftStartTime, shiftEndTime } = body;
    if (!userId || !date) {
      return NextResponse.json(
        { error: "Missing required fields: userId, date" },
        { status: 400 }
      );
    }

    const effectiveIsOnLine = scheduleValue !== undefined
      ? scheduleValueToIsOnLine(scheduleValue)
      : (isOnLine ?? true);

    await setSchedule(
      userId,
      date,
      effectiveIsOnLine,
      scheduleValue ?? null,
      shiftStartTime,
      shiftEndTime,
    );
    clearCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Schedule PUT error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
