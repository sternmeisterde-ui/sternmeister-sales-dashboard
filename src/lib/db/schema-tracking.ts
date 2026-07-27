import {
  pgTable,
  bigserial,
  text,
  integer,
  bigint,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ==================== TRACKING EVENTS (Kommo activity cache) ====================
// Separate Neon project (TRACKING_DATABASE_URL) caching raw Kommo events per
// manager. Sync pulls deltas every ~5 min; timelines are computed from this
// table so filter changes don't require re-fetch from Kommo.

export const trackingEvents = pgTable(
  "tracking_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    department: text("department").notNull(),        // 'b2g' | 'b2b'
    managerId: text("manager_id").notNull(),         // master_managers.id (uuid stored as text — cross-DB)
    kommoUserId: bigint("kommo_user_id", { mode: "number" }).notNull(),
    eventId: text("event_id").notNull(),             // Kommo event.id (string form for stability)
    eventType: text("event_type").notNull(),         // e.g. 'outgoing_call', 'lead_added'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(), // when the event happened in Kommo
    durationSec: integer("duration_sec").notNull().default(0), // resolved for calls, 0 for others
    entityType: text("entity_type"),                 // 'lead' | 'contact' | 'company' | 'customer' | 'unsorted'
    entityId: bigint("entity_id", { mode: "number" }),
    noteId: bigint("note_id", { mode: "number" }),   // for calls — Kommo note.id
    raw: jsonb("raw"),                               // original event (minimal)
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    dedup: uniqueIndex("tracking_events_dedup").on(t.department, t.eventId),
    lookup: index("tracking_events_lookup").on(t.department, t.managerId, t.createdAt),
    byDate: index("tracking_events_by_date").on(t.department, t.createdAt),
  }),
);

export const trackingSyncState = pgTable("tracking_sync_state", {
  department: text("department").primaryKey(),      // 'b2g' | 'b2b'
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastEventTs: timestamp("last_event_ts", { withTimezone: true }),      // max createdAt we saw — delta cursor forward
  earliestEventTs: timestamp("earliest_event_ts", { withTimezone: true }), // min createdAt cached — backfill watermark
  // Bumped when the Kommo fetch logic changes in a way that makes past cache
  // incomplete (e.g. new filter[type][] semantics). On mismatch, ensureRangeCached
  // forces a full re-backfill instead of trusting the earliest_event_ts watermark.
  filterVersion: integer("filter_version").default(0),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// ==================== MANAGER STATUS INTERVALS ====================
// Ручные статусы менеджеров для Активности (просьба Лилии, b2g, 2026-07-22):
// обед / встреча / завершил день. Менеджер включает статус кнопкой в шапке
// вкладки (только «в моменте»); админ может добавлять/удалять задним числом.
// ended_at NULL = статус активен сейчас (day_end — до конца дня).
export const managerStatusIntervals = pgTable(
  "manager_status_intervals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    department: text("department").notNull(),        // 'b2g' | 'b2b'
    managerId: text("manager_id").notNull(),         // master_managers.id
    status: text("status").notNull(),                // 'lunch' | 'meeting' | 'day_end'
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdBy: text("created_by"),                   // 'self' | 'admin:<name>' — аудит
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    lookup: index("manager_status_lookup").on(t.department, t.managerId, t.startedAt),
  }),
);

// ==================== CLOUDTALK STATUS INTERVALS ====================
// Машинная лента присутствия из CloudTalk (Фаза 0 спеки 26): онлайн / на звонке /
// простой с причиной / офлайн. Рисуется ОТДЕЛЬНОЙ дорожкой над основной полоской
// Активности — сознательно не смешиваем с manager_status_intervals: там ручные
// оправдания простоя (3 значения, вводит человек), тут полное присутствие
// (4 значения, источник машинный). Общая таблица сломала бы обе семантики.
export const cloudtalkStatusIntervals = pgTable(
  "cloudtalk_status_intervals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    department: text("department").notNull(),                       // 'b2g' | 'b2b'
    managerId: text("manager_id").notNull(),                        // master_managers.id
    cloudtalkAgentId: bigint("cloudtalk_agent_id", { mode: "number" }).notNull(),
    status: text("status").notNull(),                               // online | idle | on_call | offline
    // Причина простоя — заполняется ТОЛЬКО при status='idle'. CloudTalk держит
    // agentStatusTypeId последним выбранным даже когда человек уже офлайн, так
    // что писать его безусловно = нарисовать всем вечный «обед».
    idleTypeId: integer("idle_type_id"),                            // 17..21 + кастомные
    idleName: text("idle_name"),                                    // расшифровка на момент записи
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),         // NULL = интервал открыт
    // Последний опрос, подтвердивший этот статус. Открытый интервал действителен
    // только ДО last_seen_at: если поллер лежал два часа, эти два часа должны
    // отрисоваться как «нет данных», а не как продолжение статуса.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    lookup: index("cloudtalk_status_lookup").on(t.department, t.managerId, t.startedAt),
    open: index("cloudtalk_status_open").on(t.department, t.endedAt),
  }),
);

export type TrackingEvent = typeof trackingEvents.$inferSelect;
export type NewTrackingEvent = typeof trackingEvents.$inferInsert;
export type TrackingSyncState = typeof trackingSyncState.$inferSelect;
export type ManagerStatusInterval = typeof managerStatusIntervals.$inferSelect;
export type CloudtalkStatusInterval = typeof cloudtalkStatusIntervals.$inferSelect;
