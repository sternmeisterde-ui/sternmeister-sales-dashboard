# MCP Server — Implementation Plan

Last updated: 2026-04-30
Owner: D1 Roleplay
Status: Design approved, awaiting build kickoff

Cross-references: [`DASHBOARD-INDEX.md`](./DASHBOARD-INDEX.md), [`SESSION-HANDOFF.md`](./SESSION-HANDOFF.md), [`CLAUDE.md`](../CLAUDE.md), all `DASHBOARD-*.md` per-tab docs.

---

## 1. Цель и не-цели

### Цель

Дать руководителям и админу single-tool интерфейс к аналитике дашборда: подключаешь Claude (Desktop / Web / Code) к нашему MCP-серверу, агент **сразу** понимает доменную модель и обрабатывает свободные бизнес-вопросы — «Маша провалила конверсию в апреле, почему?», «у кого SLA меньше 9 минут стабильно?», «сравни Бух vs Мед за неделю» — без знания SQL, схемы и алиасов.

### Не-цели (явно)

- **Не делать** записи в БД из MCP. Все tools — READ-ONLY. Любая модификация — только через дашбордовские API под админ-токеном.
- **Не дублировать UI** дашборда. MCP не показывает звонки списком — он отвечает на вопросы.
- **Не мигрировать** на другой LLM-провайдер. Брейн агента — Claude 4.7 / 4.6 (см. конкурирующее обсуждение в чате 2026-04-30: domain MCP + frontier model > custom Agno-стек).
- **Не индексировать неструктурированные данные в v1.** RAG над транскриптами — отдельная фаза (v2), не блокер для v1.
- **Не делать** OAuth / multi-tenant SaaS. 5–15 пользователей внутри компании, bearer-token достаточно.

---

## 2. Architectural decisions (с обоснованием)

| Решение | Выбор | Альтернатива (отвергнута) | Почему |
|---|---|---|---|
| Язык | **TypeScript (Node 20+)** | Python (FastMCP) | Совпадение со стеком дашборда → reuse Drizzle-схем, типов, query-helpers (`src/lib/daily/*`, `src/lib/db/*`). Один lockfile, один билд-pipeline. |
| MCP SDK | **`@modelcontextprotocol/sdk`** (official TS) | Self-roll | Поддержка Anthropic, hot-path для tools/resources/prompts. |
| Транспорт | **HTTP (Streamable)** + **stdio** | Только stdio / только HTTP | Stdio для локальной разработки (Claude Code), HTTP для РОПов через Claude Desktop. Один codebase, два entry-points. |
| Аутентификация | **Bearer-token в env** (1 token = 1 user, role + dept-scope в claims) | OAuth 2.1 + Dynamic Client Registration | Для 5–15 user'ов overhead OAuth не оправдан. Token rotation вручную раз в квартал. |
| Размещение в репо | **Sub-package `Dashbord/mcp-server/`** (workspace) | Отдельный репо | Тесная зависимость от `src/lib/db/*` + `src/lib/daily/*` + tenant config. Один коммит на schema-change. См. обсуждение 2026-04-30. |
| Деплой | **Второй сервис в существующем Dokploy compose** | Отдельный VPS / Vercel | Один `.env`, один сетевой контур, минус один секрет-менеджер. Изоляция через port + поддомен. |
| DB-доступ | **Отдельные read-only Postgres-роли + statement_timeout 10s + per-dept GRANT** | Один сервисный юзер с GRANT-ами через RLS | RLS на 6 БД — over-engineering для чтения. Дешевле дать `mcp_readonly_b2g`/`mcp_readonly_b2b` отдельные DSN'ы. |
| Tool API | **Curated domain tools + read-only SQL escape hatch (admin-only)** | Только curated / только SQL | Curated tools покрывают 80% вопросов и устраняют галлюцинации. SQL escape hatch — для admin'а на 20% не-предусмотренных вопросов. |
| Каталог метаданных | **3 слоя: pg COMMENT + Markdown resources + TS tool descriptions** | Только pg COMMENT / только MD | Каждый слой адресует своего читателя: SQL-grep'ер, narrative-reader, agent-discovery. См. §6. |
| Векторный стор (для v2) | **pgvector прямо в Analytics Neon** | Pinecone / Weaviate / Qdrant | Dataset влезает в Postgres (~500K транскриптов × 1536 dim ≈ 3GB). Отдельный сервис не оправдан. |
| Аудит | **Таблица `mcp_audit_log` в D1** + Sentry для ошибок | Только Sentry / только log-файлы | DB-таблица позволяет агрегировать «кто что спрашивал» — пригодится для tuning'а tool'ов. |

---

## 3. Архитектура

### 3.1 Топология

