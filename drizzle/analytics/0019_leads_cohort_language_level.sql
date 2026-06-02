-- 0019_leads_cohort_language_level.sql
-- Добавляет language_level — текст из Kommo CFV 869928 (LANGUAGE_LEVEL).
-- Используется Funnel Dashboard для раскладки когорт по уровню языка
-- (A2/B1/B2/C1/Без оценки). См. dev_docs/funnel/04.
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS.

ALTER TABLE analytics.leads_cohort
  ADD COLUMN IF NOT EXISTS language_level TEXT;

CREATE INDEX IF NOT EXISTS idx_lc_language_level
  ON analytics.leads_cohort (language_level);
