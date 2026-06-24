-- 0028_bot_users.sql
-- Зеркало РЕГИСТРАЦИЙ пользователей бота ролевок (репо berater_bot, отдельный Neon).
-- ETL-шаг `sync-bot-users` тянет сюда таблицу `users` (full sync).
--
-- Зачем: `analytics.bot_roleplays` хранит только СЕССИИ — у не-тренировавшегося
-- клиента строк там нет, поэтому «0 тренировок» нельзя отличить от «вообще не в
-- боте». Регистрации (users) дают этот сигнал: запись с kommo_lead_id = клиент
-- заведён в боте. Используется в «Клиентах» (донат «Тренировки с ботом»: сегмент
-- «0» делится на «В боте, 0» и «Не в боте») и потенциально в скоринге.
--
-- user_id — натуральный ключ (bot users.id), идемпотентно ON CONFLICT DO UPDATE.
-- created_at/last_seen_at хранятся TEXT (как в бот-БД) — нам нужен факт записи, а
-- не точные таймстемпы.

CREATE TABLE IF NOT EXISTS analytics.bot_users (
  user_id           TEXT PRIMARY KEY,    -- berater_bot users.id
  kommo_lead_id     BIGINT,              -- связь с leads_cohort (NULL = не привязан к сделке)
  kommo_contact_id  BIGINT,
  phone_normalized  TEXT,
  access_status     TEXT,
  access_authorized BOOLEAN,
  created_at        TEXT,
  last_seen_at      TEXT,
  synced_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_users_lead ON analytics.bot_users (kommo_lead_id);
