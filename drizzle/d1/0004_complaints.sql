-- =====================================================================
-- complaints — реестр жалоб менеджеров на оценки ОКК/ролевок для вкладки
-- «Жалобы» (обе линии b2g/b2b). Агрегат двух существующих механизмов подачи:
--   • error_report — форма «Отправить жалобу» в попапе звонка →
--     evaluation_error_reports в Neon-базе «daily» (исторически b2g);
--   • bug_report — попап «Сообщить об ошибке» → bug_reports в D1
--     (исторически b2b; берём только строки менеджеров/тимлидов).
-- Наполнение: dual-write из обоих POST-роутов + догоняющий синк
-- (src/lib/complaints/ingest.ts, строки с created_at >= 2026-08-01).
--
-- Снимки оценок (eval_before/eval_after, FrozenEvalPayload из
-- src/lib/eval/snapshot.ts) ЗАМОРОЖЕНЫ на момент подачи/решения: переоценка
-- в ОКК перезаписывает строку evaluations (UPSERT), а cleanup-job со
-- временем удаляет старые звонки — задним числом не восстановить.
--
-- Apply once via Neon SQL editor (D1 / DATABASE_URL).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.complaints (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source            TEXT NOT NULL CHECK (source IN ('error_report', 'bug_report')),
  source_id         TEXT NOT NULL,
  department        TEXT NOT NULL CHECK (department IN ('b2g', 'b2b')),
  manager_name      TEXT,
  manager_telegram  TEXT,
  master_manager_id UUID,
  call_id           UUID,
  call_source       TEXT CHECK (call_source IN ('okk', 'ai')),
  text              TEXT NOT NULL,
  filed_at          TIMESTAMPTZ NOT NULL,
  score_before      INTEGER,
  eval_before       JSONB,
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'in_review', 'resolved', 'rejected', 'not_complaint')),
  verdict           TEXT CHECK (verdict IN ('valid', 'partial', 'invalid')),
  decision          TEXT,
  resolved_at       TIMESTAMPTZ,
  resolved_by       TEXT,
  score_after       INTEGER,
  eval_after        JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Идемпотентный ingest: одна строка реестра на строку источника.
CREATE UNIQUE INDEX IF NOT EXISTS complaints_source_uq
  ON public.complaints (source, source_id);

CREATE INDEX IF NOT EXISTS complaints_dept_filed_idx
  ON public.complaints (department, filed_at);
CREATE INDEX IF NOT EXISTS complaints_status_idx
  ON public.complaints (status);
CREATE INDEX IF NOT EXISTS complaints_master_mgr_idx
  ON public.complaints (master_manager_id);
CREATE INDEX IF NOT EXISTS complaints_call_idx
  ON public.complaints (call_id);

COMMENT ON TABLE public.complaints IS
  'Реестр жалоб менеджеров на оценки (вкладка «Жалобы»): агрегат evaluation_error_reports (daily-БД) + bug_reports. Снимки оценок «до/после» заморожены в jsonb — переоценка/удаление звонка их не меняет.';
COMMENT ON COLUMN public.complaints.source IS
  'Механизм подачи: error_report = форма «Отправить жалобу» в попапе звонка (daily-БД), bug_report = попап «Сообщить об ошибке» (D1).';
COMMENT ON COLUMN public.complaints.source_id IS
  'id строки в исходной таблице (текстом: типы id источников разные). UNIQUE(source, source_id) — идемпотентный ingest.';
COMMENT ON COLUMN public.complaints.department IS
  'Отдел: b2g (Госники) | b2b (Коммерсы).';
COMMENT ON COLUMN public.complaints.manager_name IS
  'Менеджер-субъект жалобы: у error_report — менеджер звонка, у bug_report — автор репорта.';
COMMENT ON COLUMN public.complaints.manager_telegram IS
  'Telegram-username подавшего (без гарантии @-префикса) — ключ владения для «менеджер видит только своё».';
COMMENT ON COLUMN public.complaints.master_manager_id IS
  'Resolved-ссылка на master_managers.id (матч telegram → kommo_user_id → имя). NULL — не смэтчили; владение тогда по telegram/имени.';
COMMENT ON COLUMN public.complaints.call_id IS
  'Звонок, на оценку которого жалоба (uuid в D2/R2 либо D1/R1 по call_source). NULL у bug_report — жалоба без привязки к звонку.';
COMMENT ON COLUMN public.complaints.call_source IS
  'Где живёт звонок: okk = реальный звонок (D2/R2), ai = ролевка (D1/R1).';
COMMENT ON COLUMN public.complaints.text IS
  'Текст жалобы (свободный текст менеджера).';
COMMENT ON COLUMN public.complaints.filed_at IS
  'Момент подачи = created_at исходной строки (не время ingest).';
COMMENT ON COLUMN public.complaints.score_before IS
  'Балл (0–100) на момент подачи. Для error_report — из call_score исходной строки (авторитетен); иначе из снимка.';
COMMENT ON COLUMN public.complaints.eval_before IS
  'Замороженный снимок детализации оценки на момент регистрации (FrozenEvalPayload: blocks/meta/score, без транскрипта и аудио). NULL — bug_report без звонка либо звонок уже удалён.';
COMMENT ON COLUMN public.complaints.status IS
  'Статус обработки: new (Новая) → in_review (В работе) → resolved (Рассмотрена) | rejected (Отклонена); not_complaint — триаж: строка bug_reports оказалась обычным баг-репортом, скрыта от менеджеров.';
COMMENT ON COLUMN public.complaints.verdict IS
  'Вердикт адъюдикатора OKK: valid | partial | invalid (схема _adjudicator_brief.md в OKK-репо). NULL — решение вручную без вердикта.';
COMMENT ON COLUMN public.complaints.decision IS
  'Решение по жалобе свободным текстом («оценка пересмотрена: 42→67», «сделка изъята», …).';
COMMENT ON COLUMN public.complaints.resolved_at IS
  'Момент перехода в resolved/rejected (ставится автоматически).';
COMMENT ON COLUMN public.complaints.resolved_by IS
  'Кто закрыл: имя админа из сессии либо ''okk-adjudicator'' (batch-API).';
COMMENT ON COLUMN public.complaints.score_after IS
  'Балл после рассмотрения (снимок текущей оценки в момент решения). NULL — звонок без оценки/удалён/изъят.';
COMMENT ON COLUMN public.complaints.eval_after IS
  'Замороженный снимок детализации после рассмотрения (FrozenEvalPayload). Замораживается один раз; повторный resolve его не перезаписывает.';

COMMIT;
