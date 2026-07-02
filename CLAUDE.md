# SternMeister Sales Dashboard

Next.js admin dashboard для OKK (call quality control) и Roleplay (AI training) систем
двух sales-отделов (B2G/B2B). Прод: `https://dashboard.sternmeister.online`. Self-hosted
на Dokploy, образ компонуется из `docker-compose.yml` (3 сервиса: `app`, `mcp`, `etl-cron`).

> **Новая Claude-сессия — порядок чтения:**
> 1. Этот файл — карта проекта, ловушки, env, file map.
> 2. [`docs/SESSION-HANDOFF.md`](docs/SESSION-HANDOFF.md) — текущий фокус, что работает, что недавно фикснули.
> 3. [`docs/DASHBOARD-INDEX.md`](docs/DASHBOARD-INDEX.md) — таблица tab → component → API → таблицы.
> 4. [`docs/etl-architecture.md`](docs/etl-architecture.md) — **обязательно** перед любым `INSERT` в `analytics.*`: natural-key + ON CONFLICT правила, Neon retry-hazard.
> 5. Per-tab doc из `docs/DASHBOARD-<TAB>.md` — открывать когда работаешь с конкретной вкладкой.

---

## Tech Stack

| Слой | Что | Версия |
|---|---|---|
| Framework | Next.js (App Router) | 16 |
| Runtime | React | 19 |
| Lang | TypeScript | 5 |
| ORM | Drizzle / drizzle-kit | 0.45 / 0.31 |
| DB driver | `@neondatabase/serverless` (HTTP) | 1.0 |
| Styling | Tailwind CSS | 4 |
| Charts | Recharts | 3.7 |
| Icons | lucide-react | latest |
| AI | xAI Grok (analysis), ElevenLabs Scribe v2 (transcription) | — |
| Telegram | `telegram` (MTProto) — username→ID resolver | — |
| Monitoring | `@sentry/nextjs` (отдельные DSN для `app` и `mcp`) | 10.45 |
| Deploy | Dokploy (self-hosted) → Docker Compose → Traefik | — |
| Pkg | npm workspaces (root + `mcp-server/`) | — |

```bash
npm run dev          # port 3008
npm run build
npm run db:push      # Drizzle → main schema (D1)
npm run db:studio
```

---

## Архитектура: 6 БД, 4 драйвера

Все Neon Postgres. Подключения lazy-инициализируются через Proxy в `src/lib/db/index.ts` и `src/lib/db/okk.ts`.

| Connection | Env var | Что внутри |
|---|---|---|
| **D1** | `DATABASE_URL` | B2G roleplay + **`master_managers`** (single source of truth) + общие таблицы: `daily_plans`, `payroll_runs`, `kommo_tokens`, `scripts`, `call_analyses`, `mcp_audit_log` |
| **R1** | `R1_DATABASE_URL` | B2B roleplay (`r1_users`, `r1_calls`, `r1_avatars`). Авто-derive из D1 (свопает Neon-branch endpoint), если не задано |
| **D2** | `D2_OKK_DATABASE_URL` | B2G OKK: `calls`, `evaluations`, `voice_feedback`, `managers` (синк-таргет от master_managers). Hardcoded fallback |
| **R2** | `R2_OKK_DATABASE_URL` | B2B OKK (та же схема) |
| **Analytics** | `ANALYTICS_DATABASE_URL` | `analytics.*` — Kommo+CDR mirror: `leads_cohort`, `communications`, `lead_status_changes`, `tasks`, `sla`, `etl_locks`, `refusal_enums`. **Primary источник** для Дейли / Звонки / Looker / Активность(calls) |
| **Tracking** | `TRACKING_DATABASE_URL` | `tracking_events` + `tracking_sync_state`. Только для Активность tab (CRM-события Kommo) |

### Department mapping

| Label | Code | Roleplay | OKK | Команда |
|---|---|---|---|---|
| B2G «Госники» | `b2g` | D1 | D2 | Дмитрий |
| B2B «Коммерсы» | `b2b` | R1 | R2 | Рузанна |

Russian aliases: `b2g`=Госники, `b2b`=Коммерсы.

### ETL chain (`src/lib/etl/index.ts:runSync()`)

