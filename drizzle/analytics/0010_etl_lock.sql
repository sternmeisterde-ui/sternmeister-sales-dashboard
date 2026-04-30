-- 0010_etl_lock.sql
--
-- Lease-style lock table for the incremental ETL cron. Replaces the earlier
-- attempt at pg_try_advisory_lock, which doesn't work over Neon's HTTP driver
-- (each query is a fresh connection — session-scoped advisory locks are
-- released the moment the lock query returns).
--
-- Semantics:
--   • One row per lock name (`name = 'cron'`).
--   • A tick acquires the lease by INSERT…ON CONFLICT DO UPDATE WHERE the
--     existing row has expired. Expiry is `expires_at < now()`.
--   • Lease is held until `expires_at` (or until the tick releases it).
--   • If a tick crashes and never releases, the next tick takes the lease
--     once `expires_at` passes — bounded staleness, no deadlock.
--
-- Released by `DELETE WHERE name = 'cron' AND token = <our-token>` so two
-- concurrent ticks can't accidentally release each other's lease.

CREATE TABLE IF NOT EXISTS analytics.etl_locks (
  name        text PRIMARY KEY,
  token       text NOT NULL,
  acquired_at timestamp NOT NULL DEFAULT now(),
  expires_at  timestamp NOT NULL,
  -- Defends against a lease-math regression (e.g., negative interval) that
  -- would silently insert an already-expired row, letting every subsequent
  -- tick acquire concurrently. The cron route uses NOW() + interval, so
  -- this is structurally always satisfied — the constraint is here so a
  -- future caller that does it wrong fails loudly at INSERT time.
  CONSTRAINT etl_locks_expires_after_acquired
    CHECK (expires_at > acquired_at)
);