```
┌─────────────────────────┐  ┌─────────────────────────┐
│  Claude РОПа (Desktop)  │  │  Claude админа (Code/CLI)│
│  + bearer token         │  │  + bearer token (admin)  │
└────────────┬────────────┘  └────────────┬────────────┘
             │ MCP/HTTP-stream            │ MCP/stdio (локально)
             │  https://mcp.sm.de         │  npx mcp-server
             ▼                            ▼
┌──────────────────────────────────────────────────────────┐
│  mcp-server (Dokploy сервис, port 3009)                   │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Auth middleware                                      │ │
│  │   bearer-token → { userId, role, depts: [b2g/b2b] } │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Tool registry                                        │ │
│  │   discovery / domain.* / sql                        │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ DB layer (read-only roles, per-dept connection)     │ │
│  │   D1ro / R1ro / D2ro / R2ro / Analytics_ro / Trk_ro│ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Audit middleware → INSERT mcp_audit_log              │ │
│  └─────────────────────────────────────────────────────┘ │
└────────────┬─────────────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────────────┐
│  Neon (6 баз) — те же что используются дашбордом         │
│  D1, R1, D2, R2, Analytics, Tracking                      │
│  + новая роль mcp_readonly_<role>_<dept> на каждой       │
└──────────────────────────────────────────────────────────┘
```

### 3.2 Файловая раскладка

```
Dashbord/
├── src/                              # ← дашборд (без изменений)
├── mcp-server/                       # 🆕 новый workspace
│   ├── package.json                  # ↳ зависит от @modelcontextprotocol/sdk, drizzle-orm, neon-serverless
│   ├── tsconfig.json                 # ↳ paths: '@dash/*' → '../src/*'
│   ├── Dockerfile
│   ├── README.md                     # ↳ как РОПу подключить через Claude Desktop за 2 шага
│   ├── src/
│   │   ├── index.ts                  # entry-point: HTTP transport
│   │   ├── stdio.ts                  # entry-point: stdio (local dev)
│   │   ├── server.ts                 # сборка MCP-сервера: registry + auth + audit
│   │   │
│   │   ├── auth/
│   │   │   ├── tokens.ts             # bearer-token store (env-backed)
│   │   │   ├── context.ts            # per-call context: userId / role / depts
│   │   │   └── policy.ts             # role-based gates (admin-only tools, dept-scope)
│   │   │
│   │   ├── db/
│   │   │   ├── connections.ts        # 6 read-only Drizzle instances
│   │   │   ├── guards.ts             # statement_timeout, row-limit, query budget
│   │   │   └── audit.ts              # INSERT mcp_audit_log middleware
│   │   │
│   │   ├── registry/
│   │   │   ├── discovery.ts          # list_domains, describe_domain
│   │   │   └── builder.ts            # tool registration helpers
│   │   │
│   │   ├── domains/
│   │   │   ├── managers/             # см. §5.1
│   │   │   │   ├── tools.ts
│   │   │   │   ├── dictionary.md     # bundled MD-resource
│   │   │   │   └── examples.ts       # canonical few-shot examples
│   │   │   ├── okk/                  # см. §5.2
│   │   │   ├── roleplay/             # см. §5.3
│   │   │   ├── daily/                # см. §5.4
│   │   │   ├── analytics/            # см. §5.5
│   │   │   ├── looker/               # см. §5.6
│   │   │   ├── tracking/             # см. §5.7
│   │   │   └── termin/               # см. §5.8
│   │   │
│   │   ├── tools/
│   │   │   └── sql.ts                # run_readonly_sql escape hatch (admin only)
│   │   │
│   │   ├── resources/
│   │   │   ├── glossary.md           # бизнес-словарь
│   │   │   ├── architecture.md       # карта данных (генерируется из DASHBOARD-INDEX.md)
│   │   │   ├── playbook-rop.md       # типовые вопросы → tools
│   │   │   └── changelog.md          # versioning
│   │   │
│   │   └── utils/
│   │       ├── format.ts             # унифицированный output schema
│   │       ├── pii.ts                # маскирование телефонов/имён
│   │       └── trace.ts              # Sentry-обвязка
│   │
│   └── tests/
│       ├── golden/                   # canonical Q&A пары
│       └── tools/                    # unit на конкретные tools
│
├── drizzle/
│   ├── d1/
│   │   └── 00XX_mcp_audit_log.sql   # 🆕 audit table в D1
│   ├── analytics/
│   │   └── 00XX_pgvector_extension.sql  # 🆕 (только для v2)
│   └── ... (existing)
│
└── docker-compose.yml                # ↳ добавляется сервис mcp
```

### 3.3 Connection-плоскость

