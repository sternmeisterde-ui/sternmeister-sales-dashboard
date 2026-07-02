// GET /api/analytics/sync/cron
// Incremental ETL sync triggered by an external scheduler (Dokploy cron / system cron).
// Fetches leads updated in the last WINDOW_MINUTES + communications created in the same window.
// Protected by CRON_SECRET — no session cookie required (cron jobs have no browser).
//
// Call: GET /api/analytics/sync/cron?secret=<CRON_SECRET>
// Or:   GET /api/analytics/sync/cron  with header  x-cron-secret: <CRON_SECRET>

import { type NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { runSync } from "@/lib/etl";
import { analyticsDb } from "@/lib/db/analytics";
import { isTransientDbError, withDbRetry } from "@/lib/db/with-retry";
import { captureEtlException, captureEtlMessage } from "@/lib/etl/sentry";

export const maxDuration = 300;
// Next.js must not cache this route
export const dynamic = "force-dynamic";

// Overlap window in minutes — slightly larger than the cron interval so we never
// miss an event that landed between two ticks. The advisory lock below stops two
// ticks from running concurrently when one runs longer than the schedule interval.
const WINDOW_MINUTES = 15;

// Telephony (CloudTalk) sweep lookback. A failed/skipped tick used to lose
// its window forever: the 15-min overlap only covers ONE neighbouring tick,
// so calls landing in a dead tick's exclusive 5 minutes never got re-pulled
// (наблюдали ~1%/нед. потерь, пачками по 3-10 мин — июль 2026). Each tick
// now re-reads the last 2 hours of CDRs but, via telephonySkipExisting,
// INSERTs only ids that are absent — existing rows (and their enrichment
// fan-out) stay untouched, so the extra cost is one SELECT per tick.
const TELEPHONY_LOOKBACK_MINUTES = 120;

// Lease lock for the incremental cron. Stored in `analytics.etl_locks`
// (migration 0010) — chosen over `pg_try_advisory_lock` because Neon's HTTP
// driver opens a fresh connection per query, so session-scoped advisory
// locks are released the instant the acquiring statement returns.
//
// Lease is held for `LEASE_MINUTES`; if a tick crashes mid-run, the next
// tick takes over once the lease expires.
const LOCK_NAME = "cron";
// Lease must be > maxDuration (300s = 5 min) so a tick that's still running
// keeps holding the lease, but < cron interval (10 min) so the lease is
// guaranteed to expire before the next tick fires — even if the runtime
// kills the lambda at maxDuration and the `finally` block never executes.
// 6 min = 5 min maxDuration + 1 min grace.
const LEASE_MINUTES = 6;

/** Try to acquire the lease. Returns the token if acquired, null otherwise.
 *
 *  Wrapped in `withDbRetry` so transient Neon hiccups (the dominant failure
 *  mode — Sentry DASHBOARD-G/F) don't drop the tick. Combined with the
 *  fetch-level retries in `neon-setup.ts`, sustained failure here means Neon
 *  has been unreachable for ~2+ minutes, which is a real outage worth a
 *  Sentry signal — a ~1-second blip is not. */
async function tryAcquireLock(): Promise<string | null> {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const res = await withDbRetry(
    () => analyticsDb.execute<{ token: string }>(sql`
      INSERT INTO analytics.etl_locks (name, token, acquired_at, expires_at)
      VALUES (${LOCK_NAME}, ${token}, now(), now() + ${`${LEASE_MINUTES} minutes`}::interval)
      ON CONFLICT (name) DO UPDATE
        SET token       = EXCLUDED.token,
            acquired_at = EXCLUDED.acquired_at,
            expires_at  = EXCLUDED.expires_at
        WHERE analytics.etl_locks.expires_at <= now()
      RETURNING token
    `),
    { label: "etl-cron:acquire-lock" },
  );
  const row = res.rows[0];
  return row && row.token === token ? token : null;
}

/** Release the lease, mark the run as cleanly completed, and stamp
 *  last_completed_at so /api/health/etl can prove the cron is alive even
 *  when no Kommo events landed in this tick (night hours / quiet periods).
 *
 *  We UPDATE rather than DELETE so the row survives as a heartbeat record:
 *    - `expires_at <= now()`  → released
 *    - `last_completed_at`    → most recent successful run
 *    - `token` cleared        → can be acquired again immediately
 *
 *  Token-scoped WHERE so we never release someone else's lease. */
async function releaseLock(token: string): Promise<void> {
  await withDbRetry(
    () => analyticsDb.execute(sql`
      UPDATE analytics.etl_locks
      SET token             = '',
          expires_at        = now(),
          last_completed_at = now()
      WHERE name = ${LOCK_NAME} AND token = ${token}
    `),
    { label: "etl-cron:release-lock" },
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret =
    req.headers.get("x-cron-secret") ??
    req.nextUrl.searchParams.get("secret");

  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[ETL cron] CRON_SECRET env var not set");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  if (!secret || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Overlap protection ────────────────────────────────────────────────
  // Cron interval is 10 min, window is 15 min — 5 min of overlap by design.
  // If a tick runs longer than 10 min (Kommo replay, large backfill), the
  // next tick fires before the previous one finishes and they race on the
  // same INSERT/UPDATE rows.
  let token: string | null = null;
  try {
    token = await tryAcquireLock();
  } catch (lockErr) {
    // Two distinct failure modes here:
    //   - Transient Neon outage that survived 5 fetch retries × 3 statement
    //     retries (~2 min of unreachability). Skip this tick — next one
    //     picks up. Health endpoint already alarms on stale heartbeat, so
    //     no need to fire a fatal here too (avoids the DASHBOARD-G storm).
    //   - Schema/permission error (e.g. migration 0010 not applied). Fire
    //     fatal — this won't self-heal.
    const transient = isTransientDbError(lockErr);
    console.error(
      `[ETL cron] failed to acquire lease lock (${transient ? "transient" : "fatal"}):`,
      lockErr,
    );
    if (transient) {
      captureEtlMessage(
        "ETL cron skipped — transient DB error on lock acquire",
        "warning",
        {
          step: "cron:acquire-lock",
          severity: "warning",
          fingerprint: ["etl", "cron", "acquire-lock-transient"],
          extra: { error: lockErr instanceof Error ? lockErr.message : String(lockErr) },
        },
      );
      return NextResponse.json(
        { success: false, skipped: true, reason: "transient db error on lock acquire" },
        { status: 503 },
      );
    }
    captureEtlException(lockErr, { step: "cron:acquire-lock", severity: "fatal" });
    return NextResponse.json(
      { success: false, error: "lease-lock query failed (run migration 0010?)" },
      { status: 500 },
    );
  }

  if (!token) {
    console.warn("[ETL cron] another tick is still running — skipping this run");
    // Skip is not an error, but we want the signal in Sentry so a stuck
    // tick (lease never released, repeated 409s every 10 min) is visible
    // as a rising warning trend rather than only in container logs.
    captureEtlMessage(
      "ETL cron skipped — concurrent run in progress",
      "warning",
      {
        step: "cron:lock",
        severity: "warning",
        fingerprint: ["etl", "cron", "concurrent-skip"],
      },
    );
    return NextResponse.json(
      { success: false, skipped: true, reason: "concurrent run in progress" },
      { status: 409 },
    );
  }

  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - WINDOW_MINUTES * 60 * 1000);

  console.log(
    `[ETL cron] incremental sync window: ${fromDate.toISOString()} → ${toDate.toISOString()}`,
  );

  try {
    // CallGear's data API embargoes recent data for ~6 hours, so the
    // 10-min cron only ever gets -32602 errors on the CallGear path.
    // Pull only CloudTalk here; CallGear has its own hourly endpoint
    // (/api/analytics/sync/callgear) that runs at now-7h.
    const result = await runSync({
      fromDate,
      toDate,
      incremental: true,
      telephonyProviders: ["cloudtalk"],
      // Wide self-healing sweep for telephony only — add-missing-CDRs mode,
      // Kommo-facing steps keep the narrow window (see TELEPHONY_LOOKBACK_
      // MINUTES above). Enrichment in incremental mode sweeps 7d back, so
      // recovered rows get their lead fan-out on the same tick.
      telephonyFromDate: new Date(toDate.getTime() - TELEPHONY_LOOKBACK_MINUTES * 60 * 1000),
      telephonySkipExisting: true,
    });
    // Per-step errors are already captured inside runStep; surface a
    // summary message if any landed so the cron-level dashboard shows a
    // single rolled-up signal too.
    if (result.stepErrors.length > 0) {
      captureEtlMessage(
        `ETL cron tick had ${result.stepErrors.length} step error(s): ${result.stepErrors.map((e) => e.step).join(", ")}`,
        "warning",
        {
          step: "cron:summary",
          severity: "warning",
          extra: { stepErrors: result.stepErrors, window: { from: fromDate.toISOString(), to: toDate.toISOString() } },
        },
      );
    }
    return NextResponse.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    console.error("[ETL cron] sync failed:", error);
    captureEtlException(error, {
      step: "cron:runSync",
      severity: "fatal",
      extra: { window: { from: fromDate.toISOString(), to: toDate.toISOString() } },
    });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    try {
      await releaseLock(token);
    } catch (unlockErr) {
      // Lease will auto-expire after LEASE_MINUTES — this is non-fatal,
      // just means the next tick waits one extra cycle in the worst case.
      console.warn(
        "[ETL cron] failed to release lease lock (will auto-expire):",
        unlockErr,
      );
    }
  }
}
