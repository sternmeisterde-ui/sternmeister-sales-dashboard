// GET /api/tracking?department=b2g&from=2026-04-24&to=2026-04-24&types=a,b,c
// Returns per-manager timelines for a department over the given date range.
import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, lt, inArray, asc } from "drizzle-orm";
import { db as d1Db } from "@/lib/db";
import { masterManagers, managerSchedule } from "@/lib/db/schema-existing";
import { trackingDb } from "@/lib/db/tracking-db";
import { trackingEvents, trackingSyncState } from "@/lib/db/schema-tracking";
import { ensureFreshSync, ensureRangeCached } from "@/lib/tracking/sync";
import { ensureTrackingSchema } from "@/lib/tracking/init";
import { DEFAULT_SELECTED_KEYS } from "@/lib/tracking/event-types";
import { buildTimeline, type TimelineEvent, type ScheduleRow } from "@/lib/tracking/timeline";

export const dynamic = "force-dynamic";

// Dashboard renders everything in Europe/Moscow — same TZ used by Daily.
const DASHBOARD_TZ_OFFSET_MIN = 180;

function parseDateStr(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return new Date(`${s}T00:00:00Z`);
}

function enumerateDates(fromISO: string, toISO: string): string[] {
  const out: string[] = [];
  const fromD = new Date(`${fromISO}T00:00:00Z`);
  const toD = new Date(`${toISO}T00:00:00Z`);
  for (let d = new Date(fromD); d <= toD; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department");
    const fromISO = url.searchParams.get("from");
    const toISO = url.searchParams.get("to") ?? fromISO;
    const typesParam = url.searchParams.get("types"); // comma-separated; omit = defaults
    const skipSync = url.searchParams.get("skipSync") === "1";

    if (department !== "b2g" && department !== "b2b") {
      return NextResponse.json({ error: "Invalid department" }, { status: 400 });
    }
    if (!fromISO || !toISO || !parseDateStr(fromISO) || !parseDateStr(toISO)) {
      return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
    }
    if (new Date(fromISO) > new Date(toISO)) {
      return NextResponse.json({ error: "from > to" }, { status: 400 });
    }

    const selectedCrmTypes = new Set<string>(
      typesParam ? typesParam.split(",").filter(Boolean) : DEFAULT_SELECTED_KEYS,
    );

    // Tables must exist before ANY query, not just before sync — users can
    // open past dates (which skips sync) and we still SELECT from the cache.
    await ensureTrackingSchema();

    // "today" in the dashboard TZ (not UTC) — dashboard operates in Moscow
    // time and client sends local ISO dates, so UTC-today would be off by
    // up to 3 hours and miss the "includes today" branch near midnight UTC.
    const nowMs = Date.now();
    const todayMoscow = new Date(nowMs + DASHBOARD_TZ_OFFSET_MIN * 60_000)
      .toISOString()
      .slice(0, 10);
    const includesToday = todayMoscow >= fromISO && todayMoscow <= toISO;

    // fromISO / toISO are Moscow-local calendar dates. Convert to UTC bounds
    // for querying the cache AND for deciding whether a backfill is needed.
    const rangeStart = new Date(
      new Date(`${fromISO}T00:00:00Z`).getTime() - DASHBOARD_TZ_OFFSET_MIN * 60_000,
    );

    let synced = false;
    if (!skipSync) {
      try {
        // Pull new events if user is looking at today (keeps live bar fresh)
        if (includesToday) synced = await ensureFreshSync(department, 300);
        // Pull older events if the user selected a date we haven't backfilled yet
        const didBackfill = await ensureRangeCached(department, rangeStart);
        synced = synced || didBackfill;
      } catch (err) {
        console.warn("[tracking] sync failed, serving cache:", err);
      }
    }

    // Load managers for this department. Tracking is about individual
    // manager performance — ROPs and admins are excluded even if they're
    // active. A person promoted from manager→rop falls out of this view.
    const managers = await d1Db
      .select({
        id: masterManagers.id,
        name: masterManagers.name,
        line: masterManagers.line,
        shiftStartTime: masterManagers.shiftStartTime,
        shiftEndTime: masterManagers.shiftEndTime,
      })
      .from(masterManagers)
      .where(
        and(
          eq(masterManagers.department, department),
          eq(masterManagers.isActive, true),
          eq(masterManagers.role, "manager"),
        ),
      )
      .orderBy(asc(masterManagers.line), asc(masterManagers.name));

    if (managers.length === 0) {
      return NextResponse.json({ department, dates: [], managers: [], synced });
    }

    const managerIds = managers.map((m) => m.id);
    const dates = enumerateDates(fromISO, toISO);

    // Fetch schedule rows for all (manager × date)
    const scheduleRows = await d1Db
      .select({
        userId: managerSchedule.userId,
        scheduleDate: managerSchedule.scheduleDate,
        scheduleValue: managerSchedule.scheduleValue,
        shiftStartTime: managerSchedule.shiftStartTime,
        shiftEndTime: managerSchedule.shiftEndTime,
      })
      .from(managerSchedule)
      .where(
        and(
          inArray(managerSchedule.userId, managerIds),
          inArray(managerSchedule.scheduleDate, dates),
        ),
      );
    const scheduleIndex = new Map<string, ScheduleRow>(); // key: userId|date
    for (const r of scheduleRows) {
      scheduleIndex.set(`${r.userId}|${r.scheduleDate}`, {
        scheduleDate: r.scheduleDate,
        scheduleValue: r.scheduleValue,
        shiftStartTime: r.shiftStartTime,
        shiftEndTime: r.shiftEndTime,
      });
    }

    // Upper bound for events (lower was already computed as rangeStart above).
    const rangeEnd = new Date(
      new Date(`${toISO}T00:00:00Z`).getTime() + (24 * 60 - DASHBOARD_TZ_OFFSET_MIN) * 60_000,
    );

    const events = await trackingDb
      .select({
        managerId: trackingEvents.managerId,
        eventId: trackingEvents.eventId,
        eventType: trackingEvents.eventType,
        createdAt: trackingEvents.createdAt,
        durationSec: trackingEvents.durationSec,
      })
      .from(trackingEvents)
      .where(
        and(
          eq(trackingEvents.department, department),
          inArray(trackingEvents.managerId, managerIds),
          gte(trackingEvents.createdAt, rangeStart),
          lt(trackingEvents.createdAt, rangeEnd),
        ),
      );

    // Group events by manager + local date
    const evByManagerDate = new Map<string, TimelineEvent[]>();
    for (const e of events) {
      const localDate = new Date(
        new Date(e.createdAt).getTime() + DASHBOARD_TZ_OFFSET_MIN * 60_000,
      )
        .toISOString()
        .slice(0, 10);
      const key = `${e.managerId}|${localDate}`;
      let list = evByManagerDate.get(key);
      if (!list) {
        list = [];
        evByManagerDate.set(key, list);
      }
      list.push({
        eventId: e.eventId,
        eventType: e.eventType,
        createdAt: new Date(e.createdAt),
        durationSec: e.durationSec ?? 0,
      });
    }

    // Build timelines
    const result = managers.map((m) => ({
      id: m.id,
      name: m.name,
      line: m.line,
      days: dates.map((date) => {
        const sched = scheduleIndex.get(`${m.id}|${date}`) ?? null;
        // Fallback: if no schedule row but manager has shift times, treat as full day
        const effectiveSched: ScheduleRow | null = sched ?? (m.shiftStartTime
          ? {
            scheduleDate: date,
            scheduleValue: "8",
            shiftStartTime: m.shiftStartTime,
            shiftEndTime: m.shiftEndTime,
          }
          : null);
        const eventsForDay = evByManagerDate.get(`${m.id}|${date}`) ?? [];
        const tl = buildTimeline({
          scheduleRow: effectiveSched,
          dateISO: date,
          tzOffsetMinutes: DASHBOARD_TZ_OFFSET_MIN,
          events: eventsForDay,
          selectedCrmTypes,
        });
        return { date, ...tl };
      }),
    }));

    // Meta: last sync info
    const [syncState] = await trackingDb
      .select()
      .from(trackingSyncState)
      .where(eq(trackingSyncState.department, department))
      .limit(1);

    return NextResponse.json({
      department,
      dates,
      managers: result,
      synced,
      lastSyncedAt: syncState?.lastSyncedAt ?? null,
      lastError: syncState?.lastError ?? null,
    });
  } catch (err) {
    console.error("[tracking] GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
