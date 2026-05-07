# ETL Architecture & Write-Path Rules

Last updated: 2026-05-07

This doc captures the foundational rules every ETL writer in `src/lib/etl/*`
must follow, and the reasoning behind them. It exists because we lost
several days to a class of bugs (heartbeat storms, silent duplicates) that
all came from the same root cause: a Neon HTTP client that retries fetches
combined with non-idempotent writers.

> **TL;DR** — Every ETL table needs a unique index on its natural key, and
> every INSERT must use `ON CONFLICT DO UPDATE`/`DO NOTHING`. Anything else
> is a bug waiting to happen.

---

## 1. Why this matters: the Neon retry hazard

Neon's serverless driver speaks HTTP-over-QUIC under the hood. The fetch
wrapper in [`src/lib/db/neon-setup.ts`](../src/lib/db/neon-setup.ts) retries
transient failures (`fetch failed`, `ECONNRESET`, `terminating connection`,
etc.) up to 5 times with backoff + jitter.

That's correct for read-side resilience. **It is dangerous on the write
side** because of the following sequence:

1. Client sends `INSERT INTO ...` over HTTP.
2. **Server commits the row.**
3. Response packet is dropped on the way back (mobile network blip,
   QUIC route flap, Neon scaler restart, etc.).
4. Client sees `fetch failed`, treats it as transient, retries.
5. Server processes the same INSERT again → **duplicate row.**

There is no general way for the client to know whether step 2 happened.
The HTTP standard explicitly disallows automatic retries for non-idempotent
methods, but that only helps when retries are inside the SDK — our wrapper
treats every Neon query as a black-box fetch. The only safe option is to
make the SQL itself idempotent.

A single retry per query is enough to produce 1 dupe. We've also observed
**4-row dupes** in `lead_status_changes` — likely from concurrent
backfills overlapping with cron ticks, each independently retrying.

---

## 2. The rule

Every ETL table that receives INSERTs must have:

### 2.1 A unique index on its natural key

The "natural key" is the set of columns that identify a single business
entity (one call, one status transition, one lead snapshot — *not* the
surrogate row id). Examples in this codebase:

| Table | Natural key | Index |
|---|---|---|
| `analytics.communications` | `(communication_id, COALESCE(lead_id, 0))` | `communications_comm_lead_unique` (partial, `WHERE communication_id IS NOT NULL`) |
| `analytics.lead_status_changes` | `(lead_id, event_at, status_id)` | `lead_status_changes_unique` |
| `analytics.leads_cohort` | `lead_id` | primary key |
| `analytics.sla` | `lead_id` | primary key |

`COALESCE(...)` and partial indexes (`WHERE ...`) are fine — they let you
keep the constraint while allowing `NULL` legacy rows or fan-out patterns.
See `communications` for both tricks in one index.

### 2.2 INSERTs must be idempotent

Choose one of:

```ts
// Most common: keep the row but refresh mutable snapshot fields on retry/resync.
.onConflictDoUpdate({
  target: [t.naturalKeyA, t.naturalKeyB],
  set: {
    mutableField: sql`EXCLUDED.mutable_field`,
    // ... do NOT include the natural-key columns or recomputed columns
  },
})
```

```ts
// When a row's content can never change once written (e.g. an immutable event):
.onConflictDoNothing({ target: [t.eventId] })
```

```sql
-- Bulk via raw SQL: same shape.
INSERT INTO analytics.x (...) VALUES (...)
ON CONFLICT (natural_key) DO UPDATE SET mutable = EXCLUDED.mutable;
```

### 2.3 No `DELETE-then-INSERT` for incremental syncs

`DELETE FROM t WHERE created_at IN <window>` then `INSERT` looks idempotent
but isn't:

- A retry between DELETE and INSERT can leave the table empty for the window.
- A concurrent run racing on the same window double-deletes and double-inserts.
- A retry of an already-committed INSERT chunk creates dupes (no unique
  constraint to stop it — the DELETE already cleared the way).

Use `INSERT ... ON CONFLICT DO UPDATE` so re-runs converge instead of
churning.

The one acceptable exception: a full-window `DELETE-then-INSERT` for a
table you only ever rewrite atomically (no incremental ticks, no concurrent
writers). None exist in this codebase today.

---

## 3. How to add a new ETL writer

When adding a new table to `analytics.*`:

1. **Decide the natural key** before you write any code. Ask: "if Kommo
   sends me the same event twice, which combination of columns proves it's
   the same thing?"
2. **Add the unique index in the schema** (`schema-analytics.ts`):
   ```ts
   uniqueIndex("table_natural_key_unique").on(t.colA, t.colB)
   ```
