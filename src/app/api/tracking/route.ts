// GET /api/tracking?department=b2g&from=2026-04-24&to=2026-04-24&types=a,b,c
// Returns per-manager timelines for a department over the given date range.
import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, lt, inArray, asc, or, isNotNull, notInArray } from "drizzle-orm";
import { db as d1Db } from "@/lib/db";
import { masterManagers, managerSchedule } from "@/lib/db/schema-existing";
import { trackingDb } from "@/lib/db/tracking-db";
import { trackingEvents, trackingSyncState } from "@/lib/db/schema-tracking";
import { ensureFreshSync, ensureRangeCached } from "@/lib/tracking/sync";
import { ensureTrackingSchema } from "@/lib/tracking/init";
import { DEFAULT_SELECTED_KEYS } from "@/lib/tracking/event-types";
import { buildTimeline, buildDialerTimeline, type TimelineEvent, type ScheduleRow, type DialerCall } from "@/lib/tracking/timeline";
import { getAnalyticsCallEventsByMaster, getDialerCallEventsByMaster, getManagerNamesWithComms } from "@/lib/daily/analytics-calls";
import { tzOffsetMinutes } from "@/lib/utils/date";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Tracking renders in Europe/Berlin (matches Daily / Looker / business hours
// modules — single source of truth). Offset is recomputed per-Date so the
// CET↔CEST DST transition doesn't shift "start of day" by ±1h.
function berlinOffsetMin(d: Date): number {
  return tzOffsetMinutes(d, "Europe/Berlin");
}

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
    const managersParam = url.searchParams.get("managers"); // comma-separated manager ids; omit = all
    const skipSync = url.searchParams.get("skipSync") === "1";
    // view=dialer → CloudTalk dialer metrics (talk/wait/counts) instead of the
    // general call/crm/idle timeline. Dialer telephony is B2G-only (CloudTalk),
    // so the toggle is offered only for b2g; a b2b dialer request returns empty.
    const view = url.searchParams.get("view") === "dialer" ? "dialer" : "general";

    if (department !== "b2g" && department !== "b2b") {
      return NextResponse.json({ error: "Invalid department" }, { status: 400 });
    }

    // Auth: admins/ROPs/teamleads (gate role="admin") see the whole team.
    // Plain managers are always locked to their OWN department. Within it:
    //   • B2C (b2b) managers see the WHOLE department's activity (read-only) —
    //     the team is small and peer visibility is wanted (2026-06-14).
    //   • B2G managers stay restricted to their own timeline (unchanged),
    //     mirroring the "only own calls" policy of the OKK tab.
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const isManager = session.role === "manager";
    if (isManager && department !== session.department) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // Only B2G managers are collapsed to their own row; B2C managers see all.
    const ownTimelineOnly = isManager && department === "b2g";
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

    // "today" in Europe/Berlin (not UTC) — client sends local calendar
    // dates and a UTC comparison would miss the "includes today" branch
    // around midnight Berlin time.
    const now = new Date();
    const nowBerlinOffset = berlinOffsetMin(now);
    const todayBerlin = new Date(now.getTime() + nowBerlinOffset * 60_000)
      .toISOString()
      .slice(0, 10);
    const includesToday = todayBerlin >= fromISO && todayBerlin <= toISO;

    // fromISO / toISO are Berlin-local calendar dates. Convert to UTC
    // bounds; offset computed against each boundary's instant so DST flips
    // mid-window stay correct.
    const fromUtc = new Date(`${fromISO}T00:00:00Z`);
    const rangeStart = new Date(
      fromUtc.getTime() - berlinOffsetMin(fromUtc) * 60_000,
    );

    let synced = false;
    if (!skipSync) {
      try {
        // Stale-while-revalidate for "today" view:
        //   - Don't await ensureFreshSync. Whatever is in the cache renders
        //     immediately (cache is always populated post-backfill).
        //   - Sync runs in the background; the next request — or the
        //     5-min auto-refresh in TrackingTab — picks up the new rows.
        //   - Awaiting it added 5-15s to every page load on a busy account
        //     (Kommo rate limit 7 req/sec × ~20 calls per refresh).
        //   - Failures are logged but don't surface; cache is the source of
        //     truth. Watermarks stay correct because syncDepartment is
        //     crash-safe (see sync.ts:301-326).
        if (includesToday) {
          void ensureFreshSync(department, 300).catch((err) =>
            console.warn(`[tracking] async sync (${department}) failed:`, err),
          );
        }
        // Backfill stays synchronous — if user picks a date range we don't
        // have cached, we can't render their request without the data. In
        // practice this is a no-op for >99% of opens because the offline
        // backfill script (or earlier on-demand backfills) already covered
        // everything back to earliest_event_ts. Worst case: a user picks a
        // date older than current earliest, gets a one-time long load.
        const didBackfill = await ensureRangeCached(department, rangeStart);
        synced = didBackfill;
      } catch (err) {
        console.warn("[tracking] sync failed, serving cache:", err);
      }
    }

    // Load managers for this department. Tracking is about per-person call
    // activity — admins are excluded, but the "double-status" convention
    // (project_double_status.md) brings in ROPs who still take calls,
    // signaled by a non-null line. Right now: Татьяна Дерикова, b2g, line='2'.
    // ROPs without a line (e.g. Дмитрий) coordinate, don't dial — stay out.
    // b2g: inactive managers are dropped, so a long-window backfill won't
    // pollute the cache with people who already left. b2b: неактивных
    // (удалённых) НЕ отсекаем на уровне SQL — ниже оставляем из них только
    // тех, у кого есть звонки в выбранном периоде (история удалённого
    // менеджера должна быть видна, как в Звонках/Дейли).
    const rosterConditions = [
      eq(masterManagers.department, department),
      or(
        eq(masterManagers.role, "manager"),
        eq(masterManagers.role, "teamlead"),
        and(eq(masterManagers.role, "rop"), isNotNull(masterManagers.line)),
      ),
    ];
    if (department !== "b2b") {
      rosterConditions.push(eq(masterManagers.isActive, true));
    }
    const rosterRows = await d1Db
      .select({
        id: masterManagers.id,
        name: masterManagers.name,
        line: masterManagers.line,
        shiftStartTime: masterManagers.shiftStartTime,
        shiftEndTime: masterManagers.shiftEndTime,
        isActive: masterManagers.isActive,
        // Only needed to match the session user for the manager-only filter
        // below; not echoed back to the client.
        telegramUsername: masterManagers.telegramUsername,
        kommoUserId: masterManagers.kommoUserId,
        // Телефония: CallGear отдаёт CDR с эмбарго ~7ч (их API), CloudTalk — ~10 мин.
        // Для CG-only менеджеров (напр. Сафронова) показываем пометку о задержке.
        callgearEmployeeId: masterManagers.callgearEmployeeId,
        cloudtalkAgentId: masterManagers.cloudtalkAgentId,
      })
      .from(masterManagers)
      .where(and(...rosterConditions))
      .orderBy(asc(masterManagers.line), asc(masterManagers.name));

    // b2b: «оживляем» soft-deleted менеджеров только за периоды, когда они
    // реально звонили — иначе список навсегда рос бы пустыми строками.
    let allManagers = rosterRows;
    if (department === "b2b" && rosterRows.some((m) => !m.isActive)) {
      try {
        const toUtc = new Date(`${toISO}T00:00:00Z`);
        const fromTs = Math.floor(rangeStart.getTime() / 1000);
        const toTs =
          Math.floor((toUtc.getTime() - berlinOffsetMin(toUtc) * 60_000) / 1000) +
          24 * 3600;
        const namesWithComms = await getManagerNamesWithComms(department, fromTs, toTs);
        // Имя занято активным менеджером → неактивный дубль не оживляем
        // (см. getManagersWithKommoForPeriod — иначе задвоение строк).
        const activeNames = new Set(rosterRows.filter((m) => m.isActive).map((m) => m.name));
        allManagers = rosterRows.filter(
          (m) => m.isActive || (namesWithComms.has(m.name) && !activeNames.has(m.name)),
        );
      } catch (err) {
        console.error("[tracking] revive inactive managers failed:", err);
        allManagers = rosterRows.filter((m) => m.isActive);
      }
    }

    // Own-timeline-only sessions (B2G managers): collapse the roster to the
    // caller's own row. Match by telegram username (the login key) first, then
    // kommoUserId, then exact name — session.userId can't be used directly
    // because it may point at a d1_users/r1_users row, not master_managers.
    const visibleManagers = ownTimelineOnly
      ? allManagers.filter((m) => {
          const tgSession = session.telegramUsername?.toLowerCase() || null;
          const tgMaster = m.telegramUsername?.replace(/^@/, "").toLowerCase() || null;
          if (tgSession && tgMaster) return tgMaster === tgSession;
          if (session.kommoUserId && m.kommoUserId) return m.kommoUserId === session.kommoUserId;
          return m.name === session.name;
        })
      : allManagers;

    if (visibleManagers.length === 0) {
      return NextResponse.json({
        department, view, dates: [], managers: [], allManagers: [], synced,
        lastSyncedAt: null, lastError: null,
      });
    }

    // Apply manager filter — `managers=` selects a subset; absence = all.
    // We always echo back `allManagers` so the UI dropdown can render the
    // full list regardless of the current filter selection. For B2G manager
    // sessions both the dropdown and the subset are already collapsed to the
    // caller's own row (ownTimelineOnly), so `managers=` can't widen their
    // view; B2C managers see and can filter the whole department.
    const selectedManagerIds = managersParam
      ? new Set(managersParam.split(",").filter(Boolean))
      : null;
    const managers = selectedManagerIds
      ? visibleManagers.filter((m) => selectedManagerIds.has(m.id))
      : visibleManagers;

    if (managers.length === 0) {
      return NextResponse.json({
        department,
        view,
        dates: [],
        managers: [],
        allManagers: visibleManagers.map((m) => ({ id: m.id, name: m.name, line: m.line })),
        synced,
        lastSyncedAt: null,
        lastError: null,
      });
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

    // Upper bound for events. Berlin end-of-day = next-day 00:00 in Berlin
    // local, converted to UTC. Compute offset against the to-bound's
    // instant so DST handles correctly.
    const toUtc = new Date(`${toISO}T00:00:00Z`);
    const rangeEnd = new Date(
      toUtc.getTime() + (24 * 60 - berlinOffsetMin(toUtc)) * 60_000,
    );

    // ===== Dialer view (CloudTalk) =====
    // Same 09:00–20:00 timeline shape as the general view (DayTimeline with
    // segments) so the UI renders it with the same TimelineBar — but segments
    // are dialer-native: «разговор» (talk) / «ожидание-дозвон» (wait) / «простой».
    // Sourced from analytics.communications ct: rows. B2G-only: b2b has no
    // dialer, so every day comes back empty (mode off / no segments).
    if (view === "dialer") {
      const dialerEvents =
        department === "b2g"
          ? await getDialerCallEventsByMaster(
              managers.map((m) => ({ id: m.id, name: m.name })),
              department,
              Math.floor(rangeStart.getTime() / 1000),
              Math.floor(rangeEnd.getTime() / 1000),
            )
          : [];

      // Group calls by manager + Berlin-local calendar date (same bucketing as
      // the general path's pushEvent).
      const callsByManagerDate = new Map<string, DialerCall[]>();
      for (const ev of dialerEvents) {
        const localDate = new Date(
          ev.createdAt.getTime() + berlinOffsetMin(ev.createdAt) * 60_000,
        )
          .toISOString()
          .slice(0, 10);
        const key = `${ev.managerId}|${localDate}`;
        let list = callsByManagerDate.get(key);
        if (!list) {
          list = [];
          callsByManagerDate.set(key, list);
        }
        list.push({ startedAt: ev.createdAt, talkSec: ev.talkSec, waitSec: ev.waitSec });
      }

      const dialerManagers = managers.map((m) => ({
        id: m.id,
        name: m.name,
        line: m.line,
        days: dates.map((date) => {
          const sched = scheduleIndex.get(`${m.id}|${date}`) ?? null;
          const effectiveSched: ScheduleRow | null = sched ?? (m.shiftStartTime
            ? {
              scheduleDate: date,
              scheduleValue: "8",
              shiftStartTime: m.shiftStartTime,
              shiftEndTime: m.shiftEndTime,
            }
            : null);
          const dayUtc = new Date(`${date}T00:00:00Z`);
          const dayOffset = berlinOffsetMin(dayUtc);
          const calls = callsByManagerDate.get(`${m.id}|${date}`) ?? [];
          const tl = buildDialerTimeline({
            scheduleRow: effectiveSched,
            dateISO: date,
            tzOffsetMinutes: dayOffset,
            calls,
          });
          return { date, ...tl };
        }),
      }));

      const [dialerSyncState] = await trackingDb
        .select()
        .from(trackingSyncState)
        .where(eq(trackingSyncState.department, department))
        .limit(1);

      return NextResponse.json({
        department,
        view: "dialer",
        dates,
        managers: dialerManagers,
        allManagers: visibleManagers.map((m) => ({ id: m.id, name: m.name, line: m.line })),
        synced,
        lastSyncedAt: dialerSyncState?.lastSyncedAt ?? null,
        lastError: dialerSyncState?.lastError ?? null,
      });
    }

    // CRM (non-call) events from tracking_events. Calls are sourced separately
    // from analytics.communications below — populated by our own ETL pulling
    // CallGear+CloudTalk CDR directly (sync-telephony) plus Kommo call notes
    // (sync-communications). It's the source of truth for all call counts
    // (Звонки/Daily/Dashboard already read from it). Pulling calls from there
    // keeps Активность in lockstep with those tabs and survives Kommo PBX-
    // integration outages.
    const events = await trackingDb
      .select({
        managerId: trackingEvents.managerId,
        eventId: trackingEvents.eventId,
        eventType: trackingEvents.eventType,
        createdAt: trackingEvents.createdAt,
        durationSec: trackingEvents.durationSec,
        // entity_type carries the scope for entity_linked/entity_unlinked
        // (Kommo emits one generic type for all link operations and puts
        // "lead"/"contact"/"company" in this column). buildTimeline uses
        // it to match the entity-specific filter checkboxes.
        entityType: trackingEvents.entityType,
      })
      .from(trackingEvents)
      .where(
        and(
          eq(trackingEvents.department, department),
          inArray(trackingEvents.managerId, managerIds),
          gte(trackingEvents.createdAt, rangeStart),
          lt(trackingEvents.createdAt, rangeEnd),
          // Drop any legacy call rows that were synced from Kommo /notes
          // before we switched to analytics. Belt-and-suspenders — sync.ts
          // no longer writes them, but historic rows linger until cleared.
          notInArray(trackingEvents.eventType, ["incoming_call", "outgoing_call"]),
        ),
      );

    // Calls from analytics.communications — same source as Звонки tab.
    const callEvents = await getAnalyticsCallEventsByMaster(
      managers.map((m) => ({ id: m.id, name: m.name })),
      department,
      Math.floor(rangeStart.getTime() / 1000),
      Math.floor(rangeEnd.getTime() / 1000),
    );

    // Group events by manager + local Berlin calendar date.
    const evByManagerDate = new Map<string, TimelineEvent[]>();
    const pushEvent = (
      managerId: string,
      ev: TimelineEvent,
    ) => {
      const localDate = new Date(
        ev.createdAt.getTime() + berlinOffsetMin(ev.createdAt) * 60_000,
      )
        .toISOString()
        .slice(0, 10);
      const key = `${managerId}|${localDate}`;
      let list = evByManagerDate.get(key);
      if (!list) {
        list = [];
        evByManagerDate.set(key, list);
      }
      list.push(ev);
    };

    for (const e of events) {
      pushEvent(e.managerId, {
        eventId: e.eventId,
        eventType: e.eventType,
        createdAt: new Date(e.createdAt),
        durationSec: e.durationSec ?? 0,
        entityType: e.entityType,
      });
    }
    for (const c of callEvents) {
      pushEvent(c.managerId, {
        eventId: c.eventId,
        eventType: c.eventType,
        createdAt: c.createdAt,
        durationSec: c.durationSec,
        entityType: null,
      });
    }

    // Build timelines
    const result = managers.map((m) => ({
      id: m.id,
      name: m.name,
      line: m.line,
      // CallGear-only менеджер → его звонки приходят с задержкой ~7ч (эмбарго
      // CallGear API). Клиент рисует пометку, чтобы это не выглядело багом.
      callgearDelayed: m.callgearEmployeeId != null && m.cloudtalkAgentId == null,
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
        // tzOffsetMinutes for the rendered day's local 00:00 — Berlin can
        // be CET (60) or CEST (120) depending on the date.
        const dayUtc = new Date(`${date}T00:00:00Z`);
        const dayOffset = berlinOffsetMin(dayUtc);
        const tl = buildTimeline({
          scheduleRow: effectiveSched,
          dateISO: date,
          tzOffsetMinutes: dayOffset,
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
      view: "general",
      dates,
      managers: result,
      // Full list (id+name+line) so the dropdown can render every active
      // manager for this dept regardless of which subset is currently in the
      // `managers=` filter. Stripped of timeline data to keep payload small.
      allManagers: visibleManagers.map((m) => ({ id: m.id, name: m.name, line: m.line })),
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
