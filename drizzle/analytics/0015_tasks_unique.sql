-- 0015_tasks_unique.sql
--
-- Add a unique index on analytics.tasks(task_id) so future INSERTs are
-- idempotent under the Neon HTTP retry hazard (see docs/etl-architecture.md
-- and migration 0014 for the same fix on lead_status_changes).
--
-- Why now: sync-tasks runs only in non-incremental mode (full backfills),
-- so the hazard hasn't fired yet — current dupe count is 0. We're closing
-- the gap before it does, per the architectural rule that every ETL writer
-- must have a unique index + ON CONFLICT.
--
-- The dedupe step is included for symmetry with 0014 — it will be a no-op
-- against current data but will save the day if anyone runs a backfill
-- against a transient-prone Neon between this commit and the deploy.
--
-- task_id is Kommo's global task identifier; one (task_id) row is the
-- single source of truth for a task. Mutable fields (deadline, manager,
-- completion state) are refreshed on conflict by the new ON CONFLICT
-- UPDATE in sync-tasks.ts.

DELETE FROM analytics.tasks a
USING analytics.tasks b
WHERE a.ctid    < b.ctid
  AND a.task_id = b.task_id;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_task_id_unique
  ON analytics.tasks (task_id);
