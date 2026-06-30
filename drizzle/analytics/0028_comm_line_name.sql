-- 0028_comm_line_name.sql
--
-- Имя номера CloudTalk (`CallNumber.internal_name`, напр. «KOM mobile 2» /
-- «GOS landline 3») для телефонных строк. Нужно для атрибуции отдела ПО
-- НОМЕРУ — как считает сам CloudTalk: входящие относятся к группе по номеру
-- (включая непринятые без оператора). NULL на CallGear/Kommo-строках.
--
-- sync-telephony.ts заполняет; дашборд считает входящие B2B по
-- `line_name LIKE 'KOM%'`. Added in 0028.
--
-- Apply via Neon SQL editor (Analytics DB).

ALTER TABLE analytics.communications
  ADD COLUMN IF NOT EXISTS line_name TEXT;
