-- 0008_tlt_seconds.sql
--
-- TLT (Time between Latest Touches) — добавляет колонку для нового
-- определения метрики: BH-разница между двумя последними call_out от
-- ответственного менеджера лида. NULL = 0 или 1 звонок этого менеджера.
--
-- compute-sla.ts заполняет на каждом ETL-тике. Looker TLT-views
-- читают из этой колонки.
--
-- Apply via Neon SQL editor.

ALTER TABLE analytics.sla
  ADD COLUMN IF NOT EXISTS tlt_seconds BIGINT;
