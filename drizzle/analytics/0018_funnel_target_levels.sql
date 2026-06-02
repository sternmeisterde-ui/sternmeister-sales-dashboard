-- 0018_funnel_target_levels.sql
-- Хранение целевого уровня (benchmark) per-conversion для Funnel Dashboard.
-- См. dev_docs/funnel/04 §2 / Этап K.
--
-- conversion_id: "C1".."C5"
-- conversion_pct: NULL = цель не задана; иначе 0..100

CREATE TABLE IF NOT EXISTS analytics.funnel_target_levels (
  conversion_id   TEXT PRIMARY KEY,
  conversion_pct  NUMERIC(5, 2),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by      TEXT
);
