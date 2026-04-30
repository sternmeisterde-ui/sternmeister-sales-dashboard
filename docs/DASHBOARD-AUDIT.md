# Dashboard → «Аудит» — как работает

Last updated: 2026-04-30

Админский диагностический раздел качества AI-оценки звонков и покрытия webhook'ов телефонии. Доступен только при `session.role === "admin"`. Окно по умолчанию — последние 14 дней.

## Источники данных

Все запросы идут в **OKK-базу** выбранного отдела (D2 для B2G, R2 для B2B) — выбирается через `getOkkDbForDepartment(dept)`.

| DB connection | Таблица | Зачем нужна тут | Ключевые колонки |
|---|---|---|---|
| **D2** (B2G OKK) / **R2** (B2B OKK) | `evaluations` | Источник overrides, follow-up-сигнала и call_type | `override_metadata` (jsonb), `prompt_type`, `total_score`, `created_at` |
| **D2** / **R2** | `phantom_history` | Дневной аггрегат покрытия webhook'ом телефонии | `manager_name`, `date`, `okk_count`, `phantom_count`, `coverage_pct` |

> `evaluations.override_metadata` — главный источник для секций «Программный override», «Источник follow-up сигнала», «Распределение по call_type». Это JSON с ключами `is_followup`, `followup_signal_source`, `prior_count`, `call_type`, `overrides_applied[]`, `score_before_override`, `score_after_override`. Записывается OKK-бэкендом при оценке звонка.

> `phantom_history` заполняется ежедневным cron'ом, который сравнивает CDR из CallGear+CloudTalk (таблица `telephony_cdr`) с реально записанными в OKK звонками (таблица `calls`). Этот раздел **не читает** `telephony_cdr` напрямую — только агрегат.

## Layout (4 секции)

1. **Программный override — за период** — таблица: per-`prompt_type` сколько оценок всего, сколько с сработавшим override, % срабатывания, средняя `Δ score` (после − до)
2. **Источник follow-up сигнала** — split по `lead_id` / `phone_fallback` / `phone_fallback_no_crm` / `no_signal`
3. **Распределение по `call_type`** — primary / followup / interrupted / unqualified / transfer / deferred_start / unknown
4. **Webhook coverage heatmap** — тепловая карта менеджер × день. Зелёный ≥95%, жёлтый 85–95%, красный <85%, серый = звонков не было

## API

- `GET /api/okk/audit?dept=b2g|b2b&from=YYYY-MM-DD&to=YYYY-MM-DD` — единственный endpoint раздела. Admin-only.
  - Источник: `src/app/api/okk/audit/route.ts`
  - Ответ: `{ dept, from, to, coverage[], overrides[], signal_quality[], call_types[] }`

## Edge cases / gotchas

- Если cron-агрегатор `phantom_history` ещё ни разу не отрабатывал — heatmap пустой, выводится сообщение «Нет данных по покрытию. CDR sync ещё не запускался».
- Если в окне нет ни одной evaluation с `override_metadata IS NOT NULL` (старые записи без Phase-2 метаданных), все три «override»-секции пустые — это норма для исторических данных до Phase 2.

## Файлы

- UI: `src/components/AuditTab.tsx`
- API: `src/app/api/okk/audit/route.ts`
- Schema: `src/lib/db/schema-okk.ts` (таблицы `okkEvaluations`, `okkPhantomHistory`)