1. **`fetchLookups`** — Kommo pipelines, users, loss reasons, refusal enums (must-have, hard-fail если упало)
2. **`syncLeads`** → `analytics.leads_cohort` (creates `leadCache` для downstream)
3. **`syncCommunications`** → `analytics.communications` (Kommo `/notes` + `/events` для chat/mail; calls — отдельно через telephony)
4. **`syncStatusChanges`** → `analytics.lead_status_changes`
5. **`syncTasks`** → `analytics.tasks` (пропускается в incremental, тяжёлый)
6. **`updateContactDates`** — back-fill `leads_cohort.contact_date`
7. **`syncTelephony`** — CallGear + CloudTalk CDR → `analytics.communications` с префиксом `cg-leg:N` / `ct:N`. Auto-skip если нет токенов
8. **`enrichTelephonyLeads`** — phone → contact → leads через Kommo `/api/v4/contacts?filter[query]=phone`, **Pattern A fanout** (1 CDR → N rows по matched leads). Sweeps 7d backward в incremental
9. **`computeSla`** → `analytics.sla` (creation→first-call math, ROP-aware)

`runStep()` wraps каждый шаг — isolation, ошибки в `step_errors[]` отправляются в Sentry с `severity:non_fatal`, остальной pipeline идёт. Hard-fail только на `fetchLookups`.

---

## Cron & Schedules

### Где живёт cron — НЕ в Dokploy UI

`schedules:[]` в Dokploy для compose `Dashboard` — **нормально**. Cron-нагрузка вынесена в **отдельный compose-сервис `etl-cron`** (`docker-compose.yml:129-152`):

```yaml
etl-cron:
  image: curlimages/curl:8.7.1
  command: |
    while true; do
      curl -H "x-cron-secret: $CRON_SECRET" http://app:3008/api/analytics/sync/cron
      sleep $SYNC_INTERVAL_SECONDS  # default 600 = 10 мин
    done
```

Это даёт CloudTalk + leads + status + tasks + comms каждые 10 мин.

### CallGear отдельно: hourly Dokploy schedule

CallGear API эмбарго на ~7 часов (recent data unavailable). Поэтому он вынесен в отдельный endpoint `/api/analytics/sync/callgear` (LAG=7h, WINDOW=1h) и hourly Dokploy schedule `etl-callgear-cron` дёргает его (cron `15 * * * *`, runs внутри service `etl-cron` так как там есть `curl` + `CRON_SECRET` в env).

