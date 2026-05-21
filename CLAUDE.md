# SternMeister Sales Dashboard — Claude / Dev Entry-Point

Last reviewed: 2026-05-21

You're about to work on a Next.js admin dashboard for **SternMeister** (Russian-speaking sales org, two departments: B2G "Госники" + B2B "Коммерсы"). The dashboard surfaces call-quality control (OKK), AI roleplay training, daily KPIs, lead-funnel analytics, and CDR/telephony data, pulling from **6 separate Neon Postgres databases** and three external APIs (Kommo CRM, CallGear, CloudTalk).

There is also a separate **MCP server** (`mcp-server/` workspace) that exposes ~35 read-only tools to Claude Desktop/Code so РОПы can ask business questions in natural language. It lives in this repo, ships as a sibling Docker service, and is deployed at `mcp.sternmeister.online`.

If you need to ship something fast, read this file end-to-end, then jump straight to `docs/SESSION-HANDOFF.md` and `docs/DASHBOARD-INDEX.md`. Everything else is reference.

---

## 1. What this project actually is

- **Single Next.js 16 app** (App Router, React 19, TypeScript) at the repo root.
- **MCP sub-server** at `mcp-server/` — npm workspace, separate Dockerfile, separate Dokploy service. See `mcp-server/README.md` and `mcp-server/INSTALL.md`.
- Deployed to **Dokploy** (self-hosted Docker compose orchestrator), not Vercel. Production compose: `docker-compose.yml`. Local dev compose: `docker-compose.dev.yml` (spins up Postgres only; usually you just run `npm run dev`).
- Three services in production compose: `app` (Next.js, port 3008), `mcp` (MCP HTTP transport, port 3009), `etl-cron` (curl-loop sidecar that pings `/api/analytics/sync/cron` every ~10 min).

## 2. Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) |
| UI | Tailwind 4, Lucide icons, Recharts |
| ORM | Drizzle (`drizzle-orm` + `drizzle-kit`) — schemas in `src/lib/db/schema-*.ts` |
| DB driver | `@neondatabase/serverless` (HTTP, not the WS variant — keeps cold-start fast) |
| Auth | Custom session cookie, `/api/auth/me`, `src/lib/auth.ts` |
| Telegram | `telegram` package (MTProto) for username → user-id resolution |
| Telephony | CallGear (JSON-RPC) + CloudTalk (Basic auth) clients in `src/lib/telephony/` |
| AI | xAI Grok (`XAI_API_KEY`) for call analysis, ElevenLabs Scribe (`ELEVENLABS_API_KEY`) for transcription |
| Monitoring | Sentry (`@sentry/nextjs`), separate DSNs for app and MCP |
| Deploy | Dokploy → Docker → Traefik (TLS) |
| Pkg manager | npm workspaces (root + `mcp-server/`) |

## 3. Run it locally

```bash
npm install                # installs root + mcp-server workspace
cp .env.example .env.local # then fill it in — see Section 6
npm run dev                # Next.js on http://localhost:3008
```

Useful scripts (`package.json`):

```
npm run dev                 # next dev -p 3008
npm run build               # production build
npm run lint                # eslint
npm run db:generate         # drizzle-kit generate (roleplay/OKK schemas)
npm run db:migrate          # drizzle-kit migrate
npm run db:studio           # drizzle studio
npm run db:generate:analytics   # same, but for analytics.* schema (separate config)
npm run db:migrate:analytics
npm run db:studio:analytics
npm run docker:up           # docker-compose up
npm run docker:dev          # docker-compose -f docker-compose.dev.yml up (postgres only)
npm run analytics:backfill          # tsx scripts/backfill-analytics.ts
npm run analytics:backfill:range    # same, takes date args
npm run analytics:backfill:comms    # tsx scripts/backfill-comms.ts
```

There are also ~50 one-off operational scripts in `scripts/` — they're not in `package.json` but you run them with `npx tsx scripts/<name>.ts`. They cover backfills, audits, ETL re-syncs, Kommo probes, Telegram auth, MCP token rotation, etc. Skim the filenames before writing a new one.

To use Drizzle Studio against analytics DB: `npm run db:studio:analytics`. Two configs because `drizzle.config.ts` points at the roleplay/OKK schemas while `drizzle.analytics.config.ts` points at the analytics-mirror schema.

