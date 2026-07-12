// GET /api/analytics/sync/callgear
//
// Hourly CallGear-only telephony sync. Runs on a 7-hour lag because the
// CallGear data API embargoes recent data — we observed -32602
// "invalid_parameter_value" on `date_from` for any window where date_from
// is younger than ~6 hours. The main 10-min ETL cron skips CallGear for
// this reason; this endpoint catches it up.
//
// Window: [now - LAG_HOURS - WINDOW_HOURS, now - LAG_HOURS]. Defaults
// land squarely past the embargo (8h..7h ago, 1h slice) and overlap the
// previous tick by zero — the CDR DELETE-by-comm-id in syncTelephony is
// idempotent against re-pulls anyway.
//
// Schedule via Dokploy cron: hourly, e.g. `0 * * * *`. Same CRON_SECRET
// as the main cron — protected by ?secret= or x-cron-secret header.
//
// Why not embed in the 10-min cron with a wider lookback: that would burn
// Kommo + Neon budget chasing data we already have, and the CallGear
// /catch-up gap is best as a single hourly tick — small, predictable,
// easy to debug.

import { type NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { runSync } from "@/lib/etl";
import { analyticsDb } from "@/lib/db/analytics";
import { isTransientDbError, withDbRetry } from "@/lib/db/with-retry";
import { captureEtlException, captureEtlMessage } from "@/lib/etl/sentry";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const LAG_HOURS = 7;
// 3h window with zero-cost overlap: a failed hourly tick used to lose its
// hour of CallGear forever (window had NO overlap with neighbours). Each
// tick now covers [now-10h, now-7h] but INSERTs only missing CDR ids
// (telephonySkipExisting) — up to 2 consecutive dead ticks self-heal.
const WINDOW_HOURS = 3;

const LOCK_NAME = "callgear-cron";
// Hourly schedule with 5-min lease — well under the 1-hour interval, so
// a stuck tick never blocks the next one for long.
const LEASE_MINUTES = 5;

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
    { label: "callgear-cron:acquire-lock" },
  );
  const row = res.rows[0];
  return row && row.token === token ? token : null;
}

async function releaseLock(token: string): Promise<void> {
  await withDbRetry(
    () => analyticsDb.execute(sql`
      UPDATE analytics.etl_locks
      SET token             = '',
          expires_at        = now(),
          last_completed_at = now()
      WHERE name = ${LOCK_NAME} AND token = ${token}
    `),
    { label: "callgear-cron:release-lock" },
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret =
    req.headers.get("x-cron-secret") ??
    req.nextUrl.searchParams.get("secret");

  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[CallGear cron] CRON_SECRET env var not set");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  if (!secret || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let token: string | null = null;
  try {
    token = await tryAcquireLock();
  } catch (lockErr) {
    const transient = isTransientDbError(lockErr);
    console.error(
      `[CallGear cron] failed to acquire lease lock (${transient ? "transient" : "fatal"}):`,
      lockErr,
    );
    if (transient) {
      captureEtlMessage(
        "CallGear cron skipped — transient DB error on lock acquire",
        "warning",
        {
          step: "callgear-cron:acquire-lock",
          severity: "warning",
          fingerprint: ["etl", "callgear-cron", "acquire-lock-transient"],
          extra: { error: lockErr instanceof Error ? lockErr.message : String(lockErr) },
        },
      );
      return NextResponse.json(
        { success: false, skipped: true, reason: "transient db error on lock acquire" },
        { status: 503 },
      );
    }
    captureEtlException(lockErr, { step: "callgear-cron:acquire-lock", severity: "fatal" });
    return NextResponse.json(
      { success: false, error: "lease-lock query failed" },
      { status: 500 },
    );
  }

  if (!token) {
    console.warn("[CallGear cron] another tick is still running — skipping this run");
    captureEtlMessage(
      "CallGear cron skipped — concurrent run in progress",
      "warning",
      {
        step: "callgear-cron:lock",
        severity: "warning",
        fingerprint: ["etl", "callgear-cron", "concurrent-skip"],
      },
    );
    return NextResponse.json(
      { success: false, skipped: true, reason: "concurrent run in progress" },
      { status: 409 },
    );
  }

  const now = Date.now();
  const toDate = new Date(now - LAG_HOURS * 60 * 60 * 1000);
  const fromDate = new Date(toDate.getTime() - WINDOW_HOURS * 60 * 60 * 1000);

  console.log(
    `[CallGear cron] window: ${fromDate.toISOString()} → ${toDate.toISOString()} (lag ${LAG_HOURS}h)`,
  );

  try {
    // Skip leads/comms/status/tasks/foreign_calls — those are the main
    // cron's job. Only pull CallGear telephony, run enrichment for the new
    // rows, and recompute SLA for affected leads. Telephony provider is
    // filtered to CallGear so we don't redundantly re-pull CloudTalk (which
    // the main cron already covered for this window). foreign_calls would
    // otherwise re-run a full 3-entity-type Kommo /notes pagination every
    // hour for a window the 10-min cron already swept.
    const result = await runSync({
      fromDate,
      toDate,
      incremental: false,
      skip: ["leads", "communications", "status_changes", "tasks", "foreign_calls"],
      telephonyProviders: ["callgear"],
      // Add-missing-only: the 3h window overlaps prior ticks — re-pulled
      // CDRs that are already stored (incl. their enrichment fan-out) are
      // left untouched.
      telephonySkipExisting: true,
    });
    if (result.stepErrors.length > 0) {
      captureEtlMessage(
        `CallGear cron tick had ${result.stepErrors.length} step error(s): ${result.stepErrors.map((e) => e.step).join(", ")}`,
        "warning",
        {
          step: "callgear-cron:summary",
          severity: "warning",
          fingerprint: ["etl", "callgear-cron", "step-errors"],
          extra: {
            stepErrors: result.stepErrors,
            window: { from: fromDate.toISOString(), to: toDate.toISOString() },
          },
        },
      );
    }
    return NextResponse.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    console.error("[CallGear cron] sync failed:", error);
    captureEtlException(error, {
      step: "callgear-cron:runSync",
      severity: "fatal",
      extra: { window: { from: fromDate.toISOString(), to: toDate.toISOString() } },
    });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    try {
      await releaseLock(token);
    } catch (unlockErr) {
      console.warn(
        "[CallGear cron] failed to release lease lock (will auto-expire):",
        unlockErr,
      );
    }
  }
}
