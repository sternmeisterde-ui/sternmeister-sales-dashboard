-- =====================================================================
-- complaints: колонка ручного комментария + упрощение статусов.
-- Решение владельца 2026-08-05: статусы «В работе» (in_review) и
-- «Не жалоба» (not_complaint) убраны — рабочий цикл только
-- new → resolved | rejected. Строк с удаляемыми статусами в таблице нет
-- (реестр запущен в этот же день), поэтому пересоздание CHECK безопасно.
--
-- Apply once via Neon SQL editor (D1 / DATABASE_URL).
-- =====================================================================

BEGIN;

ALTER TABLE public.complaints ADD COLUMN IF NOT EXISTS comment TEXT;

COMMENT ON COLUMN public.complaints.comment IS
  'Ручной комментарий по жалобе (пишут админ/РОП из вкладки; не путать с decision — итогом разбора адъюдикатора).';

ALTER TABLE public.complaints DROP CONSTRAINT IF EXISTS complaints_status_check;
ALTER TABLE public.complaints ADD CONSTRAINT complaints_status_check
  CHECK (status IN ('new', 'resolved', 'rejected'));

COMMENT ON COLUMN public.complaints.status IS
  'Статус обработки: new (Новая) → resolved (Рассмотрена) | rejected (Отклонена).';

COMMIT;