| Connection | Где живёт | Роль | GRANTы |
|---|---|---|---|
| `MCP_D1_RO_URL` | Neon project D1 | `mcp_readonly` | `SELECT` на `master_managers`, `manager_schedule`, `manager_bonuses`, `payroll_runs`, `daily_plans`, `d1_users`, `d1_calls`, `d1_avatars`, `scripts`, `call_analyses`, `call_analysis_files`, `daily_snapshots`. **Не** на `kommo_tokens`, `bug_reports`. INSERT только в `mcp_audit_log`. |
| `MCP_R1_RO_URL` | Neon project R1 | `mcp_readonly` | `SELECT` на `r1_users`, `r1_calls`, `r1_avatars` |
| `MCP_D2_RO_URL` | Neon project D2 | `mcp_readonly` | `SELECT` на `managers`, `calls`, `evaluations`, `voice_feedback`, `worst_calls`, `phantom_history`. **Не** на `telephony_cdr` (raw PBX). |
| `MCP_R2_RO_URL` | Neon project R2 | `mcp_readonly` | то же что D2 |
| `MCP_ANALYTICS_RO_URL` | Neon project Analytics | `mcp_readonly` | `SELECT` на всю схему `analytics.*` |
| `MCP_TRACKING_RO_URL` | Neon project Tracking | `mcp_readonly` | `SELECT` на `tracking_events`, `tracking_sync_state` |

На уровне роли:

```sql
-- На каждой БД, один раз
CREATE ROLE mcp_readonly WITH LOGIN PASSWORD '<rotated quarterly>';
ALTER ROLE mcp_readonly SET statement_timeout = '10s';
ALTER ROLE mcp_readonly SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE mcp_readonly SET work_mem = '32MB';
GRANT CONNECT ON DATABASE <db> TO mcp_readonly;
GRANT USAGE ON SCHEMA public TO mcp_readonly;
-- Per-table grants — см. §3.3 выше
```

**Department scoping** реализуется на уровне auth-policy: РОП B2G получает токен с `depts: ['b2g']`, и наш auth-middleware режектит вызовы tools, которые работают с D2/R2 через connection.

---

## 4. Tool taxonomy

### 4.1 Слой 1 — Discovery (всегда доступен, без auth-gate)

| Tool | Что делает |
|---|---|
| `list_domains()` | Возвращает массив `{ domain, summary, tool_count }`. Первый вызов агента. |
| `describe_domain(domain)` | Возвращает: `description`, `tools[]` (имя + краткое описание + примеры), `key_tables[]`, `glossary_resource_uri` |
| `glossary(term?)` | Если `term` — узкое определение; без — индекс всех терминов с короткими описаниями |

Эти 3 tool'а + 3 resource'а (`glossary.md`, `architecture.md`, `playbook-rop.md`) **автоматически загружаются Claude Desktop** при подключении — это «учебник» для агента.

### 4.2 Слой 2 — Domain tools (curated, role-gated, dept-scoped)

См. §5 — поименный каталог. Каждый tool имеет:

```ts
{
  name: 'okk.get_call_quality_summary',     // namespaced
  description: '<подробное описание + когда использовать + примеры>',
  inputSchema: <JSONSchema>,
  outputSchema: <JSONSchema>,                // структурированный ответ
  roles: ['admin', 'rop', 'manager'],        // кто может вызвать
  scopes: ['b2g', 'b2b'] | 'self',          // dept-scope
  examples: [/* 2-3 canonical вызова */],
}
```

### 4.3 Слой 3 — Escape hatch (admin-only)

| Tool | Что делает |
|---|---|
| `run_readonly_sql(sql, why)` | Прогоняет произвольный SQL под `mcp_readonly`-ролью. Параметр `why` обязателен — попадает в audit log. Statement timeout 10s, hard row limit 5000, prefetched explain ставится в audit. |

**Важно**: escape hatch принципиально живёт отдельно от domain tools. Чтобы вызвать его, агент должен явно решить «curated tools не покрывают» — это не fallback по умолчанию.

### 4.4 Слой 4 (v2) — RAG (для transcripts/feedback)

После v1 добавляется домен `search`:

| Tool | Что делает |
|---|---|
| `search.transcripts(query, filters)` | Семантический поиск по `calls.transcript` через pgvector. Filters: dept, manager, period, score-range. |
| `search.feedback(query, filters)` | Поиск по `evaluations.recommendations` + `evaluations.mistakes` |
| `search.evaluations(query, filters)` | Поиск по `evaluation_json.summary` + блокам |

Embedding-pipeline отдельный (см. §10).

---

## 5. Доменный каталог tools (v1 scope)

**Принцип именования**: `<domain>.<verb>_<noun>`. Verbs: `list_`, `get_`, `find_`, `compare_`, `summarise_`, `count_`, `top_`. Возвращаемые объекты — стабильные JSON-структуры, документированные через `outputSchema`.

### 5.1 Domain `managers` (опора для всех остальных)

