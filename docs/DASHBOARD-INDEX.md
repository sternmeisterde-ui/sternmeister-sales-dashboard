# Dashboard — оглавление разделов и таблиц

Last updated: 2026-04-30

Этот файл — **единая entry-point карта** для будущего MCP-сервера: для каждого раздела указано, какой doc его описывает и какие таблицы он реально читает. Используй как первый ресурс при подключении агента.

## Все разделы дашборда

| Tab id | Sidebar label | Доступ | Компонент | Doc |
|---|---|---|---|---|
| `dashboard` | Звонки | admin | `DashboardTab.tsx` | [`DASHBOARD-ZVONKI.md`](./DASHBOARD-ZVONKI.md) |
| `daily` | Дейли | admin | `DailyTab.tsx` | [`DASHBOARD-DAILY.md`](./DASHBOARD-DAILY.md) + [`daily-commerce-spec.md`](./daily-commerce-spec.md) (B2B бизнес-спека) |
| `analytics` | Аналитика | admin | `AnalyticsTab.tsx` | [`DASHBOARD-ANALITIKA.md`](./DASHBOARD-ANALITIKA.md) |
| `tracking` | Активность | admin | `TrackingTab.tsx` | [`DASHBOARD-AKTIVNOST.md`](./DASHBOARD-AKTIVNOST.md) |
| `termins` | Термин | admin | `TerminTab.tsx` | [`DASHBOARD-TERMIN.md`](./DASHBOARD-TERMIN.md) |
| `looker` | Looker | admin | `LookerTab.tsx` | [`DASHBOARD-LOOKER.md`](./DASHBOARD-LOOKER.md) |
| `real_calls` | ОКК | manager + admin | inline в `page.tsx` | [`DASHBOARD-OKK.md`](./DASHBOARD-OKK.md) |
| `ai_calls` | AI Ролевки | manager + admin | inline в `page.tsx` | [`DASHBOARD-AI-ROLEVKI.md`](./DASHBOARD-AI-ROLEVKI.md) |
| `managers` | Менеджеры | admin | `ManagersTab.tsx` | [`DASHBOARD-MANAGERS.md`](./DASHBOARD-MANAGERS.md) |
| `call_analysis` | Анализ | admin | `AnalysisTab.tsx` | [`DASHBOARD-ANALIZ.md`](./DASHBOARD-ANALIZ.md) |
| `criteria` | Критерии | admin | `CriteriaTab.tsx` | [`DASHBOARD-KRITERII.md`](./DASHBOARD-KRITERII.md) |
| `scripts` | Скрипты | session (read), admin (write) | `ScriptsTab.tsx` | [`DASHBOARD-SKRIPTY.md`](./DASHBOARD-SKRIPTY.md) |
| `audit` | Аудит | admin | `AuditTab.tsx` | [`DASHBOARD-AUDIT.md`](./DASHBOARD-AUDIT.md) |

## Карта БД

| Connection | Env var | Содержимое | Используется разделами |
|---|---|---|---|
| **D1** | `DATABASE_URL` | B2G ролевки + master_managers + общие таблицы (scripts, daily_plans, manager_schedule, payroll_runs, manager_bonuses, call_analyses, kommo_tokens, bug_reports, daily_snapshots) | Менеджеры, Анализ, Скрипты, Дейли, Аналитика (source=roleplay для B2G), AI Ролевки (B2G) |
| **R1** | `R1_DATABASE_URL` (auto-derive из D1) | B2B ролевки (`r1_users`, `r1_calls`, `r1_avatars`) + sub-set общих таблиц | AI Ролевки (B2B), Аналитика (source=roleplay для B2B), Дейли (ролевки B2B) |
| **D2** | `D2_OKK_DATABASE_URL` | B2G OKK (`managers`, `calls`, `evaluations`, `voice_feedback`, `worst_calls`, `phantom_history`, `telephony_cdr`) | ОКК, Аудит, Аналитика (source=okk B2G), Дейли (OKK score B2G) |
| **R2** | `R2_OKK_DATABASE_URL` | B2B OKK (та же схема) | ОКК (B2B), Аудит, Аналитика (source=okk B2B), Дейли (OKK score B2B) |
| **Analytics** | `ANALYTICS_DATABASE_URL` | Зеркало 3rd-party интегратора (схема `analytics.*`): leads_cohort, communications, lead_status_changes, sla, tasks, ads_report, sales_report, custom_report, refusal_enums, funnel | Looker, Звонки, Термин, Дейли, Активность (cross-check) |
| **Tracking** | `TRACKING_DATABASE_URL` | Отдельный Neon-проект: `tracking_events`, `tracking_sync_state` | Активность |

## Все таблицы по разделам (cross-reference)

