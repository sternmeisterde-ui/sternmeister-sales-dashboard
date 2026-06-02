-- 0022_leads_cohort_is_deleted.sql
-- Флаг is_deleted на лиде. Заполняется ETL-шагом sync-lead-deletions,
-- который тянет события lead_deleted из Kommo /api/v4/events.
-- Идемпотентно.

ALTER TABLE analytics.leads_cohort
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE analytics.leads_cohort
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_lc_is_deleted
  ON analytics.leads_cohort (is_deleted)
  WHERE is_deleted = TRUE;
