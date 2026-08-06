// Резервное правило «менеджер на линии» для Дейли b2g (решение 2026-08-06):
// когда в графике (лист «График на месяц» → manager_schedule) нет данных на
// дату, менеджер считается «на линии», если его активность за день > 2 часов.
//
// «Активность» — ровно как во вкладке «Активность»: минуты со звонком
// (analytics.communications, тот же источник, что «Звонки») или CRM-действием
// (tracking_events, сессионная модель buildTimeline), окно 09:00–20:00 Berlin.
// Разница с вкладкой: расписания на такие дни нет по определению, поэтому
// каждому менеджеру подставляется синтетическая полная смена — buildTimeline
// в любом случае рендерит окно 09:00–20:00.
//
// Ограничение: tracking_events бэкфилятся на ~90 дней, глубокая история
// держится только на звонковых минутах — там счёт может быть заниженным.

import { and, eq, gte, lt, inArray, notInArray } from "drizzle-orm";
import { trackingDb } from "@/lib/db/tracking-db";
import { trackingEvents } from "@/lib/db/schema-tracking";
import { ensureTrackingSchema } from "@/lib/tracking/init";
import { DEFAULT_SELECTED_KEYS } from "@/lib/tracking/event-types";
import {
  buildTimeline,
  type TimelineEvent,
  type ScheduleRow,
} from "@/lib/tracking/timeline";
import { getAnalyticsCallEventsByMaster } from "@/lib/daily/analytics-calls";
import { tzOffsetMinutes } from "@/lib/utils/date";

const ACTIVE_MINUTES_THRESHOLD = 120; // > 2 часов

/**
 * Кол-во менеджеров отдела с активностью > 2ч за берлинский день `dateISO`.
 * null — не удалось посчитать (сбой tracking-базы и т.п.): вызывающий код
 * падает на свой прежний fallback.
 */
export async function getActiveByActivityCount(
  department: "b2g" | "b2b",
  dateISO: string,
  managers: Array<{ id: string; name: string }>,
): Promise<number | null> {
  try {
    if (managers.length === 0) return 0;

    // Границы берлинского дня в UTC (offset от инстанта — DST-safe).
    const dayUtc = new Date(`${dateISO}T00:00:00Z`);
    const offset = tzOffsetMinutes(dayUtc, "Europe/Berlin");
    const rangeStart = new Date(dayUtc.getTime() - offset * 60_000);
    const rangeEnd = new Date(dayUtc.getTime() + (24 * 60 - offset) * 60_000);

    await ensureTrackingSchema();
    const managerIds = managers.map((m) => m.id);
    const [crmEvents, callEvents] = await Promise.all([
      trackingDb
        .select({
          managerId: trackingEvents.managerId,
          eventId: trackingEvents.eventId,
          eventType: trackingEvents.eventType,
          createdAt: trackingEvents.createdAt,
          durationSec: trackingEvents.durationSec,
          entityType: trackingEvents.entityType,
        })
        .from(trackingEvents)
        .where(
          and(
            eq(trackingEvents.department, department),
            inArray(trackingEvents.managerId, managerIds),
            gte(trackingEvents.createdAt, rangeStart),
            lt(trackingEvents.createdAt, rangeEnd),
            // Legacy-звонки из Kommo /notes — звонки берём из analytics
            notInArray(trackingEvents.eventType, ["incoming_call", "outgoing_call"]),
          ),
        ),
      getAnalyticsCallEventsByMaster(
        managers,
        department,
        Math.floor(rangeStart.getTime() / 1000),
        Math.floor(rangeEnd.getTime() / 1000),
      ),
    ]);

    const byManager = new Map<string, TimelineEvent[]>();
    const push = (managerId: string, ev: TimelineEvent) => {
      let list = byManager.get(managerId);
      if (!list) {
        list = [];
        byManager.set(managerId, list);
      }
      list.push(ev);
    };
    for (const e of crmEvents) {
      push(e.managerId, {
        eventId: e.eventId,
        eventType: e.eventType,
        createdAt: new Date(e.createdAt),
        durationSec: e.durationSec ?? 0,
        entityType: e.entityType,
      });
    }
    for (const c of callEvents) {
      push(c.managerId, {
        eventId: c.eventId,
        eventType: c.eventType,
        createdAt: c.createdAt,
        durationSec: c.durationSec,
        waitSec: c.waitSec,
        entityType: null,
      });
    }

    // Синтетическая полная смена: расписания на этот день нет по условию
    // задачи, а buildTimeline без scheduleRow вернул бы mode="off" / 0 минут.
    const syntheticShift: ScheduleRow = {
      scheduleDate: dateISO,
      scheduleValue: "8",
      shiftStartTime: "09:00",
      shiftEndTime: "20:00",
    };
    const selectedCrmTypes = new Set<string>(DEFAULT_SELECTED_KEYS);

    let count = 0;
    for (const m of managers) {
      const events = byManager.get(m.id);
      if (!events || events.length === 0) continue;
      const tl = buildTimeline({
        scheduleRow: syntheticShift,
        dateISO,
        tzOffsetMinutes: offset,
        events,
        selectedCrmTypes,
      });
      if (tl.minutes.call + tl.minutes.crm > ACTIVE_MINUTES_THRESHOLD) count++;
    }
    return count;
  } catch (e) {
    console.error(`[Daily] activity-online fallback (${department} ${dateISO}):`, e);
    return null;
  }
}
