# SternMeister глоссарий

Краткий словарь терминов проекта для MCP-агента. Полные определения через `glossary(term)`.

## Базы данных

- **D1** — Neon DB B2G ролевки + master_managers + общие таблицы (Госники, Дима).
- **R1** — Neon DB B2B ролевки (Коммерсы, Рузанна). Та же физическая БД что D1, другой branch.
- **D2** — Neon DB B2G OKK (реальные оценённые звонки Госников).
- **R2** — Neon DB B2B OKK (Коммерсов).
- **Analytics** — Neon DB зеркало 3rd-party Looker-интегратора. `analytics.*` схема. Главный источник для Daily/Звонки/Looker/Termin.
- **Tracking** — Neon DB кеш Kommo событий. Питает Активность.

## Отделы и роли

- **B2G** = Госники (Дмитрий). `department='b2g'`. team='dima'.
- **B2B** = Коммерсы (Рузанна). `department='b2b'`. team='ruzanna'.
- **ROP** = Руководитель отдела продаж. `role='rop'`.
- **Double-status** = `role='rop' AND line!=NULL` → одновременно работает на линии. Пример: Татьяна Дерикова line=2.

## Линии (только B2G)

- `1` = квалификатор (первая линия).
- `2` = бератер (вторая линия).
- `3` = доведение (третья линия).

В B2B `line` всегда NULL — там нет line-конвенции.

## Метрики

- **OKK score** = `evaluations.total_score` (0-100). Только evaluated calls (`total_score IS NOT NULL`) и `manager_id IS NOT NULL`.
- **SLA первого звонка** = BH-time от создания лида до первого outbound-звонка ОТВЕТСТВЕННОГО менеджера. NULL когда нет outbound звонка ИЛИ outbound только от не-responsible.
- **TLT** = Time between Latest Touches. BH-time между двумя последними outbound-звонками responsible-менеджера на одном лиде.

## Известные особенности

- **Berlin civil-day** — все date boundaries и cron'ы считаются в Europe/Berlin, не UTC.
- **Pattern A** — один CDR-звонок может стать N rows в `analytics.communications` (по числу matched лидов после enrich-telephony-leads). Composite UNIQUE `(communication_id, COALESCE(lead_id,0))`.
- **Name-drift** — `master_managers.name` vs `analytics.communications.manager` имеют 3 расхождения (Maksim/Latin-C/Ukrainian-Є). Алиас-таблица в `src/lib/daily/name-aliases.ts`.
- **Orphan-фильтр OKK** — звонки с `total_score IS NULL` или `manager_id IS NULL` НЕ показываются в UI и НЕ возвращаются MCP-tools.
- **Soft-delete** — `is_active=false` сохраняет FK в исторических звонках; UI и MCP такие записи скрывают.
- **TERM_DC_DONE** — Kommo `status_id=93886075` в `leads_cohort.status_id`. Маркер выполнения «Дата термина ДЦ» в B2G Бух Бератер pipeline.

## Pipelines (Kommo)

- B2B: 10631243 = Бух Комм, 13209983 = Мед Комм. Используются в b2b_close_reason gate.
- B2G: 12154099 = Бух Бератер. Используется Termin tab.
- Остальные B2G — разные, см. `analytics.leads_cohort.pipeline_id` для конкретного лида.
