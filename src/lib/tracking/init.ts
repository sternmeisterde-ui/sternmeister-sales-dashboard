import { getTrackingSql } from "@/lib/db/tracking-db";

// Tables are created imperatively on first sync call — avoids running
// drizzle-kit against yet another Neon project during deploys.
// Safe to call on every request (all statements are IF NOT EXISTS).

let initialized = false;

export async function ensureTrackingSchema(): Promise<void> {
  if (initialized) return;
  const sql = getTrackingSql();

  await sql`
    CREATE TABLE IF NOT EXISTS tracking_events (
      id BIGSERIAL PRIMARY KEY,
      department TEXT NOT NULL,
      manager_id TEXT NOT NULL,
      kommo_user_id BIGINT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      entity_type TEXT,
      entity_id BIGINT,
      note_id BIGINT,
      raw JSONB,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS tracking_events_dedup
      ON tracking_events (department, event_id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS tracking_events_lookup
      ON tracking_events (department, manager_id, created_at)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS tracking_events_by_date
      ON tracking_events (department, created_at)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS tracking_sync_state (
      department TEXT PRIMARY KEY,
      last_synced_at TIMESTAMPTZ,
      last_event_ts TIMESTAMPTZ,
      last_error TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Added later — ALTER for existing deployments
  await sql`
    ALTER TABLE tracking_sync_state
    ADD COLUMN IF NOT EXISTS earliest_event_ts TIMESTAMPTZ
  `;
  await sql`
    ALTER TABLE tracking_sync_state
    ADD COLUMN IF NOT EXISTS filter_version INTEGER DEFAULT 0
  `;

  initialized = true;
}
