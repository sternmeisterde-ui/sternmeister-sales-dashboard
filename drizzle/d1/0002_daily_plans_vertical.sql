-- =====================================================================
-- daily_plans.vertical — измерение Бух/Мед для планов Дейли (b2g).
-- Мед-админ = вертикаль внутри b2g (spec 21): планы хранятся раздельно
-- per vertical. Все существующие строки — бухгалтерия ('buh').
-- Для b2b колонка не осмысленна — остаётся 'buh' (дефолт), reads b2b её
-- игнорируют.
--
-- Заодно закрываем давний пробел: у daily_plans не было UNIQUE-констрейнта
-- (upsert делался select-then-insert). Добавляем два partial unique-индекса
-- (user_id NULL = план линии, NOT NULL = персональный план) с предварительной
-- дедупликацией (оставляем самую свежую строку).
--
-- Apply once via Neon SQL editor (D1 / DATABASE_URL).
-- =====================================================================

BEGIN;

ALTER TABLE public.daily_plans
  ADD COLUMN IF NOT EXISTS vertical TEXT NOT NULL DEFAULT 'buh';

COMMENT ON COLUMN public.daily_plans.vertical IS
  'Вертикаль b2g: ''buh'' (бухгалтерия) | ''med'' (мед админ). Для b2b всегда ''buh'' (не используется). См. dev_docs/specs/21.';

-- Дедупликация перед созданием unique-индексов: оставляем строку с
-- максимальным updated_at (при равенстве — максимальный id).
DELETE FROM public.daily_plans dp
USING public.daily_plans dup
WHERE dp.department = dup.department
  AND dp.vertical = dup.vertical
  AND dp.line = dup.line
  AND dp.metric_key = dup.metric_key
  AND dp.period_type = dup.period_type
  AND dp.period_date = dup.period_date
  AND dp.user_id IS NOT DISTINCT FROM dup.user_id
  AND (COALESCE(dup.updated_at, dup.created_at, 'epoch'::timestamptz), dup.id)
    > (COALESCE(dp.updated_at, dp.created_at, 'epoch'::timestamptz), dp.id);

CREATE UNIQUE INDEX IF NOT EXISTS daily_plans_line_uniq
  ON public.daily_plans (department, vertical, line, metric_key, period_type, period_date)
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS daily_plans_user_uniq
  ON public.daily_plans (department, vertical, line, metric_key, period_type, period_date, user_id)
  WHERE user_id IS NOT NULL;

COMMIT;
