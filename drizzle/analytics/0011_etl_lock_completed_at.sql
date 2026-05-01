-- 0011_etl_lock_completed_at.sql
--
-- Add last_completed_at to analytics.etl_locks so /api/health/etl can
-- distinguish "cron is alive but Kommo has no events" (e.g., night hours
-- when nobody calls or chats) from "cron itself is broken".
--
-- Without this, the previous health-endpoint logic of `NOW() - MAX(created_at)`
-- false-positives every night around 02:00–06:00 Berlin: the cron ticks fine
-- with `comms=0 telephony=0`, but the analytics tables have no fresh row, so
-- MAX(created_at) stays frozen at last evening's last event and the badge
-- goes red even though everything is healthy.
--
-- New shape:
--   `expires_at <= now()` AND `last_completed_at IS NOT NULL`  =  released cleanly
--   `expires_at >  now()` AND `last_completed_at IS NULL`      =  currently held
--   row missing                                                =  never run
--
-- Health endpoint now checks `now() - last_completed_at < threshold` for
-- liveness — ground truth.

ALTER TABLE analytics.etl_locks
  ADD COLUMN IF NOT EXISTS last_completed_at timestamp;