| Tool | Inputs | Output | Doc |
|---|---|---|---|
| `managers.list(dept, line?, role?, active?)` | dept, фильтры | Массив `{id, name, dept, line, role, telegram, kommoUserId}` | DASHBOARD-MANAGERS |
| `managers.find_by_name(name, dept?)` | строка | Один `{id, ...}` или null + alternatives | name-aliases применяется |
| `managers.get_profile(id)` | uuid | Полная карта: профиль + текущее расписание + бонусы + последний payroll snapshot | |
| `managers.compare(ids[], period)` | список id + period | Sided-by-side: calls / OKK / roleplay / SLA | для compare_managers вопросов |
| `managers.find_outliers(dept, period, metric)` | dept + period + метрика | Топ-bottom 3 и медиана | drives «у кого падает X» |

**Tables**: `master_managers` (D1), sync-targets (D2/R2/D1/R1).
**Учитывает**: `role='rop' AND line!=NULL` как линейный (project_double_status).

### 5.2 Domain `okk` (реальные звонки + аудит)

| Tool | Inputs | Output |
|---|---|---|
| `okk.summarise_quality(dept, period, lineFilter?, managerId?)` | | Средний total_score, распределение по линиям, top/bottom 5 менеджеров, % calls_with_critical_mistakes |
| `okk.get_call(callId)` | uuid | Детали: транскрипт, evaluation_json (без аудио — это бинарь, не для агента) |
| `okk.find_calls(filters)` | dept, manager, score range, date range, status, prompt_type | Массив `{id, manager, started_at, score, summary}`, лимит 200 |
| `okk.top_problems(dept, period)` | | Аггрегация наиболее частых mistakes по `evaluations.mistakes` (текстовый кластеринг через простые правила; в v2 — RAG) |
| `okk.audit_overrides(dept, period)` | | Те же данные что AuditTab API, агрегированно |
| `okk.coverage_heatmap(dept, period)` | | Per-manager-per-day coverage_pct из phantom_history |

**Tables**: `calls`, `evaluations`, `phantom_history`, `worst_calls` (D2/R2). НЕ `voice_feedback` (PII), НЕ `telephony_cdr` (raw).

**Important rule**: только `total_score IS NOT NULL AND manager_id IS NOT NULL` — orphan-фильтр, как в UI.

### 5.3 Domain `roleplay` (AI-ролевки)

| Tool | Inputs | Output |
|---|---|---|
| `roleplay.summarise(dept, period, lineFilter?, managerId?)` | | Средний score, распределение, кол-во ролевок |
| `roleplay.find_calls(filters)` | | Массив ролевок |
| `roleplay.compare_to_okk(managerId, period)` | | OKK score vs roleplay score — gap analysis |
| `roleplay.training_gaps(managerId)` | | Какие критерии устойчиво проседают (cross OKK + roleplay) |

**Tables**: `d1_users` + `d1_calls` (B2G), `r1_users` + `r1_calls` (B2B).

### 5.4 Domain `daily` (план-факт)

| Tool | Inputs | Output |
|---|---|---|
| `daily.get_snapshot(dept, date, period)` | | Полный DailySnapshot — те же секции что UI |
| `daily.compare_periods(dept, periodA, periodB)` | | План-факт diff между двумя периодами |
| `daily.section(dept, sectionKey, date, period)` | | Один раздел (funnel / qualifier / salesBuh / ...) |
| `daily.plan_vs_fact(dept, metricKey, period)` | | Time-series plan/fact для одной метрики |
| `daily.refusals(dept, period)` | | Топ причин отказов (B2G non_qual_enum_id, B2B b2b_close_reason_enum_id) |

**Tables**: `daily_plans`, `master_managers`, `manager_schedule` (D1) + `analytics.leads_cohort/communications/sla/tasks/lead_status_changes` + `okk.evaluations` + `d1/r1.calls`. Координируется через существующий `buildDailyResponse` (reuse, не дублировать!).

### 5.5 Domain `analytics` (отчёт по AI-оценкам)

| Tool | Inputs | Output |
|---|---|---|
| `analytics.scores_by_period(dept, source, line?, from, to, groupBy)` | | Тот же контракт что `/api/analytics` |
| `analytics.scores_by_manager(dept, source, period)` | | Manager breakdown |
| `analytics.criterion_drift(dept, source, period, criterionName)` | | Динамика конкретного критерия по периодам |
| `analytics.compare_funnels(dept, source, period)` | | Cross-funnel сравнение в режиме `line=all` |

**Tables**: см. DASHBOARD-ANALITIKA.md. **Reuse**: `processBlocks`, `funnelLabelForOkk`, `funnelLabelForRoleplay` из существующего code.

### 5.6 Domain `looker` (cohort/SLA/TLT)

| Tool | Inputs | Output |
|---|---|---|
| `looker.all_calls(dept, period, slice?)` | | All Calls view |
| `looker.cohorts(dept, period, slice?, slaRange?, pipeline?, status?)` | | Cohorts view |
| `looker.cohorts_drilldown(dept, period, manager)` | | Per-lead worst-deals |
| `looker.tlt_summary(dept, period, slices[])` | | TLT агрегаты |
| `looker.conversions(dept, period)` | | Воронка переходов статусов |
| `looker.sla_outliers(dept, period, threshold_minutes)` | | Менеджеры с SLA > threshold |

