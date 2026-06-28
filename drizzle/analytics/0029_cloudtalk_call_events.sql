-- 0029_cloudtalk_call_events.sql
--
-- Ground truth по звонкам CloudTalk, пойманный вебхуком (Workflow Automations:
-- Trigger «Call Ended» → Action «API Request» → POST /api/analytics/webhook/cloudtalk).
--
-- Зачем: публичный REST CDR НЕ отдаёт привязку к кампании, поэтому отличить
-- звонок дайлера (Power Dialer кампания) от ручного можно только так —
-- `campaign_id` заполнен у дайлерного и NULL у ручного.
--
-- `call_id` = числовой хвост analytics.communications.communication_id (`ct:<id>`),
-- по нему дайлер-вид джойнит атрибуцию на строки CDR. `raw` хранит весь payload
-- (защитно — не теряем новые/неожиданные поля).
--
-- Идемпотентность: вебхук пишется через ON CONFLICT (call_id) DO UPDATE
-- (повтор/ретрай доставки безопасен; см. docs ETL-architecture).
--
-- Apply via Neon SQL editor (Analytics DB).

CREATE TABLE IF NOT EXISTS analytics.cloudtalk_call_events (
  call_id          TEXT PRIMARY KEY,
  call_uuid        TEXT,
  external_number  TEXT,
  internal_number  TEXT,
  direction        TEXT,
  waiting_time     INTEGER,
  talking_time     INTEGER,
  wrapup_time      INTEGER,
  agent_id         TEXT,
  campaign_id      TEXT,
  campaign_name    TEXT,
  disposition      TEXT,
  raw              JSONB,
  received_at      TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ctce_campaign ON analytics.cloudtalk_call_events (campaign_id);
CREATE INDEX IF NOT EXISTS idx_ctce_received ON analytics.cloudtalk_call_events (received_at);
