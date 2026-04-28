# Session Handoff — Calls / Daily / Dashboard / Tracking / Looker / Термин

Last updated: 2026-04-28 (post phone-enrichment + Termin tab landing)

This doc is for the next Claude Code session. Read it first.

---

## Per-tab architecture docs

- [`DASHBOARD-ZVONKI.md`](./DASHBOARD-ZVONKI.md) — Звонки tab
- [`DASHBOARD-TERMIN.md`](./DASHBOARD-TERMIN.md) — Термин tab (added 2026-04-28)
- [`daily-commerce-spec.md`](./daily-commerce-spec.md) — Daily commerce metrics
- [`mysql-analytics.md`](./mysql-analytics.md) — analytics.* schema reference

---

## TL;DR — what's the current focus

**Termin dashboard tab shipped 2026-04-28.** New section in admin sidebar
(between «Активность» and «Looker»). Cohort line chart of avg days from
Бух Бератер deal creation → assigned «Дата термина» / «Дата термина АА»,
with TERM_DC_DONE-aware AA baseline. Migration `0006_termin_dates.sql`
added two custom-field columns to `analytics.leads_cohort`. Backfill
script `scripts/backfill-termins.ts` populates them from 2026-01-01.
See [`DASHBOARD-TERMIN.md`](./DASHBOARD-TERMIN.md) for full detail.

**Looker phone→lead enrichment landed today** (commit `59d5f9f` + ctid fix `ffdc712`). Pre-fix Looker was showing ~2% of real calls (60 of 3105 in a 4-day B2G window) because every telephony row had `lead_id=NULL` after the 2026-04-28 hard-split. Migration 0005 + Pattern A row fanout now resolves this.

**Done:**
- Migration 0005 applied: `phone` column + composite unique `(communication_id, COALESCE(lead_id, 0))` + helper index. Backup branch `pre-migration-0005-20260428` (`br-curly-river-andpk4mr`).
- `sync-telephony.ts` writes phone now; switched to DELETE-then-INSERT idempotency.
- `enrich-telephony-leads.ts` ETL step: scan unenriched rows, resolve via Kommo `/api/v4/contacts?filter[query]=phone&with=leads`, fan out one row per matched lead. Wired into `runSync` between telephony and SLA.
- `analytics-calls.ts`: `COUNT(DISTINCT communication_id)` via `DISTINCT ON` CTE for Daily/Звонки/per-line/dept-totals (Pattern A intentional double-count kept on per-pipeline helpers).
- Dashboard B2B per-pipeline split re-enabled (cache key v7→v8).
- Looker `cohorts_detail` view + `LookerTab.tsx` row-click drill-down: clicking a manager row in Cohorts inline-expands per-lead detail (lead_id with Kommo deep-link, calendar/business/from-shift SLA columns, ≥30min rows highlighted rose). User can find worst deal per highest-SLA manager.
- Backfill scripts: `scripts/enrich-telephony-leads.ts` + rewrote `scripts/recompute-sla.ts` with chunked CLI.

**Smoke 2026-04-28 (after ctid fix):** in progress at write time. First smoke (before fix) reported 433/437 phones resolved (99%) and 264 fanout copies, but the INSERTs no-op'd because UPDATE before INSERT invalidated ctid. Fix: swap order. Re-run pending verification.

**Next:** full backfill for 2026-01-01..04-27 once smoke is green:
1. `npx tsx scripts/backfill-from-telephony.ts --from 2026-01-01 --to 2026-04-28 --chunk 7` (~15 min, populates phone column on all rows).
2. `npx tsx scripts/enrich-telephony-leads.ts --from 2026-01-01 --to 2026-04-28 --chunk 7` (~30-60 min, Kommo lookups at 7 req/s).
3. `npx tsx scripts/recompute-sla.ts --from 2026-01-01 --to 2026-04-28 --chunk 7` (~2 min, picks up new lead links).

**Earlier focus (background, less urgent):** call-count accuracy across Daily/Звонки/Активность was already good after the `filter[updated_at]` fix (commit `f4bd662` earlier this week). Telephony CDR integration done 2026-04-28 (CallGear + CloudTalk live; 129k rows for Jan-Apr).

---

## What works correctly now