**Tables**: `analytics.{leads_cohort, communications, lead_status_changes, sla}`. **Все запросы — raw SQL** в едином с дашбордом стиле; reuse helpers из `looker/data/route.ts`.

### 5.7 Domain `tracking` (Активность)

| Tool | Inputs | Output |
|---|---|---|
| `tracking.timeline(dept, managerId, date)` | | Per-minute call/crm/idle классификация для одного менеджера-дня |
| `tracking.workload_summary(dept, period)` | | Per-manager: total_call_min, total_crm_min, idle_pct |
| `tracking.event_breakdown(dept, period, types[]?)` | | Per-event-type counts |

**Tables**: `tracking_events` (Tracking DB) + `master_managers` (D1).

### 5.8 Domain `termin` (B2G-only)

| Tool | Inputs | Output |
|---|---|---|
| `termin.cohort_chart(dept='b2g', from, to)` | | Тот же контракт что `/api/dashboard/termins` |
| `termin.outliers(period, threshold_days)` | | Лиды с отклонениями от среднего срока |

**Tables**: `analytics.leads_cohort` + `analytics.lead_status_changes`. Только B2G + pipeline_id = 12154099.

### 5.9 Cross-domain: SQL escape hatch

| Tool | Roles | Notes |
|---|---|---|
| `sql.run_readonly(sql, why, db?)` | admin only | `db` = `'d1' \| 'r1' \| 'd2' \| 'r2' \| 'analytics' \| 'tracking'`, default `'analytics'`. Каждый вызов: `EXPLAIN` сначала, отказ если cost > 1e6. Hard row limit 5000. |

---

## 6. Markup-стратегия (3 слоя)

### 6.1 Layer 1 — Postgres `COMMENT ON`

Самый низкий уровень. Видим через `information_schema.columns.comment` любым SQL-клиентом.

```sql
COMMENT ON TABLE okk.evaluations IS
  'AI-оценка одного реального звонка. Один ряд = одна оценка. Связан с calls через call_id.';

COMMENT ON COLUMN okk.evaluations.override_metadata IS
  'JSON метаданные программных корректировок AI-оценки. Ключи: is_followup, followup_signal_source (lead_id|phone_fallback|phone_fallback_no_crm|null), prior_count, call_type (primary|followup|interrupted|unqualified|transfer|deferred_start|unknown), overrides_applied (массив правил), score_before_override, score_after_override.';
```

**Скоуп v1**: 6 БД × ~5 ключевых таблиц = ~30 таблиц. ~250 колонок с комментариями.
**Реализация**: серия миграций `00XX_comments.sql` per-DB. Применяется один раз, версионируется в `drizzle/`.
**Скрипт-генератор**: `scripts/generate-pg-comments.ts` парсит DASHBOARD-*.md docs + schema-*.ts типы и эмитит SQL.

### 6.2 Layer 2 — MCP Resources (Markdown)

Подгружается в контекст агента **автоматически при подключении**. Размер бюджет ~30KB total.

| Resource URI | Источник | Размер |
|---|---|---|
| `mcp://glossary` | `mcp-server/src/resources/glossary.md` | ~5KB |
| `mcp://architecture` | автогенерится из `docs/DASHBOARD-INDEX.md` | ~10KB |
| `mcp://playbook-rop` | `mcp-server/src/resources/playbook-rop.md` (типовые вопросы → tool sequence) | ~8KB |
| `mcp://changelog` | автогенерится из git tag'ов на `mcp-server/` | ~3KB |
| `mcp://domain/<name>/dictionary` | per-domain `dictionary.md` (~1-2KB каждый) | 8 × 1.5KB |

### 6.3 Layer 3 — Tool descriptions

Каждый tool в registry имеет:

```ts
description: `
  Возвращает сводку качества OKK-оценок за период.
  
  Используй когда РОП/админ спрашивает:
   - «как качество звонков на этой неделе»
   - «у кого средний балл упал»
   - «сравни апрель и март»
  
  Учитывает только evaluated calls (total_score IS NOT NULL) и orphan-фильтр (manager_id IS NOT NULL).
  ROP с непустой line учитывается как линейный (Татьяна Дерикова).
  Период — Berlin civil-day.
  
  Если нужно копнуть глубже в конкретный звонок — okk.get_call.
  Если интересует тренд по одному критерию — analytics.criterion_drift.
