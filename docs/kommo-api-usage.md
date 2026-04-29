# Kommo API — usage & rate-limit policy

Single reference for how the SternMeister stack consumes the Kommo CRM API.
Read this before adding or modifying any Kommo call site.

## Account-wide rate limit (the rule that matters)

Kommo enforces **7 req/sec per account (subdomain)**. The cap is **token-independent** —
different OAuth tokens / integrations on the same subdomain go into the **same**
bucket. Multiple integrators sharing one Kommo account share one 7 req/sec budget.

Our subdomain hosts:
- **Dashbord** (this repo, Next.js) — own OAuth token
- **okk** (`/Users/user/okk`) — own OAuth token
- Other company integrators outside this stack — own tokens, but same bucket

## Our self-imposed cap: 1 req/sec per process, ≤ 2 req/sec combined

Each of our processes self-caps at **1 req/sec (1000 ms gap)** via a global
in-process mutex. Worst case both Dashbord and okk burst simultaneously =
**2 req/sec from us**, leaving **5 req/sec** for other integrators.

Why 1 rps and not higher: the limiter is per-process, not coordinated across
services or replicas. We can't predict when other integrators run their jobs,
so we stay deliberately low. Bumping the cap requires a global token bucket
(Redis/Postgres), not a constant change.

### Where it's enforced

| Service | File | Constant |
|---------|------|----------|
| Dashbord | `src/lib/kommo/client.ts` | `RATE_LIMIT_MS = 1000` |
| okk | `/Users/user/okk/src/services/kommo.ts` | `RATE_LIMIT_MS = 1000` |

**Do not raise either constant without raising the other in lockstep, and only
after confirming the combined ceiling stays ≤ 2 req/sec.**

### What's in place

- Mutex-based gap between requests (`rateLimitedFetch` in both clients)
- 429 retry through the mutex (so the retry still respects the cap)
- `Retry-After` HTTP header parsing (seconds + HTTP-date), then JSON
  `retry_after` body field, then 1.5 s default
- 30–60 s per-request timeout to prevent stalled sockets pinning the queue
- 5 min TTL cache (`src/lib/kommo/cache.ts`) on hot reads (Dashbord)

### What's NOT in place (known gaps)

- **No cross-process coordination.** Two Dashbord replicas, or a local backfill
  alongside the prod container, each enforce their own 1 rps locally. Combined
  load can briefly exceed our 2 rps target.
- **No cross-service coordination** between Dashbord and okk. Cron-tick
  collisions on the same minute boundary are mitigated only by phase offset.
- **No global token bucket.** A Redis-based limiter is the proper fix; not
  implemented yet.

## Where Kommo is called

### Dashbord
- `src/lib/kommo/client.ts` — single HTTP client, all paths funnel through here
- `src/lib/etl/*.ts` — ETL sync (every 10 min cron, see `docker-compose.yml`
  `etl-cron` sidecar): leads, contacts, events, status changes, tasks
- `src/lib/tracking/sync.ts` — call notes + events for tracking tab
- `src/app/api/dashboard/route.ts` — `getTasks` for dashboard tile (cached 5 min)
- `src/app/api/managers/route.ts` — admin save: list users
- `src/lib/analysis/pipeline.ts` — user-triggered Analysis runs (lead notes)
- `scripts/backfill-*.ts` — one-shot backfills (run locally, share the bucket)

### okk
- `src/services/kommo.ts` — single HTTP client, all paths funnel through here
- `src/jobs/scheduler.ts:103` — CRM fetch cron (`*/5 * * * *` 07–22 MSK):
  contact + leads lookup per call after the 40 min (D2) / 3 h (R2) delay
- `src/webhook/callgear.ts:322`, `src/webhook/cloudtalk.ts:304` — inline
  contact lookup on each accepted webhook call
- `src/api/router.ts`, `src/bot/index.ts` — admin user-directory lookups
  (`getAllKommoUsers`, paginated)
- `scripts/backfill-calls.ts`, `backfill-cloudtalk.ts` — historic replay
- `scripts/sync-manager-ids.ts` — one-shot Kommo user-id resolution

## Rules for new Kommo call sites

1. **Always go through the existing `rateLimitedFetch` / `kommoGet`-style
   wrapper.** Never call `fetch()` against `*.kommo.com` directly.
2. **Cache aggressively.** Anything stable for minutes (pipelines, users,
   custom fields, lookups) belongs in `kommo/cache.ts` or an equivalent.
3. **Avoid per-row Kommo lookups inside loops.** Batch via `filter[id][]=…`
   or pre-fetch + join in memory. The biggest single offender today is
   `searchContactsByPhone` (1 req per phone, no batch endpoint exists) — try
   to satisfy from a local `phone → contact_id` cache before calling.
4. **No `Promise.all` over Kommo calls.** The mutex serializes them anyway,
   but it makes intent clearer and avoids surprising queue depth.
5. **Cron schedules: phase-offset.** Don't add a new `*/5` or `*/10` cron that
   fires on `:00/:05/:10` — pick `:03/:13/:23` etc. so it doesn't collide
   with okk's existing `*/5` CRM fetch.
6. **Backfills run sequentially, not in parallel.** If you start a local
   backfill while prod cron is running, expect 429s — both processes share
   the account bucket. Prefer pausing the prod cron (or running off-hours).
