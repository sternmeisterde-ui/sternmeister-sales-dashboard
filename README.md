# Sternmeister Sales Dashboard

Next.js 16 admin dashboard for SternMeister sales (B2G «Госники» + B2B «Коммерсы»). Аггрегирует Kommo CRM, телефонию (CallGear + CloudTalk), OKK-оценку реальных звонков и AI-ролевки. Дополнительно — MCP-сервер для подключения Claude Desktop/Code.

> **Где смотреть полную картину**: [`CLAUDE.md`](./CLAUDE.md) — entry-point для свежего разработчика. Архитектура, как запустить, что где лежит, какие env-переменные, на что не наступать.
>
> Список разделов и таблиц БД: [`docs/DASHBOARD-INDEX.md`](./docs/DASHBOARD-INDEX.md).
> Текущий фокус и недавние правки: [`docs/SESSION-HANDOFF.md`](./docs/SESSION-HANDOFF.md).
> Бэклог: [`docs/TODO.md`](./docs/TODO.md) и [`todo.md`](./todo.md) (root).

## Стек

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Drizzle ORM · Neon Postgres (6 баз) · Recharts · Lucide · Sentry · Telegram MTProto · CallGear + CloudTalk · xAI Grok · ElevenLabs Scribe. Деплой: Dokploy + Docker Compose. Локальный порт: 3008 (app), 3009 (MCP).

## Быстрый старт

```bash
npm install                # включает workspace mcp-server
cp .env.example .env.local # затем заполнить (6 БД, Kommo, Telephony, Telegram, AI)
npm run dev                # http://localhost:3008
```

Полезные команды (см. `package.json`):

```bash
npm run build
npm run lint
npm run db:generate          # миграции roleplay/OKK
npm run db:migrate
npm run db:studio
npm run db:studio:analytics  # analytics.* схема — отдельный drizzle config
npm run docker:up            # production compose
npm run docker:dev           # dev-compose (только Postgres)
npm run analytics:backfill   # tsx scripts/backfill-analytics.ts
```

Одноразовые операционные скрипты — в `scripts/` (≈50 штук), запускать через `npx tsx scripts/<name>.ts`. Покрывают бэкфилы, аудиты, ETL-повторы, MCP-токены, Telegram-авторизацию.

## Архитектура (TL;DR)

```
Kommo CRM ─┐
CallGear   ├─► ETL (10-min cron) ──► analytics.* (Neon mirror)
CloudTalk  ┘                              │
                                          ▼
   master_managers (D1)            Next.js app (port 3008)
       ├── D1/R1 roleplay (AI-ролевки)
       ├── D2/R2 OKK (реальные звонки + оценки)
       ├── analytics.* (mirror — Daily/Звонки/Looker/Термин)
       └── tracking_events (Активность tab)

         + MCP server (port 3009) — read-only tools для Claude Desktop
```

Шесть Neon-баз: `D1`, `R1`, `D2`, `R2`, `ANALYTICS_DATABASE_URL`, `TRACKING_DATABASE_URL`. Полная карта в [`CLAUDE.md`](./CLAUDE.md#4-architecture-in-one-screen) и [`docs/DASHBOARD-INDEX.md`](./docs/DASHBOARD-INDEX.md).

## Структура репо

```
src/                Next.js app (app router, components, lib, db, etl, kommo,
                    telephony, tracking, daily, analysis, telegram, …)
mcp-server/         MCP sub-package (отдельный workspace, отдельный Dockerfile)
drizzle/            миграции (по папке на каждую БД)
scripts/            оперативные tsx-скрипты (бэкфилы, аудиты, ротация токенов)
public/             статика
docs/               per-tab архитектурные доки + initiatives
иксели/             исходные .xlsx (планы, скрипты, KPI)
ref/                референсные скриншоты (Looker, Kommo UI)
docker-compose.yml          production (3 сервиса: app, mcp, etl-cron)
docker-compose.dev.yml      dev (Postgres сайдкар для локалки)
Dockerfile                  app image
mcp-server/Dockerfile       mcp image
drizzle.config.ts           roleplay + OKK схемы
drizzle.analytics.config.ts analytics.* схема (отдельный config)
```

## Деплой

Dokploy → Docker Compose → Traefik (TLS). См. [`DOCKER.md`](./DOCKER.md) и [`mcp-server/README.md`](./mcp-server/README.md).

Production URLs: `dashboard.sternmeister.online` (app), `mcp.sternmeister.online` (MCP).

## License

Proprietary — internal SternMeister project.
