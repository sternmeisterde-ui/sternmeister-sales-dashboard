-- =====================================================================
-- enps_responses — зеркало еженедельного анонимного пульс-опроса eNPS
-- (b2g «Гос ОП»). Источник: Typeform → Google Sheets → синк
-- src/lib/enps/sync.ts (upsert по token = Typeform response token).
--
-- Ответы анонимны: никаких ссылок на master_managers.
--
-- Apply once via Neon SQL editor (D1 / DATABASE_URL)
-- или scripts/seed-enps-from-json.ts (делает CREATE TABLE IF NOT EXISTS).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.enps_responses (
  id           SERIAL PRIMARY KEY,
  department   TEXT NOT NULL DEFAULT 'b2g',
  token        TEXT NOT NULL UNIQUE,
  score        INTEGER NOT NULL,
  supports     TEXT,
  frustrates   TEXT,
  submitted_at TIMESTAMPTZ NOT NULL,
  synced_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enps_responses_submitted_idx
  ON public.enps_responses (department, submitted_at);

COMMENT ON TABLE public.enps_responses IS
  'Еженедельный анонимный пульс-опрос менеджеров (eNPS): балл 0–10 + открытые вопросы. Зеркало Google Sheets (Typeform), upsert по token.';
COMMENT ON COLUMN public.enps_responses.token IS
  'Typeform response token — natural key идемпотентного апсерта.';
COMMENT ON COLUMN public.enps_responses.score IS
  '«Как ты оцениваешь свое эмоциональное состояние на этой неделе?» 0–10.';
COMMENT ON COLUMN public.enps_responses.supports IS
  '«Что сильнее всего поддерживает тебя и помогает тебе в работе?»';
COMMENT ON COLUMN public.enps_responses.frustrates IS
  '«Что сильнее всего расстраивает и мешает тебе в работе?»';
COMMENT ON COLUMN public.enps_responses.submitted_at IS
  'Момент отправки формы (Typeform пишет в Sheets в UTC).';

COMMIT;