| Component | Status | Notes |
|---|---|---|
| Kommo `/api/v4/leads` fetch | ✅ | Used by ETL `syncLeads`. Pulls correctly with `filter[updated_at]` for incremental, `filter[created_at]` for backfill. |
| Kommo `/api/v4/{entity}/notes` for calls | ✅ | `getAllCallNotesByDate` iterates `contacts + leads + companies`, uses `filter[updated_at][from/to]` (the only documented filter on this endpoint), per-entity try/catch isolation so a 4xx on `/companies/notes` doesn't break the whole call. |
| Kommo `/api/v4/events` for CRM events | ✅ | `fetchRawEvents` loops `KOMMO_ENTITIES = ["lead","contact","company","task"]` (NOT `customer` — Kommo rejects it on `/events`), per-entity blacklist, bisect on 400 "Invalid params" / "Entity doesn't match type filter". |
| Kommo `/api/v4/tasks` | ✅ | `getTasks(isCompleted, kommoUserIds)` filters by `responsible_user_id` (comma-separated list — works on this account, indexed-array form `[0]/[1]` did NOT work, broke department switching). |
| Tracking timeline | ✅ | Always 09:00–20:00 Berlin. Schedule still controls work-day vs vacation/dayoff (`-` / `о`). DST-aware via `tzOffsetMinutes(d, "Europe/Berlin")`. |
| Tracking sync `getCallNotes` Phase-1 | ✅ | Delegates to `fetchRawEvents` (per-entity loop). Then uses `getAllCallNotesByDate` for canonical call rows. |
| ETL `analytics.communications` upsert | ⚠️ | Currently DELETE-by-date + INSERT (not UPSERT). See "Known limitations" below. |
| Dashboard "Звонки" perManager | ✅ | Reads from `analytics.communications` via `analytics-calls.ts:getAnalyticsCallMetricsByMaster`. |
| Looker Cohorts SLA / All Calls | ✅ | Same source. SQL filters `WHERE communication_type LIKE 'call%'`. |
| Daily call metrics | ✅ | Same source. "Дозвон от 1 сек" = `duration >= 1`. |
| Manager attribution fallback | ✅ | `note.created_by` → fallback `note.responsible_user_id` → fallback canonical lead's `responsibleUserId`. Applied in BOTH ETL (`sync-communications.ts`) and tracking (`sync.ts`). |

---

## Known limitations / open issues

### 1. `/notes` ≠ CDR-level call capture (HIGH)

**Status:** CallGear DONE 2026-04-28; CloudTalk blocked on creds.

PBX integrations (CallGear, CloudTalk) write a Kommo note for most call attempts but NOT necessarily for every dial. Instant hangups, connection failures, and immediately-cancelled outbound dials may never produce a Kommo note. The MySQL integrator at `45.156.25.84` reads "Kommo event log + CDR" — they capture more than we do.

