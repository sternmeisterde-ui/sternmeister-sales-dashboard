-- 0027_bot_roleplays.sql
-- Зеркало тренировок клиентов с ботом ролевок (репо berater_bot, ОТДЕЛЬНЫЙ Neon).
-- ETL-шаг `sync-bot-roleplays` тянет сюда завершённые сессии (full sync).
--
-- Зачем: бот-Neon — отдельный проект, который ЗАСЫПАЕТ при простое (scale-to-zero)
-- и никем не пингуется. При заходе на «Клиентов» он просыпался медленно, живой
-- бот-запрос падал по таймауту драйвера (catch → пусто) → колонка «С ботом» и
-- бот-факторы скоринга пустели у всех, хотя данные есть. Зеркалим в быструю
-- analytics, откуда Funnel читает БЕЗ живой зависимости от спящей бот-БД (ровно
-- как client_roleplays зеркалит D2 client_evaluations).
--
-- finished_at хранится TEXT (как в бот-БД, ISO) — чтения сравнивают лексикографически
-- и группируют по substring(...,1,10). session_id — натуральный ключ (sessions.id),
-- идемпотентно ON CONFLICT DO UPDATE (Neon HTTP-ретраи безопасны).

CREATE TABLE IF NOT EXISTS analytics.bot_roleplays (
  session_id        TEXT PRIMARY KEY,    -- berater_bot sessions.id (натуральный ключ)
  user_id           TEXT,                -- bot users.id (для DISTINCT-пользователей в дневной стате)
  lead_id           BIGINT,              -- users.kommo_lead_id → связь с leads_cohort (NULL = не привязан)
  difficulty        TEXT,                -- level_1/level_2/leicht/mittel/schwer/NULL
  overall_readiness TEXT,                -- самооценка готовности бота (последняя → latestReadiness)
  finished_at       TEXT,                -- ISO-текст как в бот-БД (day-группировка / max)
  synced_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_roleplays_lead ON analytics.bot_roleplays (lead_id);
CREATE INDEX IF NOT EXISTS idx_bot_roleplays_finished ON analytics.bot_roleplays (finished_at);