## 4. Architecture in one screen

```
              ┌─────────────────────────────────────────────────────┐
              │  Sources                                            │
              │   • Kommo CRM   (leads, contacts, notes, events)    │
              │   • CallGear    (CDR — every dial leg)              │
              │   • CloudTalk   (CDR — every call)                  │
              │   • Telegram    (MTProto for username→id)           │
              └────────────────────┬────────────────────────────────┘
                                   │
                ┌──────────────────┴───────────────────┐
                │                                      │
                ▼                                      ▼
        ETL cron (10 min)                    OKK service (external)
   src/lib/etl/*.ts                          writes evaluated calls
   → analytics.* mirror                      → D2 / R2 OKK databases
                │
                ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  6 Neon Postgres databases                                  │
   │   D1  DATABASE_URL          B2G roleplay + master_managers  │
   │   R1  R1_DATABASE_URL       B2B roleplay                    │
   │   D2  D2_OKK_DATABASE_URL   B2G OKK (real calls)            │
   │   R2  R2_OKK_DATABASE_URL   B2B OKK                         │
   │   AN  ANALYTICS_DATABASE_URL  Kommo mirror (analytics.*)    │
   │   TR  TRACKING_DATABASE_URL   tracking_events (Активность)  │
   └────────────────────────┬────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
       Next.js app (3008)           MCP server (3009)
       src/app/api/*                mcp-server/src/*
       src/components/*Tab.tsx      ~35 curated read-only tools
```

The 6-DB map and every tab's data source is documented in `docs/DASHBOARD-INDEX.md` — read that file before touching any reading query.

## 5. Where the code lives

```
src/
├─ app/
│  ├─ api/                  REST endpoints (analysis, analytics, audio, auth,
│  │                        bug-reports, calls, criteria, daily, dashboard,
│  │                        error-report, health, kommo, managers, okk,
│  │                        scripts, telegram, tracking)
│  ├─ login/page.tsx        login screen
│  ├─ layout.tsx            root layout, favicon = /logo.png from public/
│  └─ page.tsx              main dashboard — owns tab state + role gating
├─ components/              one *Tab.tsx per sidebar section + popups + charts
│                           AnalysisTab, AnalyticsTab, AuditTab, CalendarPicker,
│                           CallsChart, CriteriaTab, DailyTab, DashboardTab,
│                           DinoLoader, LookerTab, ManagersTab, ReportBugPopup,
│                           SchedulePopup, ScriptsTab, TabelPopup, TerminTab,
│                           TerminLeadDrillModal, TrackingTab, WorstCallsPanel
├─ criteria/                evaluation-criteria data + helpers
├─ hooks/                   React hooks
├─ instrumentation.ts       Sentry init
├─ middleware.ts            auth gate
└─ lib/
   ├─ analysis/             call-analysis pipeline (xAI + ElevenLabs)
   ├─ auth.ts               session helpers
   ├─ config/               department / pipeline / status maps
   ├─ daily/                Daily tab business logic (analytics-calls.ts is the
   │                        key read path; build-response.ts orchestrates)
   ├─ db/                   index.ts (D1/R1), okk.ts (D2/R2), analytics.ts (AN),
   │                        tracking-db.ts (TR), daily-db.ts (lifecycle),
   │                        schema-existing.ts (roleplay), schema-okk.ts,
   │                        schema-analytics.ts, schema-tracking.ts,
   │                        with-retry.ts, neon-setup.ts
   ├─ etl/                  Kommo→analytics.* ETL (sync-leads, sync-communications,
   │                        sync-status-changes, sync-tasks, compute-sla,
   │                        sync-telephony, enrich-telephony-leads, index.ts)
   ├─ kommo/                Kommo API client + OAuth token store
   ├─ scripts/              shared script utilities
   ├─ telegram/             MTProto username→id resolver
   ├─ telephony/            CallGear + CloudTalk clients, unified TelephonyCall
   ├─ tracking/             tracking_events sync (Активность tab)
   └─ utils/                misc helpers

mcp-server/                 npm workspace, separate Dockerfile
├─ src/
│  ├─ auth/                 bearer-token store, per-request ALS context
│  ├─ db/                   6 read-only Neon connections + audit middleware
│  ├─ registry/             list_domains, describe_domain, glossary
│  ├─ domains/              managers / okk / daily / analytics / looker /
│  │                        tracking / termin / roleplay / scripts / analiz
│  ├─ resources/            auto-loaded MD glossary + playbooks
│  ├─ server.ts             factory
│  ├─ stdio.ts              stdio transport (Claude Code local)
│  └─ index.ts              HTTP streamable transport (prod, bearer auth)
└─ tests/                   golden-eval suite (work in progress)

drizzle/                    migrations, one folder per DB
├─ d1/                      D1 roleplay schema migrations
├─ r1/                      R1 roleplay
├─ d2/                      D2 OKK
├─ r2/                      R2 OKK
├─ analytics/               analytics.* (the heavy mirror — read carefully)
├─ tracking/                tracking_events
├─ all/                     migrations applied to multiple branches
└─ meta/                    drizzle journal

scripts/                    ~50 operational scripts (backfills, audits, probes,
                            ETL runners, MCP token rotation, telegram auth, …)

public/                     static assets (logo.png, favicons, svgs)
иксели/                     Excel sources for KPIs / plans / scripts (Russian
                            "икселя" = xlsx files, kept out of the repo root)
ref/                        reference screenshots from the old Looker dashboard
                            and Kommo UI — used to spec what we replicate

docs/                       per-tab architecture docs + initiatives. See §7.
```

