# Neon Database Integration

> Historical note: this file originally described the first Neon connection (single `D1_roleplay` DB, ~33 calls). The integration has since grown to **6 Neon Postgres databases** + Kommo + CallGear + CloudTalk + Telegram. This file is kept as a quick reference for the original D1/R1 roleplay layer; full architecture is in [`CLAUDE.md`](./CLAUDE.md) and [`docs/DASHBOARD-INDEX.md`](./docs/DASHBOARD-INDEX.md).

Last reviewed: 2026-05-21.

## The 6-database picture

| Connection | Env var | Schema | Purpose |
|---|---|---|---|
| **D1** | `DATABASE_URL` | `schema-existing.ts` | B2G roleplay + `master_managers` (single source of truth) + common tables (scripts, daily_plans, payroll, …) |
| **R1** | `R1_DATABASE_URL` | `schema-existing.ts` | B2B roleplay (`r1_users`, `r1_calls`, `r1_avatars`). Auto-derived from D1 if blank. |
| **D2** | `D2_OKK_DATABASE_URL` | `schema-okk.ts` | B2G OKK (real evaluated calls) |
| **R2** | `R2_OKK_DATABASE_URL` | `schema-okk.ts` | B2B OKK |
| **Analytics** | `ANALYTICS_DATABASE_URL` | `schema-analytics.ts` (`analytics.*`) | Kommo mirror — feeds Daily, Звонки, Looker, Термин tabs |
| **Tracking** | `TRACKING_DATABASE_URL` | `schema-tracking.ts` | `tracking_events` (Активность tab only) |

## Connection layer

- `src/lib/db/index.ts` — D1/R1 (lazy Proxy, auto-derive of R1 URL by swapping Neon branch endpoint)
- `src/lib/db/okk.ts` — D2/R2 (hardcoded fallback URLs for legacy reasons)
- `src/lib/db/analytics.ts` — Analytics
- `src/lib/db/tracking-db.ts` — Tracking
- `src/lib/db/with-retry.ts` — Neon HTTP retry helper (idempotent reads only)

All connections use `@neondatabase/serverless` (HTTP transport).

## Department routing

| Label | Code | Roleplay DB | OKK DB | Team alias |
|---|---|---|---|---|
| B2G «Госники» | `b2g` | D1 | D2 | `dima` |
| B2B «Коммерсы» | `b2b` | R1 | R2 | `ruzanna` |

API routes accept `?department=b2g|b2b` and pick the right pair of DB connections.

## API endpoints (still relevant)

```bash
# AI roleplay calls + manager stats (legacy endpoint)
GET /api/calls?department=b2g&type=calls
GET /api/calls?department=b2b&type=calls
GET /api/calls?department=b2g&type=managers

# Most current tabs go through richer routes:
GET /api/dashboard         # Звонки tab
GET /api/daily             # Daily tab
GET /api/tracking          # Активность tab
GET /api/analytics/looker/data?view=…   # Looker tab
GET /api/dashboard/termins?dateFrom=&dateTo=   # Термин tab
GET /api/okk/...           # ОКК tab
GET /api/managers          # Менеджеры tab
```

Full route list: `ls src/app/api/`.

## Schema highlights

- `master_managers` (D1) — single source of truth. On save, syncs to D2/R2 `managers` (if `inOkk=true`), D1/R1 `*_users` (if `inRolevki=true` and `telegramId` known), and resolves Kommo + CallGear + CloudTalk IDs by name match. Soft-delete (`isActive=false`) preserves FK references in call history.
- `analytics.communications` — Pattern A fanout: one CDR row can have N copies, one per matched lead. Composite unique `(communication_id, COALESCE(lead_id, 0))`. Reads use `COUNT(DISTINCT communication_id)` to avoid inflation.
- `analytics.leads_cohort` — leads created in window with all custom-field snapshots needed for Termin / status-funnel analysis.
- `evaluations` (D2/R2 OKK) — supports both new (`block_score` + `criteria[]`) and legacy (`score` + `feedback`) JSON shapes.

## Environment

Template in `.env.example`. Full list of vars in [`CLAUDE.md`](./CLAUDE.md#6-environment-variables).

Critical reminder: **anything not listed in `docker-compose.yml`'s `environment:` block won't reach the container** even if set in Dokploy UI. Always update the compose whitelist when adding a new env var.

## Further reading

- [`CLAUDE.md`](./CLAUDE.md) — full architecture entry-point.
- [`docs/DASHBOARD-INDEX.md`](./docs/DASHBOARD-INDEX.md) — tab→table cross-reference.
- [`docs/etl-architecture.md`](./docs/etl-architecture.md) — REQUIRED before writing to `analytics.*`.
- [`docs/kommo-api-usage.md`](./docs/kommo-api-usage.md) — Kommo rate limit policy.