**Smoke test 2026-04-27 single-day:**
- CallGear: **1070 operator legs** (677 out, 393 in; 301 connected)
- CloudTalk: **1089 calls** (1057 out, 32 in; 809 connected)
- Combined telephony: **2159 rows** vs 7 Kommo notes (Kommo backfill hasn't reached this date yet)
- OKK D2/R2 stored only ~543 connected calls. Confirms the gap.

**What's wired:**
- `src/lib/telephony/types.ts` — unified `TelephonyCall` shape.
- `src/lib/telephony/callgear.ts` — JSON-RPC 2.0 client (`get.calls_report` + `get.call_legs_report`, joined per-leg).
- `src/lib/telephony/cloudtalk.ts` — Basic-auth client (`/api/calls/index.json`, paginated by date).
- `src/lib/etl/sync-telephony.ts` — fetches both providers in parallel, joins agent_id → master_managers, writes to `analytics.communications` with `cg-leg:N` / `ct:N` prefixes (idempotent: prefix-scoped DELETE-by-date). pipeline_id NULL; call_status=4 for answered.
- `scripts/backfill-from-telephony.ts` — chunked CLI backfill (both providers).
- `runSync` in `src/lib/etl/index.ts` — auto-runs telephony when `CALLGEAR_ACCESS_TOKEN` OR `CLOUDTALK_API_ID` is set; per-provider failure is non-fatal.
- `CALLGEAR_ACCESS_TOKEN` + `CLOUDTALK_API_ID` + `CLOUDTALK_API_SECRET` added to local `.env.local`. **Need to be set in Dokploy etl-cron sidecar env for production.**

**Open items:**
1. **Wider backfill DONE 2026-04-28.** Ran `scripts/backfill-from-telephony.ts --from 2026-01-01 --to 2026-04-28 --chunk 7` in 14m51s. Result: **CallGear 106,516 + CloudTalk 22,557 = 129,073 rows**. CloudTalk account was only activated 2026-03-18, so earlier dates are CallGear-only — that's the integrator's reality, not missing data. Verify with `npx tsx scripts/check-call-coverage.ts --from 2026-01-01 --to 2026-04-28`.
2. **0 kommo orphan rows** across the entire 4-month window — the syncTelephony cleanup pass wiped pre-split `note:N` call rows simultaneously with the wider backfill.
3. **Provision telephony tokens in Dokploy** etl-cron sidecar: `CALLGEAR_ACCESS_TOKEN`, `CLOUDTALK_API_ID`, `CLOUDTALK_API_SECRET`. Until done, prod cron skips telephony silently (logged but no rows added → counts stale until next manual backfill).
4. **3 ROPs + 1 manager** still without telephony links (no API match — they don't have CG/CT accounts at all): Рузанна, Дмитрий, Юлия Смирнова, Кристина Аладко (ct only), Екатерина Маслий (ct only). Fine; their calls don't surface on dashboard.
5. **Hard-split DONE 2026-04-28.** `sync-communications.ts` no longer fetches call notes. Auto-resolve cg+ct IDs at manager save time wired in `/api/managers` POST (Step 3.6). One-shot `scripts/link-managers-telephony.ts` available for backfilling existing rows.

### 2. `analytics.communications` unique key (RESOLVED 2026-04-28)

Migration 0004 (single-column `communication_id` partial unique) was applied earlier; superseded by **Migration 0005** today which:
- Drops the single-column unique.
- Creates `communications_comm_lead_unique` ON `(communication_id, COALESCE(lead_id, 0)) WHERE communication_id IS NOT NULL` to support Pattern A row fanout (one CDR → N rows, one per matched lead).
- Adds `idx_comms_phone_unenriched` for the enrichment scan.

`sync-telephony.ts` switched to DELETE-then-INSERT in window (Drizzle `target` array can't express the COALESCE-in-expression unique). `sync-communications.ts` still ON CONFLICT-by-comm_id-only — works because Kommo notes have unique IDs (verified empirically: 0 duplicates across 209k rows since Jan 1).

### 3. Tracking blacklist is in-process only (LOW)

`INVALID_BY_ENTITY` (per-entity Kommo rejected types) is a `Map<KommoEntity, Set<string>>` in module memory. Cleared on container restart. After restart, the first sync re-learns blacklist via bisect (~5 extra requests per bad type). Acceptable cost.

**Plan if it gets annoying:** add a `tracking_invalid_types` table in TRACKING_DATABASE_URL DB, persist on add, load on `ensureTrackingSchema()`.

### 4. Cron concurrency (LOW)

`SYNC_MIN_INTERVAL_MS = 60_000` debounce only works within a single Node process. Two replicas would run two syncs in parallel for the same department. Currently single-replica on Dokploy so not an issue. If scaling: add `pg_try_advisory_lock(hashtext('tracking-sync-' || dept))`.

---

## Architecture quick-reference

```
┌─ Kommo CRM ─────────────────────┐    ┌─ Telephony (CallGear/CloudTalk) ─┐
│  /api/v4/leads                  │    │  webhook → OKK service           │
│  /api/v4/events                 │    │       ↓                          │
│  /api/v4/{entity}/notes         │    │  okkCalls (D2/R2)                │
│  /api/v4/tasks                  │    │  — only connected (≥10s) calls   │
└──────────────┬──────────────────┘    └──────────────────────────────────┘
               │                                     │
       ETL (15-min cron)                    [PENDING] direct CDR pull
       sync-communications.ts                     for ALL attempts
       sync-leads.ts
       sync-status-changes.ts
       sync-tasks.ts
               │
               ▼
       analytics.* (Neon)                  tracking_events (Neon, separate)
       ├─ leads_cohort                     populated by syncDepartment
       ├─ communications  ← Daily/Звонки/Looker reads here
       ├─ lead_status_changes
       ├─ tasks
       └─ sla
```

---

## Critical recent commits (last 24h)

| Commit | What |
|---|---|
| `f4bd662` | Switch `getAllCallNotesByDate` from `filter[created_at]` (silently ignored) to `filter[updated_at]` (documented). THE fix. |
| `6c36519` | Per-entity try/catch in `getAllCallNotesByDate` so a 4xx on `/companies/notes` doesn't kill the whole call. |
| `2dcbd48` | Drop `customer` from `KOMMO_ENTITIES` — `/events` rejects it. Added `/api/tracking/debug` endpoint. |
| `2fe3b13` | Per-entity loop + comms dedup. Manager attribution fallback (`createdBy → responsibleUserId → lead.responsibleUserId`). |
| `64e99d9` | Per-entity loop in `fetchRawEvents`. PER-entity blacklist. |
| `f70e8f5` | ETL switched from `getCallEvents` (Events API, missed ~18%) to `getAllCallNotesByDate`. |
| `d20ec6c` | Revert getTasks to comma-separated `filter[responsible_user_id]` (indexed `[0]/[1]` broke period switching). |
| `eb982e1` | `/api/analytics/debug` per-day breakdown endpoint. |
| `4eecbc2` | `/api/analytics/debug-kommo` direct Kommo passthrough endpoint. |
| `d4be739` | `/api/analytics/backfill` server-side chunked backfill with streaming progress. |

---

## Useful endpoints (admin only)

```bash
# Compare what's in analytics.communications vs Kommo for a window
GET /api/analytics/debug?dept=b2g&from=2026-04-25&to=2026-04-28
GET /api/analytics/debug-kommo?from=2026-04-25T00:00:00Z&to=2026-04-29T00:00:00Z

# What's in tracking_events
GET /api/tracking/debug?department=b2g&from=2026-04-25&to=2026-04-28

# Trigger ETL re-sync (POST, body { from, to })
POST /api/analytics/sync
GET  /api/analytics/backfill?from=2026-01-28&to=2026-04-28&chunkDays=7  ← streams progress

# Force tracking sync
POST /api/tracking/sync?department=b2g&force=1
POST /api/tracking/sync?department=b2g&from=2026-04-01&to=2026-04-28
```

---

## Useful local scripts

```bash
# Backfill day-by-day (currently running for 2026-01-01 → 2026-04-28, PID 12795)
npx tsx scripts/backfill-by-day.ts --from 2026-01-01 --to 2026-04-28 --chunk 1
# tail progress:
tail -f /tmp/backfill.log

# Month-by-month (existing)
npx tsx scripts/backfill-analytics.ts 2026-01-01 2026-04-28
npx tsx scripts/backfill-analytics.ts 2026-01-01 2026-04-28 --updated-at  # for payment-field updates
```

---

## Env / DB connections in play

| Env var | What it points to |
|---|---|
| `DATABASE_URL` | D1 (B2G roleplay + `master_managers` source of truth) |
| `R1_DATABASE_URL` | R1 (B2B roleplay) |
| `D2_OKK_DATABASE_URL` | D2 OKK (B2G calls — only connected, 543 since 2026-04-07) |
| `R2_OKK_DATABASE_URL` | R2 OKK (B2B calls — only connected, 542 since 2026-03-13) |
| `ANALYTICS_DATABASE_URL` | Neon analytics — `analytics.*` schema. PRIMARY data store for Daily/Dashboard/Looker. |
| `TRACKING_DATABASE_URL` | Neon tracking — `tracking_events`. Separate from analytics. Read by Tracking tab only. |
| `KOMMO_ACCESS_TOKEN` | Kommo API auth (also fallback in `kommo_tokens` D1 table) |
| `CRON_SECRET` | Protects `/api/analytics/sync/cron`, used by Dokploy etl-cron sidecar |

---

## Tracking `CURRENT_FILTER_VERSION` history

Bumped any time the Kommo fetch logic changes in a way that invalidates past tracking_events cache. On mismatch, `ensureRangeCached` re-backfills 90 days.

| Version | What changed |
|---|---|
| v0 | Pre-filter-bug |
| v1 | Explicit `filter[type][]` |
| v2 | Tried `filter[entity]` as comma-list (broken) |
| v3 | Reverted `filter[entity]` |
| v4 | Per-entity loop with single-value `filter[entity]` (5 entities) |
| v5 | Force re-backfill after upsertSyncState bug fix |
| v6 | Drop `customer` entity |
| v7 | Calls via `/notes` instead of `/events` (created_by gap) |
| **v8** | `filter[updated_at]` instead of `filter[created_at]` ← current |

---

## Quick "is everything healthy?" checklist for next session

1. `tail -f /tmp/backfill.log` — is the local backfill still running (or finished)? Look for `=== DONE ===`. If it failed mid-way, list of failures is at the bottom.
2. `GET /api/analytics/debug?dept=b2g&from=2026-04-26&to=2026-04-28` — does each day have non-zero `callsCounted`?
3. `GET /api/analytics/debug-kommo?from=2026-04-28T00:00:00Z&to=2026-04-29T00:00:00Z` — `byEntity.contact + byEntity.lead` should be non-zero if calls happened today.
4. Open Dashboard → Звонки → today. Per-manager call counts should look reasonable (compare to Simple Sales).

If 1 is green and 2 still shows zero — there's a downstream bug between ETL and the dashboard SQL. Investigate.
If 3 returns zero — there's a Kommo-side issue (token expired, account changed). Check `KOMMO_ACCESS_TOKEN` and the `kommo_tokens` table.

---

## Next session's first task (priority)

**TODO when Claude Code is restarted (so /Users/user/okk/.env becomes readable):**

1. `Read /Users/user/okk/.env` — find CallGear/CloudTalk creds. Look for keys like:
   - `CALLGEAR_API_TOKEN`, `CALLGEAR_ACCOUNT_ID`, `CALLGEAR_API_URL`
   - `CLOUDTALK_API_KEY_ID`, `CLOUDTALK_API_KEY_SECRET`
   - `TELEPHONY_*` etc.
2. Read `Read /Users/user/okk/src/webhook/*.ts` to understand event shape they handle.
3. Plan: write CallGear client + CloudTalk client as `src/lib/telephony/{callgear,cloudtalk}.ts`. Both should expose `getAllCallsByDate(from, to)` returning a unified shape:
   ```ts
   { externalId, type: "in"|"out", direction, agentId, phone, startedAt, durationSec, callStatus, sourceTelephony: "callgear"|"cloudtalk" }
   ```
4. Map `agentId` → `master_managers` via `master_managers.callgearEmployeeId` / `cloudtalkAgentId`. Both columns already exist.
5. Write `scripts/backfill-from-telephony.ts`. After local run, integrate into ETL cron.
6. Decide: replace Kommo `/notes` calls with telephony CDR? Or merge both with dedup-by-phone-and-timestamp? My current take: telephony is source-of-truth for CALLS, Kommo `/notes` is needed only for non-call communications (chat messages). Cleanest architecture is to split.

---

## File map for orientation

```
src/lib/kommo/client.ts             ← Kommo API client (rate limit, all fetchers)
src/lib/etl/index.ts                ← ETL orchestrator (runSync)
src/lib/etl/sync-communications.ts  ← writes analytics.communications
src/lib/etl/sync-leads.ts           ← writes analytics.leads_cohort
src/lib/etl/sync-status-changes.ts  ← writes analytics.lead_status_changes
src/lib/etl/sync-tasks.ts           ← writes analytics.tasks
src/lib/etl/compute-sla.ts          ← writes analytics.sla

src/lib/tracking/sync.ts            ← writes tracking_events
src/lib/tracking/timeline.ts        ← shift-window logic, 09:00-20:00 fixed
src/lib/tracking/init.ts            ← schema bootstrap

src/lib/daily/analytics-calls.ts    ← READ from analytics.communications (Daily + Dashboard)
src/lib/daily/build-response.ts     ← Daily tab response orchestrator
src/lib/daily/analytics-leads.ts    ← READ from analytics.leads_cohort

src/app/api/dashboard/route.ts      ← Звонки tab API
src/app/api/daily/route.ts          ← Daily tab API
src/app/api/tracking/route.ts       ← Активность tab API
src/app/api/analytics/looker/data/route.ts ← Looker tab API

src/app/api/analytics/debug/route.ts        ← per-day comms count debug
src/app/api/analytics/debug-kommo/route.ts  ← direct Kommo passthrough
src/app/api/analytics/sync/route.ts         ← admin manual ETL trigger (POST)
src/app/api/analytics/sync/cron/route.ts    ← cron-triggered incremental ETL
src/app/api/analytics/backfill/route.ts     ← server-side streaming chunked backfill
src/app/api/tracking/debug/route.ts         ← per-day tracking_events count

scripts/backfill-by-day.ts          ← LOCAL day-by-day backfill (currently running)
scripts/backfill-analytics.ts       ← LOCAL month-by-month backfill (legacy)
drizzle/analytics/0004_communications_unique.sql ← unique-index migration (pending manual apply)

docs/SESSION-HANDOFF.md             ← this file
docs/DASHBOARD-ZVONKI.md            ← per-section architecture for the Звонки tab
docs/mysql-analytics.md             ← reference for the integrator's MySQL we're replacing
```
