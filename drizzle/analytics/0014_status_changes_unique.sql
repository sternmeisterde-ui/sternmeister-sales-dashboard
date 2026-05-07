-- 0014_status_changes_unique.sql
--
-- Dedupe analytics.lead_status_changes and add a unique index on
-- (lead_id, event_at, status_id) so future INSERTs are idempotent.
--
-- Why this is needed:
--   sync-status-changes used to DELETE the window then INSERT chunked rows.
--   Pattern was race-prone in two ways:
--     1. Neon HTTP retry hazard — if a chunked INSERT committed server-side
--        but the response was lost in transit, the fetch wrapper retried and
--        the same chunk landed twice. Without a unique index, both copies
--        survived. The hazard widened in 2026-05-07 when retries went 3→5.
--     2. Concurrent backfill running while cron ticks — both passes DELETE
--        the same window then re-INSERT, same outcome.
--
--   `analytics.communications` already had a unique index on
--   (communication_id, COALESCE(lead_id, 0)) and ON CONFLICT DO UPDATE,
--   which is why that table had 0 dupes while this one accumulated 20+
--   groups across the last week.
--
-- Cleanup (kept the lowest ctid per group, deletes the duplicate copies):
--   `lead_id`, `event_at`, `status_id` is the natural identity of a single
--   pipeline transition — the rest of the columns either match (pipeline,
--   manager) or are recomputed by the window-function UPDATE that follows
--   every sync (last_event_at, next_status_id, next_event_at), so dropping
--   duplicate rows loses no information.

DELETE FROM analytics.lead_status_changes a
USING analytics.lead_status_changes b
WHERE a.ctid     < b.ctid
  AND a.lead_id  = b.lead_id
  AND a.event_at = b.event_at
  AND a.status_id = b.status_id;

CREATE UNIQUE INDEX IF NOT EXISTS lead_status_changes_unique
  ON analytics.lead_status_changes (lead_id, event_at, status_id);
