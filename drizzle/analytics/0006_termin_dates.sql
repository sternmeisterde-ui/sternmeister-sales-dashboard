-- 0006_termin_dates.sql
--
-- Termin dashboard support. Adds two date-typed custom-field mirrors to
-- analytics.leads_cohort so we can compute the average days between deal
-- creation → assigned Termin DC and creation/DC-held → Termin AA without
-- hitting Kommo on every dashboard render.
--
-- Sources (Kommo lead.custom_fields_values, looked up by field NAME exactly
-- like B2B payment fields — field IDs vary per pipeline/account):
--   termin_date     ← "Дата термина"     (B2G Бух Бератер pipeline 12154099)
--   aa_termin_date  ← "Дата термина АА"
--
-- ETL: src/lib/etl/sync-leads.ts populates on every incremental + full-range
-- sync via the same parseDate path as firstPaymentDate. Existing rows get
-- backfilled the next time the lead falls into the sync window.
--
-- Apply via Neon SQL editor (HTTP serverless driver has timed out on
-- ALTER TABLE in the past — see 0004 vs 0005 history).

ALTER TABLE analytics.leads_cohort
  ADD COLUMN IF NOT EXISTS termin_date    TIMESTAMP,
  ADD COLUMN IF NOT EXISTS aa_termin_date TIMESTAMP;

-- Composite index for the Termin dashboard cohort query: filter by
-- pipeline_id + created_at range, then aggregate. Partial WHERE keeps the
-- index narrow — only leads that actually carry a termin participate.
CREATE INDEX IF NOT EXISTS idx_lc_termin_cohort
  ON analytics.leads_cohort (pipeline_id, created_at)
  WHERE termin_date IS NOT NULL OR aa_termin_date IS NOT NULL;