Без этого schedule CallGear молчит — был баг 11–21 мая 2026 (10 дней пропусков, ~3800 cg-leg-строк потеряно, backfill'ом восстановлено).

### Middleware bypass для cron

`src/middleware.ts` whitelist'ит `pathname.startsWith("/api/analytics/sync/")` — без этого CallGear endpoint редиректится в `/login` (фикс `d9079c6`, 2026-05-21).

### Lease-lock в `analytics.etl_locks`

Lock-таблица в Analytics DB. Имена: `cron` (CloudTalk) и `callgear-cron`. Поля `acquired_at`, `expires_at`, `last_completed_at`. Lease TTL ~6 мин (больше maxDuration=300s + grace), auto-expires при крэше тика. **`released = (token = '')` AND `expires_at <= now()`**.

`/api/health/etl` читает `last_completed_at` — алармит если stale > N минут.

---

## Tabs (по `docs/DASHBOARD-INDEX.md`)

| Tab | Label | Доступ | Компонент | API | Главные таблицы |
|---|---|---|---|---|---|
| `dashboard` | Звонки | admin | `DashboardTab.tsx` | `/api/dashboard` | `analytics.communications` (DISTINCT comm_id), `leads_cohort` |
| `daily` | Дейли | admin | `DailyTab.tsx` | `/api/daily` | `analytics.*` + `daily_plans` (plan/fact) |
| `analytics` | Аналитика | admin | `AnalyticsTab.tsx` | `/api/analytics/data` | `analytics.communications` + roleplay (union okk/roleplay) |
| `tracking` | Активность | admin | `TrackingTab.tsx` | `/api/tracking` | `tracking_events` + calls из `analytics.communications` |
| `termins` | Термин | admin | `TerminTab.tsx` | `/api/dashboard/termins`, looker views | `leads_cohort.termin_date/aa_termin_date`, `lead_status_changes` |
| `looker` | Looker | admin | `LookerTab.tsx` | `/api/analytics/looker/data` | `communications` (enriched), `leads_cohort`, `lead_status_changes`, `sla` |
| `funnel` | Воронка | admin | `FunnelTab.tsx` | `/api/funnel/cohorts`, `/api/funnel/cohorts/[id]/[week]/leads`, `/api/funnel/conversions/[id]/target-level`, `/api/funnel/filter-options` | `leads_cohort`, `lead_status_changes`, `lead_close_reason_changes`, `lead_contact_links`, `funnel_target_levels` |
| `real_calls` | ОКК | manager+admin | inline `page.tsx` | `/api/okk/calls` | D2/R2 `calls`+`evaluations` (orphan-фильтр) |
| `ai_calls` | AI Ролевки | manager+admin | inline `page.tsx` | `/api/calls` | D1/R1 `d1_calls` / `r1_calls` |
| `managers` | Менеджеры | admin | `ManagersTab.tsx` | `/api/managers` | `master_managers` + sync targets D2/R2/D1/R1 |
| `call_analysis` | Анализ | admin | `AnalysisTab.tsx` | `/api/analysis` | `call_analyses`, `call_analysis_files` + xAI/ElevenLabs |
| `criteria` | Критерии | admin | `CriteriaTab.tsx` | `/api/criteria` | **D2 OKK БД `criteria_configs`** (jsonb). FS `src/criteria/*.json` — image backup для OKK FS fallback. Editing flow: Dashboard UI POST → `d2OkkDb.criteria_configs` UPSERT + FS write. OKK reads same table via `loadCriteriaConfigCached`. |
| `scripts` | Скрипты | session(R), admin(W) | `ScriptsTab.tsx` | `/api/scripts` | D1 `scripts` |
| `audit` | Аудит | admin | `AuditTab.tsx` | `/api/okk/audit` | D2/R2 `evaluations.override_metadata` JSONB, `phantom_history` |

Auth & роли:
- Session: `/api/auth/me` (HMAC cookie, см. `src/lib/auth`)
- Roles: `admin` (всё), `manager` (только свои звонки, стартует на real_calls)
- Department: `b2g`/`b2b` — initial filter

---

## Critical patterns (соблюдать всегда)

1. **TZ = Europe/Berlin везде.** `TZ=${TZ:-Europe/Berlin}` в compose; в SQL — `(created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin'`; в JS — `tzOffsetMinutes(d, "Europe/Berlin")` из `src/lib/utils/date.ts`. Никогда `new Date(YMD)` без TZ — браузерный midnight уплывает на ±1-2ч в non-Berlin.
2. **`master_managers` в D1 = единственный источник правды.** POST `/api/managers` синкает в targets: `D2.managers`, `R2.managers`, `D1.d1_users`, `R1.r1_users`. Soft-delete (`isActive=false`) — никогда `DELETE`, FK integrity для call history.
3. **Double-status ROP+line.** `role='rop' AND line IS NOT NULL` (e.g. Татьяна Дерикова, line=2) — участвует как линейный сотрудник в Активность / Дейли / Звонки. Plain ROPs без line — координируют, не звонят.
4. **Pattern A fanout.** 1 CDR (`communication_id`) → N rows в `analytics.communications` (по matched leads). Unique-индекс: `(communication_id, COALESCE(lead_id, 0)) WHERE communication_id IS NOT NULL`. **Reads всегда `COUNT(DISTINCT communication_id)`** для правильного счёта; per-pipeline tile намеренно double-counts.
5. **Idempotent ETL.** Все INSERT в `analytics.*` через `ON CONFLICT DO UPDATE` с unique natural-key. Neon HTTP-driver auto-retry'ит до 5 раз — non-idempotent DELETE-then-INSERT даёт duplicates. См. `docs/etl-architecture.md`.
6. **Stale-while-revalidate.** Активность tab + Дейли — отдают immediately из кеша/таблицы, sync дёргается фоном (fire-and-forget). Не блокировать GET на Kommo rate-limit.
7. **Name aliases drift.** `master_managers.name` ↔ `analytics.communications.manager` могут расходиться (Latin/Cyrillic, Maksim/Максим, Є/Е). Lookup в `src/lib/daily/name-aliases.ts`.
8. **CURRENT_FILTER_VERSION (tracking_events).** Сейчас **v12**. Bump при изменении Kommo-фетча → автоматический 90-day re-backfill на mismatch. История версий — в `docs/DASHBOARD-AKTIVNOST.md`.
9. **Env var whitelist в compose.** Любая переменная, не listed в `environment:` блоке `app` сервиса, **невидима в контейнере** даже если задана в Dokploy UI. История: SESSION_SECRET + Telegram tokens проваливались по этой причине.
10. **OKK orphan-фильтр.** Calls в OKK tab видны только если `evaluations.total_score IS NOT NULL AND calls.manager_id IS NOT NULL`. Unscored / от удалённых менеджеров — скрыты.

---

## Env vars

```
# Core
NODE_ENV=production
PORT=3008
TZ=Europe/Berlin
APP_TIMEZONE=Europe/Berlin
SESSION_SECRET=...
ADMIN_BYPASS_PASSWORD=...
NEXT_TELEMETRY_DISABLED=1

# Six DBs
DATABASE_URL=                # D1
R1_DATABASE_URL=             # R1 (auto-derivable)
D2_OKK_DATABASE_URL=         # D2
R2_OKK_DATABASE_URL=         # R2
ANALYTICS_DATABASE_URL=      # Kommo/CDR mirror
TRACKING_DATABASE_URL=       # tracking_events (отдельный Neon project)

# Kommo
KOMMO_ACCESS_TOKEN=          # JWT, ~2kb
KOMMO_API_DOMAIN=sternmeister.kommo.com
KOMMO_SUBDOMAIN=sternmeister
KOMMO_TOKEN_SOURCE=db        # читать из kommo_tokens таблицы (refresh)

# Telephony
CALLGEAR_ACCESS_TOKEN=
CLOUDTALK_API_ID=
CLOUDTALK_API_SECRET=

# Telegram MTProto (username resolution)
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION=            # длинный, ~400 chars
TELEGRAM_OKK_BOT_TOKEN=      # для notifications

# AI
XAI_API_KEY=
ELEVENLABS_API_KEY=

# Cron + MCP
CRON_SECRET=                 # for /api/analytics/sync/*
MCP_BEARER_TOKENS=           # JSON-массив для MCP-server
MCP_D1_RO_URL=               # read-only Postgres role для MCP
# и аналогичные _RO_URL для R1/D2/R2/Analytics

# Monitoring
SENTRY_DSN=                  # app
SENTRY_DSN_MCP=              # отдельный для mcp service
```

---

## Gotchas (топ-10)

1. **Kommo rate-limit:** 7 rps base, 2 rps combined в multi-process. `/notes` endpoint **silently ignores** `filter[created_at]` — ВСЕГДА `filter[updated_at]`. Эта ошибка стоила нам недели расследования (commit `f4bd662`).
2. **CallGear 7h embargo:** API не отдаёт recent data. Hourly endpoint `/api/analytics/sync/callgear` с `LAG_HOURS=7, WINDOW_HOURS=1`. **Окно tick'а ≠ now**, окно = `[now-8h, now-7h]`.
3. **`/notes` ≠ CDR.** PBX-интеграторы пишут Kommo-note для большинства звонков, но НЕ для instant-hangups, route-failures, immediately-cancelled outbound. Этот gap закрывает `sync-telephony.ts` (прямой CDR pull).
4. **Filter-version bump = 90-day re-backfill.** Любое изменение `src/lib/tracking/sync.ts` Kommo-fetch требует `CURRENT_FILTER_VERSION++`. Без bump'а кеш тихо расходится.
5. **B2G sub-lines 2a/2b** — теггируются, но **коллапсятся в `2`** перед Kommo-запросами. В master_managers `line` всегда `1/2/3`.
6. **Phone fallback в communications:** CDR-строки приходят с `lead_id=NULL + pipeline_id=NULL + phone populated`. Per-pipeline reads должны включать `OR pipeline_id IS NULL`, иначе теряем телефонные звонки до enrichment'а.
7. **OKK D2/R2 — только подключённые звонки (≥10s).** Не source-of-truth для total counts. Звонки ≥1s (дозвон) считать через `analytics.communications`.
8. **Daily plans vs daily_snapshots.** Legacy `daily_snapshots` deprecated (2026-04-24), но может всплыть в edge-case queries. Префер `daily_plans`.
9. **Юлия Смирнова (b2b)** — `kommo_user_id=NULL`, работает только в ролевках без Kommo CRM. См. `memory/project_yulia_smirnova_roleplay_only.md`.
10. **Recharts + responsive containers + sticky thead** — есть тонкости с overflow / scroll context. Исправлено в коммитах `2026-05-14`. Если ломаешь — смотри `src/components/DailyTab.tsx` или `AnalyticsTab.tsx` для эталона.

---

## File map (самые часто-нужные)

```
src/lib/db/
  index.ts              ← Proxy lazy-init D1/R1 (roleplay)
  okk.ts                ← D2/R2 (с hardcoded fallback)
  analytics.ts          ← Analytics + neon-setup
  tracking-db.ts        ← Tracking
  schema-existing.ts    ← D1/R1 schema (master_managers + d1_users + scripts + ...)
  schema-okk.ts         ← D2/R2 schema (calls + evaluations)
  schema-analytics.ts   ← analytics.* schema
  schema-tracking.ts    ← tracking_events + tracking_sync_state

src/lib/etl/
  index.ts              ← runSync orchestrator
  sync-communications.ts  ← Kommo notes + events → analytics.communications
  sync-leads.ts         ← analytics.leads_cohort
  sync-status-changes.ts
  sync-tasks.ts
  sync-telephony.ts     ← CallGear + CloudTalk CDR
  enrich-telephony-leads.ts ← phone → lead Pattern A fanout
  compute-sla.ts        ← analytics.sla
  sentry.ts             ← captureEtlException/Message helpers

src/lib/daily/
  analytics-calls.ts    ← Daily+Dashboard read path
  analytics-leads.ts
  build-response.ts     ← Daily tab response orchestrator
  name-aliases.ts       ← master_managers.name ↔ analytics.manager drift

src/lib/tracking/
  sync.ts               ← v12 filter logic, 60s debounce, 90d re-backfill on bump
  timeline.ts           ← per-minute call/crm/idle math, 09:00-20:00 Berlin
  event-types.ts        ← 41 declared types + normalizeEventType
  init.ts               ← schema bootstrap

src/lib/kommo/
  client.ts             ← rate-limited fetcher, getAllCallNotesByDate, fetchRawEvents
  pipeline-config.ts    ← B2G/B2B pipeline IDs
  cache.ts              ← 60s TTL + in-flight dedup

src/lib/telephony/
  types.ts              ← TelephonyCall unified shape
  callgear.ts           ← JSON-RPC 2.0 client (calls_report + call_legs_report)
  cloudtalk.ts          ← Basic-auth REST client

src/lib/auth/            ← HMAC session cookie + getSession() (Node runtime full verify)

src/app/api/
  dashboard/route.ts    ← Звонки tab
  daily/route.ts        ← Дейли tab
  tracking/route.ts     ← Активность tab
  analytics/looker/data/route.ts ← Looker views
  analytics/sync/cron/route.ts   ← 10-min cron (CloudTalk + leads + ...)
  analytics/sync/callgear/route.ts ← hourly cron (CallGear)
  analytics/debug/route.ts       ← per-day comms count
  analytics/debug-kommo/route.ts ← Kommo passthrough
  managers/route.ts     ← master_managers CRUD + sync to targets
  health/etl/route.ts   ← heartbeat (читает etl_locks)

src/middleware.ts       ← Edge: cookie-existence + sync/* + auth bypass

scripts/
  backfill-analytics.ts            ← month-by-month
  backfill-by-day.ts               ← day-by-day с progress log
  backfill-from-telephony.ts       ← CallGear+CloudTalk chunked backfill
  enrich-telephony-leads.ts        ← bulk phone→lead, supports --from --to --chunk
  recompute-sla.ts                 ← после новых links
  link-managers-telephony.ts       ← match master_managers ↔ telephony agents
  ... всего ~56 files

drizzle/
  analytics/0001..0016_*.sql       ← миграции analytics.*
  ...                              ← + D1, OKK, Tracking миграции
```

---

## Manager Management (`/api/managers` POST)

Master table: `master_managers` (D1). Key поля: `name`, `telegramUsername`, `telegramId`,
`department`, `role` (manager/teamlead/rop/admin/prolongation), `line` (1/2/3),
`team` (dima/ruzanna), `inOkk`, `inRolevki`, `kommoUserId`, `callgearEmployeeId`, `cloudtalkAgentId`.

> `prolongation` = менеджер продлений (не МОП, напр. Ирина Сафронова b2b): выпадает из
> всех продажных выборок автоматически — они whitelist'ят роли manager/teamlead/rop.
> В roleplay-синк маппится в `manager` (CHECK в d1_users/r1_users), в OKK синкается как есть.

Flow on save:

1. Soft-delete removed (set `isActive=false` в targets, preserve call history)
2. Resolve Telegram IDs через MTProto когда username меняется/неизвестно
3. Auto-match Kommo user ID по name (если `inOkk: true`)
4. Auto-match CallGear/CloudTalk agent IDs (если creds в env)
5. Upsert в `master_managers`
6. Sync в targets:
   - OKK (D2/R2 `managers`): upsert если `inOkk=true`, иначе deactivate
   - Roleplay (D1/R1 `d1_users` / `r1_users`): upsert если `inRolevki=true` AND `telegramId`, иначе deactivate

Failure isolation: сбой синка в один target → warning, остальное продолжается.

---

## MCP Server

В соседней workspace `mcp-server/` (отдельный сервис в compose, port 3009).

- 8 domains: managers, okk, daily, analytics, looker, tracking, termin, roleplay
- ~35 curated tools
- Bearer-token auth (`MCP_BEARER_TOKENS` JSON-массив с per-user scope)
- Отдельные read-only Postgres роли (`MCP_*_RO_URL`)
- Audit log → `D1.mcp_audit_log`
- Подробности: `docs/MCP-IMPLEMENTATION-PLAN.md`

---

## Recent significant changes (последние 30 дней)

См. `docs/SESSION-HANDOFF.md` для деталей. Highlights:

- **CallGear/CloudTalk hard-split** (2026-04-28): отдельный telephony ETL, idempotent DELETE-then-INSERT, Migration 0005 (phone column + composite unique)
- **Phone → lead enrichment** (2026-04-28..29): Pattern A fanout, Looker drill-down fix
- **Termin tab launch** (2026-04-28): cohort math (creation → termin_date / aa_termin_date), Migration 0006 + backfill
- **Tracking v11** (2026-04-28): ROP+line support в attribution (Татьяна Дерикова) — нынешняя v12 от 2026-05-20
- **Looker всё** (2026-04-29): SLA drill-down, TLT merged, sortable headers, sticky thead
- **Idempotent ETL rules** (2026-05-07): `etl-architecture.md`, Migration 0014/0015 — unique natural-key indexes
- **CallGear 7h embargo workaround** (2026-05-20): `/api/analytics/sync/callgear` hourly endpoint
- **MCP Phase 1-3 landed** (2026-04-30 → 2026-05-21): tools + read-only roles + audit log
- **Pg comments backfill** (2026-05-12): Migration 0012, Drizzle Studio показывает descriptions
- **Middleware cron bypass** (2026-05-21, `d9079c6`): `startsWith("/api/analytics/sync/")` — без этого CallGear endpoint 307 → `/login`

---

## Quick health checks

```bash
# heartbeat
curl -fsS https://dashboard.sternmeister.online/api/health/etl

# per-day comms counts (admin only)
GET /api/analytics/debug?dept=b2g&from=2026-05-20&to=2026-05-21

# direct Kommo passthrough
GET /api/analytics/debug-kommo?from=...T00:00:00Z&to=...T00:00:00Z

# force sync (admin only)
POST /api/analytics/sync?from=...&to=...

# server-side streaming backfill
GET /api/analytics/backfill?from=2026-01-01&to=2026-05-01&chunkDays=7
```

SQL для проверки lock-state:

```sql
SELECT name, token='' AS released, last_completed_at, (now()-last_completed_at) AS since
FROM analytics.etl_locks ORDER BY name;
-- name='cron' → CloudTalk + leads + …
-- name='callgear-cron' → CallGear hourly
```
