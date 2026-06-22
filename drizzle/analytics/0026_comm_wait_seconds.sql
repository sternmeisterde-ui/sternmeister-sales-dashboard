-- 0026_comm_wait_seconds.sql
--
-- Время ожидания ответа абонентом (сек) для звонков из телефонии.
--   • CloudTalk — точное значение из поля `waiting_time`.
--   • CallGear  — приближение `total_duration - talk` (отдельного поля
--                 ожидания у CallGear нет; включает wrap-up).
-- NULL на Kommo-строках и сообщениях (там понятия «ожидание» нет).
--
-- Пишется в sync-telephony.ts (сырые строки) и копируется в fan-out
-- копии в enrich-telephony-leads.ts. Дашборд «Звонки» (B2B) читает
-- AVG по принятым звонкам для карточки «Ожидание (сек)».
--
-- Apply via Neon SQL editor.

ALTER TABLE analytics.communications
  ADD COLUMN IF NOT EXISTS wait_seconds INTEGER;
