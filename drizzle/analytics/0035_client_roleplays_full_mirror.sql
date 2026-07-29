-- 0035_client_roleplays_full_mirror.sql
-- Полное зеркало клиентских ролевок (D2 `client_evaluations`) для таблицы
-- «Ролевки» во вкладке Воронка → режим «Клиенты».
--
-- Что меняется: раньше зеркалились только строки, где ролевка СОСТОЯЛАСЬ
-- (roleplay_present=true + «была, но не оценена»). Строки «менеджер ролевку не
-- проводил» отбрасывались — из-за этого нельзя было ответить на главный вопрос
-- таблицы: «консультация была, а ролевку провели?». Теперь зеркалим все строки
-- client_evaluations и различаем их колонкой manager_conducted.
--
--   manager_conducted = TRUE   — менеджерский критерий «Проведение ролевки»=1
--                                (ролевка была; score_5 может быть NULL, если
--                                 не хватило материала или сорвалась авто-оценка)
--   manager_conducted = FALSE  — ролевки на звонке не было (pre-gate ОКК)
--
-- Существующие строки все были «проведёнными» по построению → DEFAULT TRUE
-- корректен и для них.
--
-- Читатели: src/lib/funnel/roleplays.ts (фильтрует manager_conducted=TRUE,
-- поведение вкладки «Клиенты» не меняется) и src/lib/funnel/roleplay-audit.ts.

ALTER TABLE analytics.client_roleplays
  ADD COLUMN IF NOT EXISTS manager_conducted  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS roleplay_present   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS manager_name       TEXT,
  ADD COLUMN IF NOT EXISTS prompt_type        TEXT,
  ADD COLUMN IF NOT EXISTS duration_seconds   INTEGER,
  ADD COLUMN IF NOT EXISTS question_coverage  JSONB;

COMMENT ON COLUMN analytics.client_roleplays.manager_conducted IS
  'Менеджер провёл ролевку на этом звонке (критерий «Проведение ролевки»=1). FALSE = pre-gate ОКК: ролевки не было.';
COMMENT ON COLUMN analytics.client_roleplays.roleplay_present IS
  'Ролевка засчитана скорером клиента (прошла gate2). FALSE при manager_conducted=TRUE = была, но не оценена — причина в gate_reason.';
COMMENT ON COLUMN analytics.client_roleplays.manager_name IS
  'Кто проводил звонок (calls.manager_name из D2) — денормализовано, JOIN в D2 из analytics невозможен.';
COMMENT ON COLUMN analytics.client_roleplays.prompt_type IS
  'd2_berater (сторона ДЦ) | d2_berater2 (сторона АА).';
COMMENT ON COLUMN analytics.client_roleplays.question_coverage IS
  'Разбор по вопросам банка: задан / самостоятельный ответ / покрыт / сила / цитата. Для детализации в drawer.';

-- Существующие строки — все «проведённые»; roleplay_present восстанавливаем из
-- наличия балла (для них score_5 IS NOT NULL ⟺ ролевка была засчитана).
UPDATE analytics.client_roleplays
   SET roleplay_present = (score_5 IS NOT NULL)
 WHERE roleplay_present = FALSE;

-- Выборка таблицы «Ролевки» идёт по (lead_id, side) + фильтр «проведена».
CREATE INDEX IF NOT EXISTS idx_client_roleplays_conducted
  ON analytics.client_roleplays (lead_id, side)
  WHERE manager_conducted = TRUE;
