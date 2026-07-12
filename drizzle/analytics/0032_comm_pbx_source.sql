-- 0032_comm_pbx_source.sql
--
-- Исходный провайдер звонка из Kommo /notes (params.source), например
-- «cloudtalk», «CallGear», «WhatsApp (GPT)», «amo_zadarma». NULL на
-- строках прямого CDR-пулла (cg-leg:/ct:) — у них источник и так виден
-- по префиксу communication_id. Заполняется только sync-foreign-calls.ts
-- для «чужих» call-заметок (не CloudTalk/CallGear), которые CDR не видит
-- (напр. WhatsApp-звонки через Wazzup, Zadarma).
--
-- Apply via Neon SQL editor (Analytics DB).

ALTER TABLE analytics.communications
  ADD COLUMN IF NOT EXISTS pbx_source TEXT;
