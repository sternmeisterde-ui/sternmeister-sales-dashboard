-- 0007_b2b_close_reason.sql
--
-- B2B SLA gate support. Adds the enum_id of Kommo custom field 876383
-- "Причины закрытия (Обязательное поле)" to analytics.leads_cohort.
-- This is the field B2B (Бух Комм / Мед Комм) actually uses for closing
-- reasons — not the standard loss_reason_id, which managers leave NULL.
-- Kommo enforces it as required when status_id=143 (Closed-lost) on
-- pipelines 10631243 (Бух Комм) and 13209983 (Мед Комм).
--
-- Enum values relevant to the SLA filter:
--   740587  Неквал лид
--   740593  Спам
--   740595  Предложение сотрудничества
-- See `analytics.refusal_enums` for the full table once ETL backfills it
-- (existing table already stores B2G enums for field 879824, same shape).
--
-- Apply via Neon SQL editor (HTTP serverless has timed out on ALTER in the
-- past — see 0004 vs 0005 history).

ALTER TABLE analytics.leads_cohort
  ADD COLUMN IF NOT EXISTS b2b_close_reason_enum_id BIGINT;

-- The SLA filter scans cohorts within (pipeline_id, created_at) windows
-- already, so we only need a narrow helper for the Looker JOIN. Partial
-- keeps it small — only closed-lost rows participate.
CREATE INDEX IF NOT EXISTS idx_lc_b2b_close_reason
  ON analytics.leads_cohort (b2b_close_reason_enum_id)
  WHERE b2b_close_reason_enum_id IS NOT NULL;
