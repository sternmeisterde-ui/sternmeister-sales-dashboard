# РОПов playbook — типовые вопросы и tool-цепочки

Подсказки для агента: какие tools вызывать на типовых бизнес-вопросах. Расширяется по итогам реальных запросов из `mcp_audit_log`.

## «Как Маша на этой неделе?»

1. `managers.find_by_name({ name: "Маша", dept: <b2g|b2b> })` → получить `id`.
2. `okk.summarise_quality({ dept, from, to, manager_id: id })` → avg score.
3. (опц.) `okk.find_calls({ dept, from, to, manager_id: id, score_max: 60 })` → топ худших.

## «У кого упала конверсия в апреле?»

1. `managers.list({ dept })` → список активных.
2. `okk.summarise_quality({ dept, from: "2026-04-01", to: "2026-04-30" })` → top5/bottom5 с avg_score.
3. (опц.) `managers.find_outliers({ dept, metric: "gross_amount", period_month: "2026-04" })` → cross-check с зарплатой.

## «Покажи 5 худших звонков 2-й линии вчера»

1. `okk.find_calls({ dept: "b2g", from: "2026-04-30", to: "2026-04-30", line: "2", score_max: 60, limit: 5 })`.
2. Для каждого — `okk.get_call({ dept, call_id })` чтобы посмотреть транскрипт и детали оценки.

## «Сколько звонков у Маши вчера попало в OKK?»

1. `managers.find_by_name` → id.
2. `okk.coverage_heatmap({ dept, from: "2026-04-30", to: "2026-04-30" })` → найти строку с её manager_id.

## «Сравни Машу и Петю в апреле»

1. `managers.find_by_name` × 2 → id1, id2.
2. `managers.compare({ ids: [id1, id2] })` → профили + payroll.
3. Для каждого: `okk.summarise_quality({ dept, from, to, manager_id: id })`.

## «Какие ошибки чаще всего повторяются в B2B на этой неделе?»

- `okk.top_problems({ dept: "b2b", from, to, limit: 10 })` → текстовый rank.
- (Phase 5) `search.feedback({ query: "перебивает клиента", dept })` → семантический поиск.

## «Сколько follow-up распознано в апреле?»

- `okk.audit_overrides({ dept, from, to })` → `followup_count` + breakdown signal_sources.

## Принципы

- **Сначала find_by_name** — НЕ передавай в other tools имя строкой, всегда резолви в id (защищает от name-drift).
- **dept всегда явно** — НЕ предполагай, спроси у пользователя если неясно.
- **Period в Berlin civil-day** — все ISO-dates интерпретируются как Europe/Berlin.
- **Если score кажется неожиданным** — проверь `override_metadata` через `okk.get_call`: возможно AI-оценка была программно скорректирована.
