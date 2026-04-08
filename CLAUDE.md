# SternMeister Sales Dashboard

Next.js admin dashboard for managing OKK (call quality control) and Roleplay (AI training calls) systems across two sales departments.

## Tech Stack

- **Framework**: Next.js 16 (App Router), React 19, TypeScript
- **Database**: Neon Serverless PostgreSQL + Drizzle ORM
- **Styling**: Tailwind CSS 4
- **Icons**: Lucide React
- **Charts**: Recharts
- **Telegram**: MTProto via `telegram` package (username-to-ID resolution)
- **Monitoring**: Sentry
- **Deployment**: Dokploy (NOT Vercel), Docker Compose

## Commands

```bash
npm run dev          # Start dev server on port 3008
npm run build        # Production build
npm run db:push      # Push Drizzle schema to DB
npm run db:generate  # Generate Drizzle migrations
npm run db:studio    # Open Drizzle Studio
```

## Architecture

### Database Connections (4 connections, 6 Neon databases)

| Connection | Env Var | Department | Purpose |
|------------|---------|------------|---------|
| D1 | `DATABASE_URL` | B2G | Roleplay DB (main branch) + `master_managers` table |
| R1 | `R1_DATABASE_URL` | B2B | Roleplay DB (child branch, auto-derived from D1 if not set) |
| D2 | `D2_OKK_DATABASE_URL` | B2G | OKK call evaluation DB |
| R2 | `R2_OKK_DATABASE_URL` | B2B | OKK call evaluation DB |

- `src/lib/db/index.ts` — D1/R1 connections (roleplay). R1 URL can be auto-derived by swapping Neon branch endpoint.
- `src/lib/db/okk.ts` — D2/R2 connections (OKK). Has hardcoded fallback URLs.

### Department Mapping

| Label | Code | Roleplay DB | OKK DB | Team | Alias |
|-------|------|-------------|--------|------|-------|
| B2G | `b2g` | D1 | D2 | `dima` | |
| B2B | `b2b` | R1 | R2 | `ruzanna` | |

Russian aliases: B2G = , B2B = 

### Dashboard Tabs

- **Dashboard** — Overview metrics
- **Daily** — Daily performance tracking with plans
- **Analytics** — Charts and analytics
- **Real Calls (OKK)** — Evaluated real call recordings with scores
- **AI Calls (Roleplay)** — AI roleplay training calls
- **Managers** — Master manager table (admin only)
- **Criteria** — Evaluation criteria management

### Auth & Roles

- Session via `/api/auth/me`
- Roles: `admin` (full access), `manager` (sees own calls only, starts on real_calls tab)
- Department: `b2g` or `b2b` (sets initial department filter)

## Manager Management

### Master Managers Table (`master_managers` in D1 database)

Single source of truth for all managers. Located in `src/lib/db/schema-existing.ts`.

Key fields:
- `name`, `telegramUsername`, `telegramId`, `department` (b2g/b2b)
- `role` (manager/rop/admin), `line` (1/2/3), `team` (dima/ruzanna)
- `inOkk` — sync to OKK managers table (D2 or R2)
- `inRolevki` — sync to roleplay users table (D1 or R1, requires `telegramId`)
- `kommoUserId` — auto-resolved from Kommo API by name matching

### Sync Flow (on save via POST `/api/managers`)

1. Soft-delete removed managers (set `isActive: false` in targets, preserve call history)
2. Resolve Telegram IDs via MTProto API when username changes or ID unknown
3. Auto-match Kommo user IDs by name (for managers with `inOkk: true`)
4. Upsert each manager in `master_managers`
5. Sync to targets:
   - **OKK** (D2/R2 `managers` table): if `inOkk` is true, upsert; otherwise deactivate
   - **Roleplay** (D1/R1 `d1_users`/`r1_users`): if `inRolevki` is true AND `telegramId` exists, upsert; otherwise deactivate

### Telegram Resolution

- Uses MTProto API (not Bot API) to resolve `@username` to numeric user ID
- Env vars: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`
- Diagnostic endpoint: `/api/telegram?username=<username>`
- Code: `src/lib/telegram/resolve.ts`

## OKK Calls Display

- Only shows evaluated calls (`total_score IS NOT NULL`)
- Only shows calls with `manager_id` (no orphans)
- B2G line filter: `1` = (qualifier), `2` = (berater), `3` = (dovedenie)
- Managers with `role='rop'` are included in display (e.g. )
- Call number (D1, R1...) shown in table after duration column
- Speaker labeling based on call direction: outbound = Speaker A is client; inbound = Speaker A is manager

## Schema Overview

### Roleplay Schema (`schema-existing.ts`)

- `d1_users` / `r1_users` — Roleplay users (linked by `telegramId`)
- `d1_calls` / `r1_calls` — AI roleplay calls with `evaluationJson`, `score`, `mistakes`, `recommendations`
- `d1_avatars` / `r1_avatars` — AI avatars for roleplay
- `master_managers` — Single source of truth (in D1 DB only)
- `daily_plans` — Daily/weekly/monthly metric plans
- `manager_schedule` — Manager on/off-line schedule
- `kommo_tokens` — Kommo CRM OAuth tokens

### OKK Schema (`schema-okk.ts`)

- `managers` — OKK managers (synced from `master_managers`)
- `calls` — Real calls with recording, transcript, Kommo integration
- `evaluations` — AI evaluation results with `evaluationJson` (blocks/criteria/scores)
- `voice_feedback` — Voice feedback from managers on evaluations

## Environment Variables

```
# Databases
DATABASE_URL=              # D1 (B2G roleplay, main)
R1_DATABASE_URL=           # R1 (B2B roleplay, auto-derivable)
D2_OKK_DATABASE_URL=       # D2 (B2G OKK)
R2_OKK_DATABASE_URL=       # R2 (B2B OKK)

# Telegram MTProto (for username resolution)
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION=

# Kommo CRM
KOMMO_ACCESS_TOKEN=

# Sentry
SENTRY_DSN=
```

## Key Patterns

- **Lazy DB initialization**: DB connections use Proxy pattern for lazy init on first access
- **Soft deletes**: Managers are soft-deleted (`isActive: false`) to preserve FK references in call history
- **Department-aware routing**: Most APIs accept `department` param to select correct DB connection
- **Error isolation**: Sync failures to individual targets produce warnings but don't abort the save
- **Evaluation format compatibility**: OKK evaluations support both new (`block_score`/`criteria[]`) and legacy (`score`/`feedback`) formats
