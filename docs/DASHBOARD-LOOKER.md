# Dashboard → «Looker» — как работает

Last updated: 2026-04-30

Зеркало Looker-дашборда от 3rd-party интегратора (45.156.25.84/db) поверх собственной аналитической базы Neon. Умеет 4 view: All Calls, Cohorts (с SLA), TLT (Time between Latest Touches), Conversions. Admin-only.

## Источники данных

Один-единственный read-only коннект — **Analytics Neon** (`ANALYTICS_DATABASE_URL`, выбирается через `analyticsDb`). Все таблицы лежат в схеме **`analytics.*`**.

| DB connection | Таблица | Зачем нужна тут | Ключевые колонки |
|---|---|---|---|
| **Analytics** | `analytics.leads_cohort` | Когорта лидов: pipeline, status, manager, UTM, payment fields, termin dates | `lead_id`, `created_at`, `pipeline`, `status`, `category`, `manager`, `utm_source`, `closed_at`, `first_payment_date`, `prepayment_date`, `non_qual_enum_id`, `b2b_close_reason_enum_id`, `termin_date`, `aa_termin_date` |
| **Analytics** | `analytics.communications` | Все коммуникации (звонки, сообщения) — основа для подсчёта calls/messages | `lead_id`, `communication_type`, `created_at`, `duration`, `manager`, `pipeline_id`, `pipeline_name`, `first_contact_flg`, `last_contact_flg`, `phone` (для CDR-row) |
| **Analytics** | `analytics.lead_status_changes` | Переходы статусов для cohort-status и conversion-views | `lead_id`, `pipeline`, `status_id`, `status`, `event_at`, `next_event_at`, `manager` |
| **Analytics** | `analytics.sla` | SLA первого контакта/звонка + TLT (время между касаниями) | `lead_id`, `sla_first_call_seconds`, `sla_first_call_calendar_seconds`, `sla_first_call_from_shift_seconds`, `tlt_seconds`, `sla_status`, **`sla_first_call_seconds_integrator`** + **`tlt_integrator`** (snapshot интегратора, COALESCE для исторических лидов) |

> **Manager whitelist**: используется `getDeptManagerWhitelist(dept)` из `src/lib/daily/dept-manager-whitelist.ts` — в выдаче только менеджеры активного отдела с учётом override'ов расписания (`getDeptScheduleOverrides`).

## Layout

UI (`LookerTab.tsx`) — 4 view, переключаются pill-toggle:

1. **All Calls** — per-manager сводка: total/outbound/inbound calls, messages_sent, success% (≥10s), duration
2. **Cohorts** — per-manager + слайс (manager / utm_source / status / pipeline / category / "—"): lead_count, calls, messages, success%, avg_calls_per_lead, **avg_sla_lead_to_call**, **avg_sla_from_shift**. Drilldown → `cohorts_detail` (per-lead worst-deals)
3. **TLT** — два sub-view: `tlt_summary` (агрегаты с param1/param2/param3 разрезами), `tlt_detail` (per-lead drilldown)
4. **Conversions** — воронка переходов статусов

## Параметры фильтрации

- `dept`: b2g | b2b — выбирает whitelist пайплайнов и менеджеров
  - B2G pipelines: `Бух Гос`, `Бух Бератер`
  - B2B pipelines: `Бух Комм`, `Мед Комм`
- `view`: `all_calls` | `cohorts` | `cohorts_detail` | `tlt_summary` | `tlt_detail` | `conversions` | `meta`
- `slice`: `manager` | `utm_source` | `status` | `pipeline` | `category` | `none` (срез колонки в pivot — `none` скрывает срез)
- `slaRange`: `0-9` | `10-29` | `30+` (минут до первого звонка). Для B2B доступен только `10-29`.
- `from` / `to` (date range), `pipeline` (filter), `status` (filter), `category` (filter A-E)

## Ключевые особенности

- **Source-of-truth разрыв**: до 2026-04-29 Looker читал MySQL интегратора напрямую. После cutoff (`81ce2c8`) — только Neon-зеркало. Snapshot колонки `*_integrator` в `analytics.sla` — frozen mirror интеграторских значений на момент cutoff. SQL делает `COALESCE(integrator_col, computed_col)` чтобы исторические лиды совпадали с интеграторским дашбордом, а новые — с нашим compute.
- **TLT**: BH-time между двумя последними outbound-звонками responsible-менеджера на лиде. NULL когда у менеджера 0–1 звонок на лиде. Пайплайн-blacklist для TLT отличается от SLA-whitelist для первого звонка.
- **SLA_FIRST_CALL gate** для B2B: дроп лид-call пары из average если `b2b_close_reason_enum_id ∈ {740587 Неквал, 740593 Спам, 740595 Сотрудничество}`.

## API

- `GET /api/analytics/looker/data?dept=<>&view=<>&from=<>&to=<>&...filters` — admin-only, читает из `analyticsDb`. Возвращает структурированный массив строк в зависимости от `view`.

## Edge cases / gotchas

- **Все запросы — raw SQL** (`db.execute(sql\`...\`)`), не drizzle ORM. Это исторически — копия логики из integrator's MySQL для сходимости, плюс несколько уровней CTE.
- Запрос имеет несколько уровней escape'инга — параметры юзера прогоняются через `esc()` (replace `'` → `''`) перед интерполяцией. Whitelist-валидация для view/slice/sla перед SQL.
- `clampInt` для limit'а — максимум разный для разных view'ов (защита от accidental `LIMIT 1_000_000`).
- B2B имеет только один SLA-bucket (10-29), B2G — три. UI это учитывает в `slaRanges`.

## Связанная инфраструктура

- ETL pipeline (`/api/analytics/sync/cron`) — наполняет таблицы `analytics.*` из Kommo + CDR. См. `docs/mysql-analytics.md` для детальной мап-таблицы интегратора → Neon.
- Termin tab использует те же `analytics.leads_cohort.termin_date` / `aa_termin_date` — см. `DASHBOARD-TERMIN.md`.

## Файлы

- UI: `src/components/LookerTab.tsx`
- API: `src/app/api/analytics/looker/data/route.ts`
- Schema: `src/lib/db/schema-analytics.ts`
- DB connection: `src/lib/db/analytics.ts`
- Whitelist: `src/lib/daily/dept-manager-whitelist.ts`
- Reference: `docs/mysql-analytics.md` (полная карта интеграторской MySQL → наша `analytics.*`)
