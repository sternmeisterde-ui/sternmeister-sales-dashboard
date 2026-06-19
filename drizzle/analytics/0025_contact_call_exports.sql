-- 0025_contact_call_exports.sql
--
-- Состояние выгрузки звонков контакта на Google Drive (фича «папка по оплате»).
--
-- Триггер: B2B-лид попал в статус «Рассрочка» (82946499 / Medical 101858279)
-- или «Успешно реализовано» (WON 142). ETL-шаг detect-won-exports пишет сюда
-- строку pending; отдельный воркер собирает папку «{Имя} {дата оплаты}» из
-- okk_calls (аудио + транскрипты) и заливает на Drive, проставляя done/error.
--
-- Идемпотентность: PK = lead_id, детект делает INSERT ... ON CONFLICT DO
-- NOTHING — повторный заход того же лида в статус не сбрасывает уже сделанную
-- выгрузку. payment_date хранится как готовая строка 'YYYY-MM-DD' в Berlin
-- (она же — имя папки), чтобы не было TZ-двусмысленности при чтении.
--
-- Apply via Neon SQL editor (Drizzle HTTP-драйвер таймаутится на DDL — см.
-- историю миграций 0004/0005/0017).

CREATE TABLE IF NOT EXISTS analytics.contact_call_exports (
  lead_id           BIGINT PRIMARY KEY,
  contact_id        BIGINT,
  contact_name      TEXT,
  payment_date      TEXT,                                  -- 'YYYY-MM-DD' (Berlin), идёт в имя папки
  pipeline_id       BIGINT,
  status_id         BIGINT,
  status            TEXT    NOT NULL DEFAULT 'pending',    -- pending | done | error
  gdrive_folder_id  TEXT,                                  -- id созданной папки на Drive
  folder_name       TEXT,                                  -- '{Имя} {дата}'
  call_count        INTEGER NOT NULL DEFAULT 0,            -- сколько звонков нашли
  uploaded_count    INTEGER NOT NULL DEFAULT 0,            -- сколько залили
  attempts          INTEGER NOT NULL DEFAULT 0,            -- попыток обработки (для backoff/алертов)
  error             TEXT,                                  -- текст последней ошибки
  detected_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Воркер выбирает очередь по статусу.
CREATE INDEX IF NOT EXISTS idx_cce_status
  ON analytics.contact_call_exports (status);
