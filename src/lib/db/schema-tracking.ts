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

export type TrackingEvent = typeof trackingEvents.$inferSelect;
export type NewTrackingEvent = typeof trackingEvents.$inferInsert;
export type TrackingSyncState = typeof trackingSyncState.$inferSelect;