`,
inputSchema: { type: 'object', properties: {
  dept: { type: 'string', enum: ['b2g', 'b2b'] },
  period: { type: 'object', properties: { from: ..., to: ... } },
  lineFilter: { type: 'string', enum: ['all', '1', '2', '3'], default: 'all' },
  managerId: { type: 'string', format: 'uuid', description: 'опционально, фильтр на одного менеджера' },
}},
outputSchema: { /* строгая структура */ },
examples: [
  { input: { dept: 'b2g', period: 'this-week' }, summary: 'качество всей b2g за текущую неделю' },
  { input: { dept: 'b2b', period: { from: '2026-04-01', to: '2026-04-30' }, lineFilter: '2' }, summary: 'апрель, b2b, только 2-я линия' },
],
```

---

## 7. Безопасность

### 7.1 Connection-уровень

- **Read-only роль** на каждой БД (см. §3.3). DDL запрещён, INSERT только в одну таблицу `mcp_audit_log`.
- **Statement timeout 10s**, idle-in-tx 30s, work_mem 32MB.
- **Hard row limit** 5000 enforced в DB layer (`db/guards.ts`) — обвязка `LIMIT` поверх любого raw query плюс fail если `EXPLAIN cost > 1e6`.

### 7.2 Authentication / Authorization

```
.env.production:
  MCP_BEARER_TOKENS=<JSON>
  
JSON shape:
[
  { "token": "sk-mcp-<random>", "userId": "antares", "name": "Антон", "role": "admin", "depts": ["b2g","b2b"], "issued": "2026-04-30" },
  { "token": "sk-mcp-<random>", "userId": "dima",    "name": "Дмитрий", "role": "rop",   "depts": ["b2g"],        "issued": "2026-04-30" },
  { "token": "sk-mcp-<random>", "userId": "ruzanna", "name": "Рузанна", "role": "rop",   "depts": ["b2b"],        "issued": "2026-04-30" }
]
```

- **Token rotation**: ручной, раз в квартал. `scripts/mcp-rotate-tokens.ts` генерирует новые, рассылает через Discord DM.
- **Role gates**: tool registry проверяет `tool.roles` против `ctx.role` до вызова.
- **Dept scope**: tool, который требует `dept`-input, режектится если запрошенный dept не в `ctx.depts` (кроме `admin`, у которого `['*']`).

### 7.3 PII handling

| Поле | Видимость admin | Видимость rop/manager | Замечание |
|---|---|---|---|
| `calls.transcript` (full) | ✓ | masked: только сегмент менеджера, replicas клиента → `[client said: <N words>]` | Защищает клиента |
| `calls.contact_phone` | masked: `+7***1234` | masked: `+7***1234` | Никто не получает полный номер через MCP |
| `voice_feedback.transcript` | ✓ | ✗ | Голос-фидбек менеджера приватен |
| `evaluations.evaluation_json.summary` | ✓ | ✓ | Без PII по контракту |
| `master_managers.telegram_username` | ✓ | ✓ для своего dept'а | |

PII-handler — централизованный helper `utils/pii.ts`, применяется в каждом output-formatter.

### 7.4 Audit log

Таблица `mcp_audit_log` в D1:

```sql
CREATE TABLE mcp_audit_log (
  id           BIGSERIAL PRIMARY KEY,
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id      TEXT NOT NULL,        -- из bearer-token claims
  user_role    TEXT NOT NULL,
  user_depts   TEXT[],
  tool_name    TEXT NOT NULL,
  tool_input   JSONB NOT NULL,        -- полный input (минус секреты)
  duration_ms  INTEGER,
  rows_returned INTEGER,
  status       TEXT NOT NULL,         -- 'ok' | 'error' | 'denied'
  error_msg    TEXT,
  -- Для sql.run_readonly:
  raw_sql      TEXT,
  why          TEXT
);

CREATE INDEX idx_mcp_audit_ts ON mcp_audit_log(timestamp DESC);
CREATE INDEX idx_mcp_audit_user ON mcp_audit_log(user_id, timestamp DESC);
CREATE INDEX idx_mcp_audit_tool ON mcp_audit_log(tool_name, timestamp DESC);
```

Каждый tool-invocation пишет ряд (через middleware). Используется для:
1. **Debug**: «РОП пожаловался что ответ кривой» → найти запрос → проиграть руками.
2. **Tuning**: «какие tools вызывают чаще всего?» → знать что оптимизировать.
3. **Security**: подозрительные паттерны escape-hatch'а.

### 7.5 Secrets

- Token-store **только в env**, не в БД. Чтобы новый токен — релиз.
- `.env.production` в Dokploy UI — не коммитится. Доступ — только админ Dokploy.
- DB-DSN-ы — отдельные `MCP_*_RO_URL` env vars, не пересекаются с дашбордовскими.

---

## 8. Phasing

### Phase 0 — Comments backfill (1–2 дня, можно начать прямо сейчас, не блокирует MCP)

**Скоуп**: написать `COMMENT ON` для всех таблиц/колонок 6 БД через серию миграций.

