-- 0034_leads_cohort_questionnaire.sql
--
-- Ответы анкеты сайта (b2b): три текстовых CFV Kommo, зеркалим сырые значения
-- как language_level (нормализация корзин — на чтении, форматы значений
-- исторически дрейфуют: «До 2 000» / «До 2000 евро» / «До 2 000 €»).
-- В аккаунте у каждого вопроса ДВА поля — textarea-дубли (869872/869876/869878)
-- мёртвые (0 заполнений), рабочие text-поля: 869932/869936/869938.
-- Имена колонок с суффиксом _answer: status/income без него конфликтуют со
-- статусом сделки. Нужно вкладке «Динамика категорий» (4 новые таблицы).
--
-- Apply via Neon SQL editor (Analytics DB).

ALTER TABLE analytics.leads_cohort
  ADD COLUMN IF NOT EXISTS start_date_answer text,
  ADD COLUMN IF NOT EXISTS status_answer text,
  ADD COLUMN IF NOT EXISTS income_answer text;

COMMENT ON COLUMN analytics.leads_cohort.start_date_answer IS
  'Анкета: «Когда планируете начать?» (Kommo CFV 869932 START_DATE, сырой текст: Прямо сейчас / Через 2 недели / Через месяц / Не планирую в ближайшее время).';
COMMENT ON COLUMN analytics.leads_cohort.status_answer IS
  'Анкета: рабочий статус (Kommo CFV 869936 STATUS, сырой текст: Работаю в Германии / Не работаю, но муж/жена работает / Фриланс / …). Форматы дрейфуют — нормализовать на чтении.';
COMMENT ON COLUMN analytics.leads_cohort.income_answer IS
  'Анкета: доход (Kommo CFV 869938 INCOME, сырой текст: До 2 000 / 2 000 3 000 / 3 000 5 000 / Выше 5 000; исторические варианты с «евро»/«€»). Нормализовать на чтении.';
