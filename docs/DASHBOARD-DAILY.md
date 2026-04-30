# Dashboard → «Дейли» — как работает

Last updated: 2026-04-30

Ежедневный (или недельный/месячный) план-факт-отчёт по обоим отделам с разбивкой по линиям/воронкам/менеджерам. Сложнейший раздел дашборда — агрегирует Kommo + Analytics + OKK + Roleplay данные в единый снапшот. Admin-only.

> Дополнительно: `docs/daily-commerce-spec.md` содержит **бизнес-спеку** B2B Commerce на основе xlsx-ТЗ. Этот файл — техническая операционная карта.

## Источники данных

Раздел тянет из **четырёх разных БД** + Kommo API одновременно. Все агрегаты собираются в `src/lib/daily/build-response.ts`.

### B2G (Госники)

| DB connection | Таблица | Зачем нужна тут |
|---|---|---|
| **Analytics** (`ANALYTICS_DATABASE_URL`) | `analytics.leads_cohort` | Все лиды в окне периода + payment-fields, status, pipeline, manager |
| **Analytics** | `analytics.communications` | Звонки и сообщения для подсчёта calls/messages по менеджерам |
| **Analytics** | `analytics.lead_status_changes` | Кол-во переходов в «Квал» статус (для qualLeads_f) |
| **Analytics** | `analytics.sla` | SLA первого звонка по линиям/пайплайнам |
| **Analytics** | `analytics.tasks` | Просроченные задачи per manager (overdue tasks count) |
| **D1** (`DATABASE_URL`) | `master_managers` | Источник истины менеджеров (с `kommo_user_id`, `line`, `team`) — определяет per-line роутинг |
| **D1** | `manager_schedule` | Кто на линии в этот день (для расчёта «сколько менеджеров в строю») |
| **D1** | `daily_plans` | Сохранённые планы — line-level и per-manager. Edit-in-place из UI |
| **D1** | `d1_calls` | Ролевки B2G — для метрики «оценка за ролевку» |
| **D2** | `calls` + `evaluations` | OKK score B2G — средний балл по линиям |

### B2B (Коммерсы)

| DB connection | Таблица | Зачем нужна тут |
|---|---|---|
| **Analytics** | `analytics.leads_cohort` | Лиды + payment fields для секций «Продажи Бух»/«Продажи Мед»/«Продажи ТОТАЛ» (`first_payment_date`, `prepayment_date`, `first_payment_amount`, `prepayment_amount`, `b2b_close_reason_enum_id`) |
| **Analytics** | `analytics.communications` | Звонки секции «Звонки» |
| **Analytics** | `analytics.sla` | SLA Коммерции |
| **D1** | `master_managers` | (общая для обоих отделов, `department='b2b'` фильтр) |
| **D1** | `manager_schedule` | Расписание B2B менеджеров |
| **D1** | `daily_plans` | План B2B (`department='b2b'`) |
| **R1** (`R1_DATABASE_URL`) | `r1_calls` | Ролевки B2B |
| **R2** (`R2_OKK_DATABASE_URL`) | `calls` + `evaluations` | OKK score B2B |

### Kommo API (live)

- `getTasks` — текущие задачи (когда snapshot ещё не сохранён в БД)
- Через `kommo/cache.ts` — результаты кешируются на 2 минуты

### Внешние ETL

- ETL `/api/analytics/sync/cron` — наполняет `analytics.*` из Kommo + CallGear/CloudTalk CDR
- Эти таблицы — **single source of truth** для Daily начиная с 2026-04-24 (см. memory `project_analytics_mirror.md`)

## Layout

UI (`DailyTab.tsx`) — **табы по периодам**: День / Неделя / Месяц. В каждом периоде — секции в строго определённом порядке (`getDailySections(department)`).

### B2G секции (`metrics-config.ts`)

1. **Сделки на активных этапах и Воронка** (`funnel`, dbLine=`1`) — общая воронка, не per-manager. Хранит planы под dbLine='1'
2. **Менеджер-квалификатор (Первая линия)** (`qualifier`, dbLine=`1`) — per-manager
3. **Менеджер второй линии** (`secondLine`, dbLine=`2`) — per-manager
4. **Доведение (Третья линия)** (`thirdLine`, dbLine=`3`) — per-manager
5. **Общее** (если есть) — общие метрики (gutscheins и т.п.)

### B2B секции (`metrics-config-b2b.ts`)

1. **Продажи ТОТАЛ** (`salesTotal`) — sum по обоим пайплайнам
2. **Продажи Бух** (`salesBuh`, pipeline=`Бух Комм`) — per-manager
3. **Продажи Мед** (`salesMed`, pipeline=`Мед Комм`) — per-manager
4. **Звонки** (`calls`) — per-manager

### Внутри секции

- Сводная (per-line / per-pipeline) колонка plan/fact/%
- Per-manager таблица (если `perManager: true`): row на менеджера, колонки = метрики
- Inline-edit для plan-cell (карандашик появляется на hover)

### Дополнительные блоки

