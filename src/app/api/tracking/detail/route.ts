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
import { and, eq, gte, lt, asc, or, isNull } from "drizzle-orm";
import { db as d1Db } from "@/lib/db";
import { masterManagers, managerSchedule } from "@/lib/db/schema-existing";
import { trackingDb } from "@/lib/db/tracking-db";
import { trackingEvents, managerStatusIntervals } from "@/lib/db/schema-tracking";
import { ensureTrackingSchema } from "@/lib/tracking/init";
import { DEFAULT_SELECTED_KEYS, EVENT_TYPE_MAP, normalizeEventType } from "@/lib/tracking/event-types";
import { buildTimeline, buildDialerTimeline, type TimelineEvent, type ScheduleRow, type StatusInterval } from "@/lib/tracking/timeline";
import { getDialerCallEventsByMaster, getAnalyticsCallEventsByMaster } from "@/lib/daily/analytics-calls";
import { tzOffsetMinutes } from "@/lib/utils/date";
import { getSession } from "@/lib/auth";

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
    const view = url.searchParams.get("view") === "dialer" ? "dialer" : "general";

    if (department !== "b2g" && department !== "b2b") {
      return NextResponse.json({ error: "Invalid department" }, { status: 400 });
    }
    if (!managerId || !dateISO || !parseDateStr(dateISO)) {
      return NextResponse.json({ error: "Missing managerId or date" }, { status: 400 });
    }

    // Auth mirrors /api/tracking: admin gate sees everyone, plain managers
    // only their own department + own row (verified below once the master
    // row is loaded — managerId alone is forgeable).
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const managerOnly = session.role === "manager";
    if (managerOnly && department !== session.department) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
        telegramUsername: masterManagers.telegramUsername,
        kommoUserId: masterManagers.kommoUserId,
      })
      .from(masterManagers)
      .where(and(eq(masterManagers.id, managerId), eq(masterManagers.department, department)))
      .limit(1);

    // Manager-only sessions may open the loupe only on themselves. Same
    // match order as /api/tracking: telegram username → kommoUserId → name.
    if (manager && managerOnly) {
      const tgSession = session.telegramUsername?.toLowerCase() || null;
      const tgMaster = manager.telegramUsername?.replace(/^@/, "").toLowerCase() || null;
      const isSelf =
        tgSession && tgMaster
          ? tgMaster === tgSession
          : session.kommoUserId && manager.kommoUserId
            ? manager.kommoUserId === session.kommoUserId
            : manager.name === session.name;
      if (!isSelf) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

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

    // ===== Dialer detail (CloudTalk) =====
    // One row per dialer call that day: time + talk/wait durations + phone,
    // plus the dialer timeline so the modal paints the same segmented bar.
    if (view === "dialer") {
      const dialerEvents =
        department === "b2g"
          ? await getDialerCallEventsByMaster(
              [{ id: manager.id, name: manager.name }],
              department,
              Math.floor(dayStart.getTime() / 1000),
              Math.floor(dayEnd.getTime() / 1000),
            )
          : [];

      const timeline = buildDialerTimeline({
        scheduleRow,
        dateISO,
        tzOffsetMinutes: offset,
        calls: dialerEvents.map((e) => ({
          startedAt: e.createdAt,
          talkSec: e.talkSec,
          waitSec: e.waitSec,
          channel: e.channel,
        })),
      });

      const events: DetailEvent[] = dialerEvents
        .slice()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((e) => {
          const local = new Date(e.createdAt.getTime() + offset * 60_000);
          const hh = String(local.getUTCHours()).padStart(2, "0");
          const mm = String(local.getUTCMinutes()).padStart(2, "0");
          return {
            eventId: e.eventId,
            eventType: e.direction === "incoming" ? "incoming_call" : "outgoing_call",
            label: e.direction === "incoming" ? "Входящий звонок" : "Исходящий звонок",
            // Right-hand tag in the modal row: attribution channel.
            group: e.channel === "dialer" ? "Дайлер" : "Вне дайлера",
            createdAt: e.createdAt.toISOString(),
            timeBerlin: `${hh}:${mm}`,
            durationSec: e.talkSec,
            entityType: null,
            entityId: null,
            raw: { phone: e.phone, waitSec: e.waitSec, channel: e.channel },
          };
        });

      return NextResponse.json({
        department,
        view: "dialer",
        manager: { id: manager.id, name: manager.name, line: manager.line },
        date: dateISO,
        timeline,
        events,
      });
    }

    // Pull CRM events for this manager-day from tracking_events. Calls come
    // SEPARATELY from analytics.communications (same source as the parent
    // view) — since tracking v12 tracking_events holds no call rows, so
    // without this merge the modal timeline rendered call-free and diverged
    // from the main bar.
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

    const callEvents = await getAnalyticsCallEventsByMaster(
      [{ id: manager.id, name: manager.name }],
      department,
      Math.floor(dayStart.getTime() / 1000),
      Math.floor(dayEnd.getTime() / 1000),
    );

    // Ручные статусы этого дня (b2g): для покраски таймлайна + список в ответ
    // (админ может удалять/добавлять интервалы задним числом).
    const statusRows =
      department === "b2g"
        ? await trackingDb
            .select()
            .from(managerStatusIntervals)
            .where(
              and(
                eq(managerStatusIntervals.department, department),
                eq(managerStatusIntervals.managerId, managerId),
                lt(managerStatusIntervals.startedAt, dayEnd),
                or(
                  isNull(managerStatusIntervals.endedAt),
                  gte(managerStatusIntervals.endedAt, dayStart),
                ),
              ),
            )
            .orderBy(asc(managerStatusIntervals.startedAt))
        : [];
    const nowMs = Date.now();
    const dayStartMs = dayStart.getTime();
    const dayEndMs = dayEnd.getTime();
    const statuses: StatusInterval[] = [];
    for (const s of statusRows) {
      if (s.status !== "lunch" && s.status !== "meeting" && s.status !== "day_end") continue;
      const sMs = s.startedAt.getTime();
      let eMs: number;
      if (s.endedAt) {
        eMs = s.endedAt.getTime();
      } else {
        // Открытый интервал красится только в день своего старта (см. /api/tracking).
        if (sMs < dayStartMs || sMs >= dayEndMs) continue;
        eMs = s.status === "day_end" ? dayEndMs : Math.min(nowMs, dayEndMs);
      }
      const startClip = Math.max(sMs, dayStartMs);
      const endClip = Math.min(eMs, dayEndMs);
      if (endClip > startClip) statuses.push({ status: s.status, startMs: startClip, endMs: endClip });
    }

    // Pre-build the timeline so the modal can paint identical segments
    // without recomputing — also gives the modal segment.startMin/endMin
    // bounds it needs to bucket events for hover. Legacy call rows (if any
    // linger in tracking_events) are dropped — analytics is the source.
    const timelineEvents: TimelineEvent[] = rows
      .filter((r) => !isCallType(r.eventType))
      .map((r) => ({
        eventId: r.eventId,
        eventType: r.eventType,
        createdAt: new Date(r.createdAt),
        durationSec: r.durationSec ?? 0,
        entityType: r.entityType,
      }));
    for (const c of callEvents) {
      timelineEvents.push({
        eventId: c.eventId,
        eventType: c.eventType,
        createdAt: c.createdAt,
        durationSec: c.durationSec,
        waitSec: c.waitSec,
        entityType: null,
      });
    }
    const timeline = buildTimeline({
      scheduleRow,
      dateISO,
      tzOffsetMinutes: offset,
      events: timelineEvents,
      selectedCrmTypes,
      statuses,
    });

    // Per-event detail. Filter to selected types + calls so the modal
    // matches what the user sees on the bar. entity_linked / unlinked
    // pass through with their entity_type so the same expansion rule
    // applies on the client (a `lead_linked` filter selection counts
    // entity_linked rows where entity_type='lead').
    const detail: DetailEvent[] = rows
      .filter((r) => {
        // Legacy tracking_events call rows dropped — analytics calls appended below.
        if (isCallType(r.eventType)) return false;
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

    // Append analytics calls to the detail list (same rows the timeline uses).
    for (const c of callEvents) {
      const localMs = c.createdAt.getTime() + offset * 60_000;
      const local = new Date(localMs);
      const hh = String(local.getUTCHours()).padStart(2, "0");
      const mm = String(local.getUTCMinutes()).padStart(2, "0");
      detail.push({
        eventId: c.eventId,
        eventType: c.eventType,
        label: c.eventType === "incoming_call" ? "Входящий звонок" : "Исходящий звонок",
        group: "Звонки",
        createdAt: c.createdAt.toISOString(),
        timeBerlin: `${hh}:${mm}`,
        durationSec: c.durationSec,
        entityType: null,
        entityId: null,
        // waitSec in raw switches EventRow to the разговор/дозвон/недозвон
        // labels — only meaningful when we actually track wait (b2g).
        raw: c.waitSec > 0 ? { waitSec: c.waitSec } : null,
      });
    }
    detail.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return NextResponse.json({
      department,
      manager: { id: manager.id, name: manager.name, line: manager.line },
      date: dateISO,
      timeline,
      events: detail,
      // Сырые интервалы статусов дня — для секции «Статусы» в модалке
      // (админ добавляет/удаляет задним числом через /api/tracking/status).
      statusIntervals: statusRows.map((s) => ({
        id: s.id,
        status: s.status,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt ? s.endedAt.toISOString() : null,
        createdBy: s.createdBy,
      })),
    });
  } catch (err) {
    console.error("[tracking/detail] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