### `master_managers` (D1) — single source of truth для менеджеров
Используется: **Менеджеры**, **Дейли**, **Звонки**, **Активность**, **ОКК** (через FK), **Аналитика** (для join'а имён).
Sync targets при upsert: D2.`managers`, R2.`managers`, D1.`d1_users`, R1.`r1_users`.

### OKK schema (одинаковая в D2 и R2)

| Таблица | Используется разделами |
|---|---|
| `managers` | ОКК, Аналитика, Менеджеры (sync target), Аудит (через JOIN) |
| `calls` | ОКК, Аналитика, Дейли, Аудит (через JOIN), worst-calls |
| `evaluations` | ОКК, Аналитика, Дейли, Аудит (главный источник `override_metadata`) |
| `voice_feedback` | ОКК (попап) |
| `worst_calls` | OKK worst-calls panel (отдельный popup) |
| `telephony_cdr` | (не отображается напрямую) — источник для агрегации `phantom_history` |
| `phantom_history` | Аудит (heatmap покрытия) |

### D1/R1 Roleplay schema (зеркальные)

| Таблица | Используется разделами |
|---|---|
| `d1_users` / `r1_users` | AI Ролевки, Аналитика (source=roleplay), Менеджеры (sync target) |
| `d1_calls` / `r1_calls` | AI Ролевки, Аналитика, Дейли |
| `d1_avatars` / `r1_avatars` | AI Ролевки (попап с инфой об аватаре) |

### Общие таблицы D1

| Таблица | Используется разделами |
|---|---|
| `scripts` | Скрипты |
| `daily_plans` | Дейли (план), Аналитика (как fallback на legacy snapshot) |
| `manager_schedule` | Менеджеры (Календарь), Дейли (расписание) |
| `manager_bonuses` | Менеджеры (Табель) |
| `payroll_runs` | Менеджеры (Табель), Дейли (закрытый месяц) |
| `call_analyses` + `call_analysis_files` | Анализ |
| `kommo_tokens` | (внутренняя — для всех Kommo-вызовов) |
| `bug_reports` | (попап «Сообщить об ошибке» — мирорится в Discord) |
| `daily_snapshots` | (legacy, deprecated 2026-04-24, может ещё читаться как fallback) |

### Analytics schema (`analytics.*`)

| Таблица | Используется разделами |
|---|---|
| `leads_cohort` | Looker, Звонки (cohort), Термин, Дейли (B2G+B2B), Аналитика (Daily-родственный) |
| `communications` | Looker, Звонки, Дейли, Активность (cross-check для CDR uniq) |
| `lead_status_changes` | Looker, Звонки (cohort), Термин (TERM_DC_DONE), Дейли |
| `sla` | Looker, Дейли |
| `tasks` | Дейли (overdue tasks) |
| `ads_report` / `sales_report` | (пока не подключены к UI напрямую — резерв для отчётов) |
| `custom_report` / `funnel` | (зеркала integrator's MySQL для cross-check) |
| `refusal_enums` | Дейли (refusals секция, B2G) |

### Tracking schema (отдельный Neon-проект)

| Таблица | Используется разделами |
|---|---|
| `tracking_events` | Активность |
| `tracking_sync_state` | Активность (служебная — маркер последнего sync'а) |

## Файлы критериев (FS, не БД)

| Путь | Используется разделами |
|---|---|
| `src/criteria/<prompt_type>.json` | Критерии (read+write), Аналитика (read для канонических имён блоков) |

## Что особенного / gotchas для разметки

- **OKK calls показываются только если** `evaluations.total_score IS NOT NULL` AND `calls.manager_id IS NOT NULL` (orphan-фильтр).
- **B2G линии**: `1`=квалификатор, `2`=бератер, `3`=доведение. Менеджеры с `role='rop' AND line!=null` участвуют как линейные сотрудники (например Татьяна Дерикова line=2).
- **Berlin civil-day** — все date boundaries и bucket'ы считаются в Europe/Berlin, не UTC.
- **Name aliases**: `master_managers.name` ↔ `analytics.communications.manager` могут расходиться (Maksim/Latin C/Ukrainian Є). Алиас-таблица в `src/lib/daily/name-aliases.ts`.
- **Sub-lines `2a`/`2b`** в B2G не теггируются на ролевки — collapse в `2` перед запросом.
- **Phone fallback**: телефонные звонки (CDR) приходят в `analytics.communications` с `lead_id=NULL` + `pipeline_id=NULL` + `phone` populated; ETL `enrich-telephony-leads` фанит их в N rows (по числу matched лидов через Kommo contacts API).
- **Override-метаданные** (Phase 2): `evaluations.override_metadata` — JSON с `is_followup`, `followup_signal_source`, `prior_count`, `call_type`, `overrides_applied[]`, `score_before_override`, `score_after_override`. Главный источник для Аудита.
- **ROP-двойной-статус** учитывается в Активность (filter v11), Менеджеры, Дейли, Звонки. См. `project_double_status` memory.

## Связанные docs

- [`SESSION-HANDOFF.md`](./SESSION-HANDOFF.md) — текущий фокус и known-issues
- [`TODO.md`](./TODO.md) — приоритеты следующих задач
- [`mysql-analytics.md`](./mysql-analytics.md) — полная карта 3rd-party MySQL → наша `analytics.*`
- [`kommo-api-usage.md`](./kommo-api-usage.md) — Kommo rate-limit policy (1 rps/process, 2 rps combined)
- [`SENTRY.md`](./SENTRY.md) — мониторинг и обработка ошибок
- [`etl-architecture.md`](./etl-architecture.md) — **обязательно к прочтению перед добавлением новых INSERT-writers в `analytics.*`**: правила идемпотентности, natural keys, ON CONFLICT, поведение cron
- [`THEME-AND-REFACTOR-PLAN.md`](./THEME-AND-REFACTOR-PLAN.md) — рефакторинговый план