- [ ] `scripts/generate-pg-comments.ts` — парсит DASHBOARD-*.md docs (особенно «Источники данных» секции) и schema-*.ts → эмитит SQL миграции по одной на БД
- [ ] Применить миграции через Neon SQL editor (HTTP timeout-safe)
- [ ] Smoke-test: `SELECT obj_description('public.master_managers'::regclass)` — должно вернуть нашу строку

**Полезность независимо от MCP**: drizzle-studio показывает комментарии, любой Postgres-клиент тоже. Окупается даже без MCP.

### Phase 1 — MCP scaffold + 2 домена (managers + okk) (3–4 дня)

- [ ] Sub-package `mcp-server/` (package.json, tsconfig, Dockerfile)
- [ ] Stdio entry-point (для local dev и тестов)
- [ ] HTTP entry-point (с bearer auth middleware)
- [ ] DB connections layer (6 read-only Drizzle instances)
- [ ] Discovery tools (list_domains, describe_domain, glossary)
- [ ] Domain `managers` (5 tools, см. §5.1) — full
- [ ] Domain `okk` (6 tools, см. §5.2) — full
- [ ] Resource files: `glossary.md`, `architecture.md` (auto-gen), `playbook-rop.md` (черновик)
- [ ] Audit log middleware + migration `mcp_audit_log` table
- [ ] README с инструкцией для РОПа («Скопируй URL + token в Claude Desktop > Settings > Connectors»)
- [ ] Локальный тест через Claude Code (stdio)

**DoD Phase 1**: я задаю Claude Code «как у Маши конверсия в апреле?» → он находит её через `managers.find_by_name`, тянет `okk.summarise_quality`, выдаёт связный ответ. Без галлюцинаций колонок.

### Phase 2 — Деплой + 2 домена (daily + analytics) (2–3 дня)

- [ ] Dockerfile финальный, hardened
- [ ] `docker-compose.yml` — добавить mcp-сервис
- [ ] Dokploy сервис: домен `mcp.sternmeister.de`, env vars, секреты
- [ ] TLS через Dokploy reverse-proxy (Traefik)
- [ ] Domain `daily` (5 tools)
- [ ] Domain `analytics` (4 tools)
- [ ] Sentry интеграция (project `mcp-server`)
- [ ] First РОП-test: подключить Дмитрия к Claude Desktop, дать ему 5–10 типовых вопросов. Собрать audit log.

**DoD Phase 2**: РОП может задать 10 заранее заготовленных вопросов и получить корректный ответ без участия админа.

### Phase 3 — Looker + tracking + termin (2 дня)

- [ ] Domain `looker` (6 tools)
- [ ] Domain `tracking` (3 tools)
- [ ] Domain `termin` (2 tools)
- [ ] Domain `roleplay` (4 tools)
- [ ] Расширить `playbook-rop.md` живыми примерами из audit log Phase 2

### Phase 4 — Escape hatch + golden-tests (2 дня)

