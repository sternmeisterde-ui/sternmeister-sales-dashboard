-- 0023_client_roleplays.sql
-- Зеркало объективных оценок клиентских ролевок из ОКК (D2 `client_evaluations`).
-- Источник: соседний репо OKK, подсистема client-roleplay scoring (только D2/Госники).
-- ETL-шаг `sync-client-roleplays` тянет сюда строки с roleplay_present=true.
--
-- Зачем: воронка (analytics.*) не может JOIN'ить D2 (другой Neon-проект), поэтому
-- зеркалим оценки в Analytics, где их читает Funnel по lead_id (§3.4, Phase 2).
-- Идемпотентно по okk_call_id (= D2 client_evaluations.call_id, UNIQUE).
--
-- roleplay_at хранится как UTC-наивный TIMESTAMP (как остальные analytics-таблицы):
-- Funnel конвертит в Europe/Berlin через (x AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin'.

CREATE TABLE IF NOT EXISTS analytics.client_roleplays (
  okk_call_id      UUID PRIMARY KEY,        -- D2 client_evaluations.call_id (натуральный ключ)
  lead_id          BIGINT,                  -- D2 kommo_lead_id → связь с leads_cohort
  side             TEXT NOT NULL,           -- 'dc' (ДЦ) | 'aa' (АА)
  attempt          INTEGER,                 -- roleplay_number 1..3
  roleplay_at      TIMESTAMP,               -- дата звонка-ролевки (calls.call_created_at, UTC)
  score_5          INTEGER,                 -- оценка 1..5 (ТЗ §7.4)
  score_percent    INTEGER,                 -- 0..100 (для breakdown / точности)
  criterion_scores JSONB,                   -- разбивка по 6 критериям (для карточки)
  model_used       TEXT,                    -- трассировка (какая модель оценивала)
  gate_reason      TEXT,                    -- трассировка (почему засчитано)
  synced_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_roleplays_lead_side
  ON analytics.client_roleplays (lead_id, side);

CREATE INDEX IF NOT EXISTS idx_client_roleplays_roleplay_at
  ON analytics.client_roleplays (roleplay_at);