## 6. Environment variables

Real values live in `.env.local` (not committed). Template in `.env.example`. Production values live in Dokploy. Anything not listed in `docker-compose.yml` `environment:` whitelist will NOT reach the container even if set in Dokploy UI — this has bitten us before, double-check that file before adding a new env var.

Minimal local set you need to run things:

```
# Databases — all 6 are needed for full functionality
DATABASE_URL=                  # D1 (B2G roleplay + master_managers)
R1_DATABASE_URL=               # R1 (B2B roleplay) — auto-derived if blank
D2_OKK_DATABASE_URL=           # D2 (B2G OKK)
R2_OKK_DATABASE_URL=           # R2 (B2B OKK)
ANALYTICS_DATABASE_URL=        # analytics.* mirror (Daily/Звонки/Looker/Термин)
TRACKING_DATABASE_URL=         # tracking_events (Активность tab)

# Auth (production fails loud if SESSION_SECRET missing)
SESSION_SECRET=
COOKIE_INSECURE=               # set to "1" for http://localhost dev

# Kommo CRM
KOMMO_ACCESS_TOKEN=
KOMMO_SUBDOMAIN=
KOMMO_API_DOMAIN=              # legacy alias still read in some places
KOMMO_TOKEN_SOURCE=            # set to "db" to force using kommo_tokens table

# Telephony CDR (without these, ETL skips telephony silently)
CALLGEAR_ACCESS_TOKEN=
CLOUDTALK_API_ID=
CLOUDTALK_API_SECRET=

# Telegram MTProto (manager save resolves @username → numeric id)
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION=
TELEGRAM_BOT_TOKEN=            # for /login resolution
TELEGRAM_OKK_BOT_TOKEN=

# AI providers (for Анализ tab)
XAI_API_KEY=
ELEVENLABS_API_KEY=

# Roleplay audio servers
D1_API_URL=
R1_API_URL=

# ETL cron secret — protects /api/analytics/sync/cron
CRON_SECRET=

# Discord webhook for in-app bug reports
DISCORD_BUG_REPORT_WEBHOOK_URL=

# Sentry
SENTRY_DSN=

# Timezone (we run on Berlin civil-day everywhere)
TZ=Europe/Berlin
APP_TIMEZONE=Europe/Berlin
```

MCP-server-specific env (only the mcp service consumes these):

```
MCP_BEARER_TOKENS=             # JSON array of { token, userId, role, depts, ... }
MCP_D1_RO_URL=                 # dedicated read-only Postgres role per branch
MCP_R1_RO_URL=
MCP_D2_RO_URL=
MCP_R2_RO_URL=
MCP_ANALYTICS_RO_URL=
MCP_TRACKING_RO_URL=
MCP_SENTRY_DSN=
MCP_ALLOWED_ORIGINS=
```

## 7. Reading order for new contributors