- [ ] `sql.run_readonly` tool с EXPLAIN-guard и hard-limit'ом
- [ ] Golden-eval suite: 30 канонических вопросов → ожидаемые tool-цепочки → checkable assertions
- [ ] CI integration: `npm run mcp:test` запускает golden suite через mock-Claude (вызовы tool'ов прямо, без LLM)

**DoD Phase 4**: 30 golden Q&A проходят на CI. Любой PR на `mcp-server/` гоняет их.

### Phase 5 (v2, не v1) — RAG для transcripts (отдельный проект, 3–4 дня)

- [ ] `pgvector` extension в Analytics Neon
- [ ] `analytics.transcripts_embeddings` таблица: `(call_id, embedding vector(1536), model_version, created_at)`
- [ ] ETL: `scripts/embed-transcripts.ts` — chunk транскрипта на сегменты по 500 токенов, embedding через Anthropic / OpenAI / Voyage
- [ ] Cron: `/api/embeddings/sync/cron` — incremental, новые звонки за последние 24h
- [ ] Domain `search` (3 tools, см. §4.4)
- [ ] Update `playbook-rop.md` примерами семантических вопросов

---

## 9. Versioning

- **Семантика**: SemVer. Major bump при breaking changes в outputSchema любого tool. Minor — новый tool / новое поле в outputSchema. Patch — bug fix.
- **Visibility**: tool registry эмитит свою версию в `describe_domain` ответе. Глобальный `mcp_version` = git tag.
- **Changelog**: автогенерация из conventional commits на `mcp-server/*` файлах в `mcp://changelog` resource.
- **Backward compatibility**: добавлять, не удалять. Deprecate-then-remove с минимум 1 minor lag.

---

## 10. Тестирование

### 10.1 Unit (per-tool)

`mcp-server/tests/tools/<domain>/<tool>.test.ts` — тестит то, что tool правильно роутит inputs → SQL → outputs. Mock'и DB.

### 10.2 Golden eval suite

`mcp-server/tests/golden/*.json` — JSON-фикстуры:

```json
{
  "id": "manager-conversion-drop-april",
  "question": "как у Маши конверсия в апреле?",
  "expected_tool_chain": [
    { "tool": "managers.find_by_name", "input_match": { "name": "Маша" } },
    { "tool": "okk.summarise_quality", "input_match": { "managerId": "<uuid>" } }
  ],
  "expected_output_keys": ["calls_total", "okk_avg_score", "vs_previous_month"]
}
```

Run: `npm run mcp:eval` — instantiates server in stdio, посылает запросы как агент, проверяет порядок вызовов и shape of output.

### 10.3 РОП-shadowing (Phase 2)

Первая неделя продакшена — каждый день читать `mcp_audit_log` за последние 24h, искать paths с `status='error'` или `tool='sql.run_readonly'` (значит curated не покрыл). Затыкать дыры новыми curated tools.

---

## 11. Мониторинг

- **Sentry**: separate project `sternmeister-mcp-server`. Ловит unhandled errors + tool-validation failures.
- **Audit log dashboard**: простая страница в основном дашборде `/api/admin/mcp-stats` — таблица «топ-10 tools за последние 7 дней», errors, latencies.
- **Health endpoint**: `GET /health` (no auth) — `{ status, version, uptime, db_connections }`.
- **Sentry alerts**:
  - `mcp_audit_log` status=error растёт — паттерн пробития?
  - `sql.run_readonly` >5/day — curated tools не покрывают
  - tool latency p95 >5s — DB-tuning нужен

---

## 12. Risks & mitigations

| Риск | Вероятность | Импакт | Mitigation |
|---|---|---|---|
| Schema-change в дашборде ломает MCP-tool | Высокая | Medium | Sub-package в одном репо → один CI прогон, миграции и tools меняются в одном PR |
| MCP-сервер становится bottleneck при нагрузке | Низкая (15 user max) | Low | Stateless, horizontal scaling в Dokploy = тривиально |
| Bearer-token утёк | Низкая | Medium | Rotation раз в квартал; audit log палит подозрительные паттерны; роль read-only минимизирует урон |
| Galлюцинации в outputs (LLM придумал данные) | Средняя | High | Curated tools + строгие outputSchemas + audit log — РОП может попросить «покажи raw output» и сравнить |
| Расходы на Anthropic API для РОПов | Низкая | Low | 50 запросов/день × 5 РОПов × $0.10 ≈ $25/мес. Prompt caching снижает в 2–3х. |
| RAG embeddings drift между моделями | Средняя | Medium (только v2) | Хранить `model_version` в таблице, переэмбеддинг batch'ем при смене |
| Конфликт за `statement_timeout` (медленный аналитический запрос) | Средняя | Low | 10s — компромисс. Если задача требует >10s — `sql.run_readonly` admin'ом с явным `SET LOCAL statement_timeout = '60s'` (whitelisted) |

---

## 13. Open questions (нужно решить до старта Phase 1)

1. **Кто первый РОП-tester?** Дмитрий (B2G) или Рузанна (B2B)? — определяет, какой dept-набор tools полировать первым.
2. **Кто будет публиковать сообщения в Discord при rotate-tokens?** — нужен дополнительный admin или достаточно автоматизировать?
3. **Бюджет на RAG (Phase 5)?** Embedding 500K транскриптов через Voyage = ~$50-100 разово + $10/мес incremental. Подтвердить.
4. **Нужен ли веб-UI для admin'а** для просмотра audit log, или достаточно SQL-запроса в дашборд?

---

## 14. Файлы / ссылки

- [`DASHBOARD-INDEX.md`](./DASHBOARD-INDEX.md) — полная карта таблиц по разделам (источник для `architecture.md` resource)
- [`DASHBOARD-*.md`](./) — per-tab docs (источник для domain dictionaries и pg COMMENTS)
- `src/lib/db/schema-*.ts` — Drizzle-схемы (типы для outputSchema'ов)
- `src/lib/daily/*` — query-helpers для reuse в `daily`/`analytics` доменах
- [Anthropic MCP docs](https://modelcontextprotocol.io) — официальная спецификация
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — TS SDK

---

## 15. Acceptance — когда план выполнен полностью

- [ ] 6 РОПов / админов подключены через Claude Desktop, отвечают «работает» на 10 типовых вопросов
- [ ] Audit log за месяц показывает <5% запросов через escape hatch — curated tools покрывают
- [ ] Schema-changes в дашборде не ломают MCP (один PR обновляет оба)
- [ ] RAG (Phase 5) работает на «найди звонки где менеджер прерывал клиента»
- [ ] CI green: golden-tests + unit + lint
- [ ] On-call playbook: что делать когда tool-вызов падает в проде
