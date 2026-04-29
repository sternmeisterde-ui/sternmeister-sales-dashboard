// GET /api/tracking/detail?department=b2g&managerId=<uuid>&date=2026-04-28
//
// Per-(manager, date) raw event list for the loupe modal in Активность.
// Lazy-loaded when the user clicks the magnifier — keeps the main GET
// response small while still enabling deep-dive on demand.
//
// Returns events grouped per timeline segment so the modal can show
// "what fell into THIS green stripe" on hover without re-running the
// segment math client-side.

import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, lt, asc } from "drizzle-orm";
import { db as d1Db } from "@/lib/db";
import { masterManagers, managerSchedule } from "@/lib/db/schema-existing";
import { trackingDb } from "@/lib/db/tracking-db";
import { trackingEvents } from "@/lib/db/schema-tracking";
import { ensureTrackingSchema } from "@/lib/tracking/init";
import { DEFAULT_SELECTED_KEYS, EVENT_TYPE_MAP, normalizeEventType } from "@/lib/tracking/event-types";
import { buildTimeline, type TimelineEvent, type ScheduleRow } from "@/lib/tracking/timeline";
import { tzOffsetMinutes } from "@/lib/utils/date";

export const dynamic = "force-dynamic";

function berlinOffsetMin(d: Date): number {
  return tzOffsetMinutes(d, "Europe/Berlin");
}

function parseDateStr(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return new Date(`${s}T00:00:00Z`);
}

interface DetailEvent {
  eventId: string;
  eventType: string;
  label: string;        // Russian label for the type
  group: string;        // UI grouping
  createdAt: string;    // ISO
  timeBerlin: string;   // "HH:MM" in Berlin
  durationSec: number;
  entityType: string | null;
  entityId: number | null;
  raw: unknown;         // includes phone, link, uniq, call_status, etc. for calls
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department");
    const managerId = url.searchParams.get("managerId");
    const dateISO = url.searchParams.get("date");
    const typesParam = url.searchParams.get("types");

    if (department !== "b2g" && department !== "b2b") {
      return NextResponse.json({ error: "Invalid department" }, { status: 400 });
    }
    if (!managerId || !dateISO || !parseDateStr(dateISO)) {
      return NextResponse.json({ error: "Missing managerId or date" }, { status: 400 });
    }

    const selectedCrmTypes = new Set<string>(
      typesParam ? typesParam.split(",").filter(Boolean) : DEFAULT_SELECTED_KEYS,
    );

    await ensureTrackingSchema();

    // Manager metadata for the header
    const [manager] = await d1Db
      .select({
        id: masterManagers.id,
        name: masterManagers.name,
        line: masterManagers.line,
        shiftStartTime: masterManagers.shiftStartTime,
        shiftEndTime: masterManagers.shiftEndTime,
      })
      .from(masterManagers)
      .where(and(eq(masterManagers.id, managerId), eq(masterManagers.department, department)))
      .limit(1);

    if (!manager) {
      return NextResponse.json({ error: "Manager not found in this department" }, { status: 404 });
    }

    // Schedule row for this date
    const [sched] = await d1Db
      .select({
        userId: managerSchedule.userId,
        scheduleDate: managerSchedule.scheduleDate,
        scheduleValue: managerSchedule.scheduleValue,
        shiftStartTime: managerSchedule.shiftStartTime,
        shiftEndTime: managerSchedule.shiftEndTime,
      })
      .from(managerSchedule)
      .where(and(eq(managerSchedule.userId, managerId), eq(managerSchedule.scheduleDate, dateISO)))
      .limit(1);

    const scheduleRow: ScheduleRow | null = sched
      ? {
          scheduleDate: sched.scheduleDate,
          scheduleValue: sched.scheduleValue,
          shiftStartTime: sched.shiftStartTime,
          shiftEndTime: sched.shiftEndTime,
        }
      : manager.shiftStartTime
        ? {
            scheduleDate: dateISO,
            scheduleValue: "8",
            shiftStartTime: manager.shiftStartTime,
            shiftEndTime: manager.shiftEndTime,
          }
        : null;

    // Day bounds in UTC
    const dateUtc = new Date(`${dateISO}T00:00:00Z`);
    const offset = berlinOffsetMin(dateUtc);
    const dayStart = new Date(dateUtc.getTime() - offset * 60_000);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);

    // Pull all events for this manager-day. Calls always included; CRM
    // events filtered by `types` so the modal matches the parent view.
    const rows = await trackingDb
      .select({
        eventId: trackingEvents.eventId,
        eventType: trackingEvents.eventType,
        createdAt: trackingEvents.createdAt,
        durationSec: trackingEvents.durationSec,
        entityType: trackingEvents.entityType,
        entityId: trackingEvents.entityId,
        raw: trackingEvents.raw,
      })
      .from(trackingEvents)
      .where(
        and(
          eq(trackingEvents.department, department),
          eq(trackingEvents.managerId, managerId),
          gte(trackingEvents.createdAt, dayStart),
          lt(trackingEvents.createdAt, dayEnd),
        ),
      )
      .orderBy(asc(trackingEvents.createdAt));

    const isCallType = (t: string) => t === "incoming_call" || t === "outgoing_call";

    // Pre-build the timeline so the modal can paint identical segments
    // without recomputing — also gives the modal segment.startMin/endMin
    // bounds it needs to bucket events for hover.
    const timelineEvents: TimelineEvent[] = rows.map((r) => ({
      eventId: r.eventId,
      eventType: r.eventType,
      createdAt: new Date(r.createdAt),
      durationSec: r.durationSec ?? 0,
      entityType: r.entityType,
    }));
    const timeline = buildTimeline({
      scheduleRow,
      dateISO,
      tzOffsetMinutes: offset,
      events: timelineEvents,
      selectedCrmTypes,
    });

    // Per-event detail. Filter to selected types + calls so the modal
    // matches what the user sees on the bar. entity_linked / unlinked
    // pass through with their entity_type so the same expansion rule
    // applies on the client (a `lead_linked` filter selection counts
    // entity_linked rows where entity_type='lead').
    const detail: DetailEvent[] = rows
      .filter((r) => {
        if (isCallType(r.eventType)) return true;
        const directKey = normalizeEventType(r.eventType);
        if (selectedCrmTypes.has(directKey)) return true;
        if (
          (r.eventType === "entity_linked" || r.eventType === "entity_unlinked") &&
          r.entityType
        ) {
          const suffix = r.eventType === "entity_linked" ? "_linked" : "_unlinked";
          return selectedCrmTypes.has(`${r.entityType}${suffix}`);
        }
        return false;
      })
      .map((r) => {
        const at = new Date(r.createdAt);
        const localMs = at.getTime() + offset * 60_000;
        const local = new Date(localMs);
        const hh = String(local.getUTCHours()).padStart(2, "0");
        const mm = String(local.getUTCMinutes()).padStart(2, "0");
        const def = EVENT_TYPE_MAP[normalizeEventType(r.eventType)];
        return {
          eventId: r.eventId,
          eventType: r.eventType,
          label: def?.label ?? r.eventType,
          group: def?.group ?? "Прочее",
          createdAt: at.toISOString(),
          timeBerlin: `${hh}:${mm}`,
          durationSec: r.durationSec ?? 0,
          entityType: r.entityType,
          entityId: r.entityId,
          raw: r.raw,
        };
      });

    return NextResponse.json({
      department,
      manager: { id: manager.id, name: manager.name, line: manager.line },
      date: dateISO,
      timeline,
      events: detail,
    });
  } catch (err) {
    console.error("[tracking/detail] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