1. **`docs/SESSION-HANDOFF.md`** — current focus, what works, what's broken, recent commits. Always start here.
2. **`docs/DASHBOARD-INDEX.md`** — single tab→component→doc→tables map. Your routing table when answering "where does this metric come from?".
3. **`docs/TODO.md`** — prioritised pending work (P0/P1/P2/P3). Lots of `[x]` clutter from past sprints; the live items are the unchecked ones at the bottom of each section.
4. **`docs/etl-architecture.md`** — REQUIRED before writing any INSERT into `analytics.*`. Documents natural-key + ON CONFLICT rules, Neon HTTP retry hazards, cron concurrency.
5. **`docs/kommo-api-usage.md`** — REQUIRED before touching any Kommo call. Rate limit is 7 rps (we cap at 145ms between requests, 2 rps combined across processes).
6. **Per-tab docs** (`docs/DASHBOARD-*.md`) — read the one matching the tab you're editing. Each lists its data sources at the top.
7. **`mcp-server/README.md`** — only if you're touching the MCP server. Skip otherwise.

## 8. Key cross-cutting patterns

- **Lazy DB initialisation** via Proxy. Connections aren't opened until first SQL. Look at `src/lib/db/index.ts` for the pattern.
- **Soft-delete managers** — `isActive: false` keeps FK references intact in call history. Never hard-delete from `master_managers`.
- **Department routing** — almost every API takes `?department=b2g|b2b`. The handler swaps between D1/R1 (roleplay) or D2/R2 (OKK) connections accordingly.
- **`master_managers` is the single source of truth** (lives in D1). On save, it syncs to D2/R2 (OKK `managers`), D1/R1 (`d1_users`/`r1_users`). Sync failures to individual targets are non-fatal (logged as warnings).
- **Berlin civil-day everywhere** — date math uses `tzOffsetMinutes(d, "Europe/Berlin")`. Server uses `TZ=Europe/Berlin` so OS dates also agree.
- **Pattern A fanout in `analytics.communications`** — one telephony CDR can produce N rows (one per matched lead). Reads must use `COUNT(DISTINCT communication_id)` to avoid double-count. Composite unique `(communication_id, COALESCE(lead_id, 0))`. See `drizzle/analytics/0005_phone_enrichment.sql`.
- **Department aliases** — B2G = `Госники` = `dima` team, B2B = `Коммерсы` = `ruzanna` team. Lines for B2G: 1 = Квалификатор, 2 = Бератер, 3 = Доведение.
- **ROPs (`role='rop'`)** with `line IS NOT NULL` (e.g. Татьяна Дерикова) participate in attribution — special case enshrined in `CURRENT_FILTER_VERSION = v11`.

## 9. Things that are easy to break

- Adding a new env var without putting it in `docker-compose.yml` `environment:` — invisible in prod even when set in Dokploy UI.
- Calling Kommo with `filter[created_at]` on `/notes` — it's silently ignored. Use `filter[updated_at]`. Same on `/events`.
- Running `db:push` against prod. Never. Use `db:generate` + `db:migrate`.
- Writing `analytics.*` without reading `docs/etl-architecture.md` (natural-key + ON CONFLICT, Neon HTTP retry hazards).
- Forgetting to bump `CURRENT_FILTER_VERSION` in `src/lib/tracking/sync.ts` when changing event-type fetch logic — old `tracking_events` will silently mismatch.
- Touching the MCP `MCP_BEARER_TOKENS` env in Dokploy without restarting the service. Token rotation procedure in `mcp-server/README.md`.

## 10. Other reference docs

- `INTEGRATION.md` — initial Neon connection notes (mostly historical; the connection layout has since grown to 6 DBs — see Section 4 here for the current map).
- `DOCKER.md` — Docker setup guide.
- `OKK_фильтрация_звонков.md` — how the external OKK service decides which calls to evaluate (min duration, pipeline-to-evaluation-type mapping). Useful background when something looks "missing" from the ОКК tab.
- `about.md` — short Russian intro, used for stakeholder context.
- `иксели/` — Excel sources of truth for plans, scripts, daily KPIs (the dashboard mirrors what's in those sheets).
- `ref/` — reference screenshots (Looker / Kommo UI) we replicate.
