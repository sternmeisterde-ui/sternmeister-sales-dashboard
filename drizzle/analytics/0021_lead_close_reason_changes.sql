-- 0021_lead_close_reason_changes.sql
-- История изменений Kommo CFV 879824 ("Причина закрытия госники").
-- Нужна для точного определения disqualified_at у Funnel C1/C2/C5 базы и
-- для replikации логики cohort-conversion's qualification.py.
--
-- Источник: Kommo /api/v4/events?filter[type]=custom_field_879824_value_changed.
-- Идемпотентно по event_id (как в cohort-conversion's raw_events).

CREATE TABLE IF NOT EXISTS analytics.lead_close_reason_changes (
  event_id        TEXT PRIMARY KEY,
  lead_id         BIGINT NOT NULL,
  event_at        TIMESTAMP NOT NULL,
  enum_id_before  BIGINT,
  enum_id_after   BIGINT,
  created_by      BIGINT,
  synced_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lcrc_lead_event
  ON analytics.lead_close_reason_changes (lead_id, event_at);

CREATE INDEX IF NOT EXISTS idx_lcrc_event_at
  ON analytics.lead_close_reason_changes (event_at);
