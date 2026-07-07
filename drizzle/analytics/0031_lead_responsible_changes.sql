-- Смены ответственного по лидам (Kommo events: entity_responsible_changed).
-- Нужны вкладке «Регламент»: по документу РОПа показатели «Время на этапах»
-- и TLT считаются ПО ПЕРИОДАМ ОТВЕТСТВЕННОСТИ за сделку — при передаче лида
-- отсчёт начинается заново, и проверка приписывается владельцу периода
-- (лист «ПРАВКИ» xlsx: пункты 10-11, 20, 32, 34).
-- Наполнение: scripts/backfill-responsible-changes.ts (+ ETL-шаг
-- sync-responsible-changes в инкрементальном кроне).

CREATE TABLE IF NOT EXISTS analytics.lead_responsible_changes (
  event_id text PRIMARY KEY,          -- Kommo event.id — natural key, upsert-идемпотентность
  lead_id bigint NOT NULL,
  event_at timestamp NOT NULL,        -- naive UTC, как во всех analytics.*
  old_user_id bigint,                 -- value_before.responsible_user.id
  new_user_id bigint,                 -- value_after.responsible_user.id
  synced_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lrc_lead_event ON analytics.lead_responsible_changes (lead_id, event_at);

COMMENT ON TABLE analytics.lead_responsible_changes IS
  'Смены ответственного по лидам из Kommo events (entity_responsible_changed). Для регламентных метрик по периодам ответственности.';
