-- 0020_leads_cohort_funnel_extras.sql
-- Дополняет analytics.leads_cohort полями, нужными Funnel для точных расчётов
-- после того как cohort-conversion будет снесён. Идемпотентно.
--
-- Что добавляем:
--   - exclude_from_analytics (BOOLEAN) — Kommo CFV 887458, исключает лида из всех расчётов
--   - first_qualification_at (TIMESTAMP) — earliest event_at в lead_status_changes,
--     где status_id попадает в QUAL_FIRST_LINE_STATUSES (anchor для C1/C2/C5)
--   - updated_at (TIMESTAMP) — snapshot Kommo lead.updated_at, для приближения
--     даты дисквалификации (точная дата требует отдельной таблицы CFV-событий — TODO).

ALTER TABLE analytics.leads_cohort
  ADD COLUMN IF NOT EXISTS exclude_from_analytics BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE analytics.leads_cohort
  ADD COLUMN IF NOT EXISTS first_qualification_at TIMESTAMP;

ALTER TABLE analytics.leads_cohort
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_lc_exclude_from_analytics
  ON analytics.leads_cohort (exclude_from_analytics)
  WHERE exclude_from_analytics = TRUE;

CREATE INDEX IF NOT EXISTS idx_lc_first_qualification_at
  ON analytics.leads_cohort (first_qualification_at)
  WHERE first_qualification_at IS NOT NULL;