3. **Write a migration** that:
   - Dedupes any existing rows (use the `ctid` self-join pattern from
     [`drizzle/analytics/0014_status_changes_unique.sql`](../drizzle/analytics/0014_status_changes_unique.sql)).
   - Creates the unique index.
4. **Write the inserter with `onConflictDoUpdate`**. Only set columns
   that are *mutable snapshots* (manager name, denormalized lookups). Do
   not touch the natural-key columns or columns recomputed by a follow-up
   pass (e.g. window functions).
5. **Verify** by running [`scripts/check-etl-dupes.ts`](../scripts/check-etl-dupes.ts)
   after a backfill. Expected output: zero duplicate groups.

---

## 4. Cron concurrency model

The ETL cron (`/api/analytics/sync/cron`) uses an application-level lease
lock stored in `analytics.etl_locks`. The lock is held for `LEASE_MINUTES`
and updated to `last_completed_at` only on a clean exit. Health is read
through `/api/health/etl`, which alarms when the heartbeat is older than
`STALE_THRESHOLD_MIN`.

Two important consequences:

- **A single cron tick is the only writer at a time.** Manual backfills
  (`scripts/backfill-by-day.ts`, `/api/analytics/backfill`) bypass the
  lock — running one while the cron is live can race on UPSERTs. Idempotent
  writers make this safe (concurrent UPSERTs converge), but non-idempotent
  ones (rule 2.3) do not. Don't run a backfill on a table that doesn't
  follow the rule.
- **Transient lock-acquire failures don't fire `captureEtlException`.**
  The cron route distinguishes transient (skip + warning) from fatal
  (capture exception, return 500). This avoids the 600-event Sentry storm
  we had in DASHBOARD-C/G when Neon flapped for two minutes and the same
  warning fired every poll for hours.

See [`src/app/api/analytics/sync/cron/route.ts`](../src/app/api/analytics/sync/cron/route.ts)
and [`src/lib/db/with-retry.ts`](../src/lib/db/with-retry.ts).

---

## 5. Sentry signal hygiene

Two patterns to avoid issue spam:

- **Stable fingerprint.** Anything captured via
  [`captureEtlMessage`](../src/lib/etl/sentry.ts) that contains a varying
  number (`ageSec`, row count) must pass an explicit `fingerprint: string[]`
  so Sentry collapses repeated events into one issue. Without it, every
  distinct `ageSec` value spawns a new issue.
- **Cooldown for high-frequency probes.** The health endpoint polls every
  60 seconds; a multi-hour outage at 5-minute cooldown produced ~600
  events. Current cooldown is 30 minutes (`SENTRY_COOLDOWN_MS` in
  `/api/health/etl`); increase it further before adding more high-frequency
  capture sites.

---

## 6. Diagnostic tools

| Script | Purpose |
|---|---|
| [`scripts/check-etl-gaps.ts`](../scripts/check-etl-gaps.ts) | Heartbeat age, per-source `MAX(timestamp)`, 96-hour hourly comms distribution. Run after any suspected outage. |
| [`scripts/check-etl-dupes.ts`](../scripts/check-etl-dupes.ts) | Scans the four core tables for duplicate-key groups; flags zero-event business hours. Run after a backfill. |
| `scripts/backfill-by-day.ts` | Day-by-day re-sync. Idempotent **only because** every writer follows rule 2. |

---

## 7. Reference incident — 2026-05-04 → 05-07

What happened:

- Neon had several short transient outages. The fetch wrapper retried
  up to 3 times (later bumped to 5) on `fetch failed`.
- `sync-status-changes` was using `DELETE` + raw `INSERT` with no unique
  index. Retries that landed after a successful server-side commit
  doubled the rows. Across 7 days we accumulated **573 duplicate groups
  / 585 extra rows.**
- Cron lock acquire/release had no app-level retry, so a single Neon blip
  killed a tick. The next health probe found a stale heartbeat and fired
  Sentry. Over a 2-day stale episode this produced **639 events under
  DASHBOARD-C** (de-duped by Sentry's similarity heuristic, but still
  noisy).

Fixes shipped (commits in May 2026):

1. `neon-setup.ts` — 5 retries, jitter, broader retryable patterns.
2. `with-retry.ts` — app-level retry around lock acquire/release.
3. `sync-status-changes.ts` — switched to `INSERT ... ON CONFLICT DO UPDATE`.
4. Migration `0014` — dedupe + unique index on
   `(lead_id, event_at, status_id)`.
5. `health/etl` — 30-minute Sentry cooldown, stable fingerprints.
6. Cron route — transient lock-acquire failures emit warning instead of
   fatal, return 503 + skip.

The lessons are codified in this doc so we don't relearn them.