- **Расписание** (`schedule`) — кто на линии сегодня (popup `SchedulePopup`)
- **Refusals** — топ-причин отказов первой линии и бератера (для B2G; берётся из `analytics.leads_cohort.non_qual_enum_id` и `lead_status_changes`)
- **Табель** (popup `TabelPopup`) — payroll calculator для месяца

## Ключевые механики

- **Berlin civil-day**: все «day boundaries» считаются в Europe/Berlin (см. `parseDateBoundary`). Не UTC.
- **План-каскад Monthly → Weekly → Daily**: если daily-план не задан, берётся из weekly / monthly с пропорциональным делением.
- **Snapshot caching**: для прошлых дат `buildDailyResponseCached` сохраняет результат в `daily_snapshots` (для B2G) или в `historical-snapshot.ts` reconstructor (для B2B). Live-даты идут в Kommo всегда.
- **Name aliases** (`name-aliases.ts`): мапит расхождения между `master_managers.name` и `analytics.communications.manager` (Maksim/Latin C/Ukrainian Є). См. memory `project_analytics_name_aliases.md`.
- **Manager whitelist** (`dept-manager-whitelist.ts`): фильтр того, кого показывать в per-manager таблицах с учётом override'ов расписания.

## API

- `GET /api/daily?department=<>&date=<YYYY-MM-DD>&period=<day|week|month>` — основной endpoint, через `buildDailyResponseCached`. Возвращает `DailySnapshot` со всеми секциями.
- `GET /api/daily/range?department=<>&month=<YYYY-MM>&mode=days|months` — массив снапшотов для каждого дня месяца (или каждого месяца года). Sequential fetch concurrency=3.
- `PUT /api/daily/plans` — upsert одного plan-value. Body: `{department, line, userId, metricKey, planValue, periodType, periodDate}`.
- `GET /api/daily/managers?department=<>` — список менеджеров отдела для табеля и расписания.
- `GET /api/daily/schedule?department=<>&date=<>` — расписание на дату.
- `POST /api/daily/schedule` — обновить расписание дня.
- `GET /api/daily/active-managers?department=<>` — кто in-line сейчас (для popup'а).
- `GET /api/daily/payroll?department=<>&month=<>` — расчёт табеля. См. `DASHBOARD-MANAGERS.md` (popup живёт там).
- `POST /api/daily/payroll/bonus` — установить ручную премию.
- `POST /api/daily/payroll/cron` — закрытие месяца (writes `payroll_runs`).
- `GET /api/daily/payroll/year?department=<>` — годовая сводка.
- `GET /api/daily/health` — health-check эндпоинт для cron'ов.

## Edge cases / gotchas

- **`funnel` секция (B2G) хранит planы под `dbLine='1'`** (не под `'funnel'`). Stale line='funnel' rows были удалены 2026-04-24 — это намеренно, чтобы UI-saves совпадали с импортируемыми планами.
- **Two-stage payment column**: `first_payment_date`/`first_payment_amount` (полная оплата) и `prepayment_date`/`prepayment_amount` (предоплата) — независимо. UI секции «Продажи Бух/Мед» в B2B считает их отдельными метриками.
- **B2B fixed plan defaults** (`B2B_FIXED_PLAN_DEFAULTS` в `metrics-config-b2b.ts`): для metrics с пустым `daily_plans`, plan берётся из этого файла как fallback.
- **OKK score fallback**: предпочитает OKK DB; если за дату OKK-данных нет, фолбэчится на сохранённый `daily_plans` _f-value (для исторических снапшотов).
- **Roleplay score** для B2B читается из R1 (а не D1).
- **Refusals** (раздел отказов) — только для B2G; B2B использует `b2b_close_reason_enum_id`.
- **Sentry** обёрнут вокруг build — failed sub-fetch одной секции не валит весь endpoint.

## Файлы

- UI: `src/components/DailyTab.tsx` (огромный — 1817 строк)
- API: `src/app/api/daily/*` (см. список выше)
- Builder: `src/lib/daily/build-response.ts` (центральный orchestrator)
- Configs: `src/lib/daily/metrics-config.ts` (B2G), `src/lib/daily/metrics-config-b2b.ts` (B2B)
- Helpers: `src/lib/daily/analytics-calls.ts`, `analytics-leads.ts`, `analytics-b2b.ts`, `name-aliases.ts`, `dept-manager-whitelist.ts`, `historical-snapshot.ts`, `payroll.ts`, `schedule-payroll.ts`, `payroll-persist.ts`
- Queries: `src/lib/db/queries-daily.ts` (plans + schedule + master_managers selects)
- Schema: `src/lib/db/schema-existing.ts` (master_managers, daily_plans, manager_schedule, payroll_runs, manager_bonuses), `src/lib/db/schema-okk.ts`, `src/lib/db/schema-analytics.ts`
- Связанные docs: `docs/daily-commerce-spec.md` (B2B бизнес-спека), `DASHBOARD-MANAGERS.md` (Табель/Schedule popups), `DASHBOARD-LOOKER.md` (тот же analytics-pool, другие views)
