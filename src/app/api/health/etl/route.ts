// GET /api/health/etl
//
// Liveness probe for the ETL cron. Returns 200 when the cron heartbeat
// (analytics.etl_locks.last_completed_at, written by cron route on each
// successful runSync) is younger than `STALE_THRESHOLD_MIN`, 503 otherwise.
//
// Also surfaces unenriched-telephony backlog and per-table data freshness
// so a stuck queue or partial outage is visible.
//
// Why this exists: 2026-04-30 13:57Z the cron crashed in syncCommunications
// and the only signal was a stack trace in container logs. Dashboard kept
// rendering yesterday's numbers without any indication. This endpoint is
// the dashboard's "data is fresh through HH:MM" badge source AND the page
// target for an external uptime check.
//
// Why heartbeat instead of MAX(created_at) on data tables: the latter false-
// positives every night around 02–06 Berlin when Kommo has 0 events for
// the window. Cron ticks fine, comms=0 telephony=0, but MAX stays frozen
// from yesterday's last event and the health probe screams "stale". Using
// the cron's own completion timestamp removes that ambiguity — if the
// heartbeat is fresh, the cron is alive regardless of how quiet Kommo is.

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { captureEtlMessage } from "@/lib/etl/sentry";

export const dynamic = "force-dynamic";

// Cron runs every 10 min, window is 15 min. Anything older than 30 min means
// at least 2 ticks were missed — that's a real problem worth paging on.
const STALE_THRESHOLD_MIN = 30;

// Backlog above this many rows means enrichment can't keep up — won't
// 503 on this alone (enrichment is additive coverage, not core data) but
// reports `degraded: true` and surfaces the count.
const BACKLOG_DEGRADED_THRESHOLD = 2000;

// Sentry rate-limit. Without this the badge polls every 60s and a stale
// episode lasting an hour fires 60 captureEtlMessage calls — Sentry de-dups
// by fingerprint but the issue's event count climbs uselessly. Send at most
// once per status per cooldown window. Process-local cache resets when the
// lambda recycles, which is fine — fresh lambda = fresh signal worth seeing.
const SENTRY_COOLDOWN_MS = 5 * 60 * 1000;
let lastSentryReportAt: { status: string; at: number } | null = null;

interface FreshnessRow {
  source: string;
  latestAt: string | null;
  ageSec: number | null;
}

async function latestTimestamp(
  source: string,
  table: string,
  column: string,
): Promise<FreshnessRow> {
  const res = await analyticsDb.execute<{ latest_at: string | null }>(sql`
    SELECT MAX(${sql.raw(column)})::text AS latest_at
    FROM ${sql.raw(table)}
  `);
  const latestAt = res.rows[0]?.latest_at ?? null;
  const ageSec = latestAt
    ? Math.floor((Date.now() - new Date(latestAt).getTime()) / 1000)
    : null;
  return { source, latestAt, ageSec };
}

async function fetchHeartbeat(): Promise<{ ageSec: number | null; lastCompletedAt: string | null }> {
  const res = await analyticsDb.execute<{
    last_completed_at: string | null;
    acquired_at: string | null;
  }>(sql`
    SELECT last_completed_at::text AS last_completed_at,
           acquired_at::text       AS acquired_at
    FROM analytics.etl_locks
    WHERE name = 'cron'
  `);
  const row = res.rows[0];
  if (!row || !row.last_completed_at) {
    return { ageSec: null, lastCompletedAt: null };
  }
  const ageSec = Math.floor(
    (Date.now() - new Date(row.last_completed_at).getTime()) / 1000,
  );
  return { ageSec, lastCompletedAt: row.last_completed_at };
}

export async function GET(): Promise<NextResponse> {
  try {
    // Run heartbeat + per-table freshness + backlog in parallel.
    const [heartbeat, communications, leadsCohort, statusChanges, sla, backlogRes] =
      await Promise.all([
        fetchHeartbeat(),
        latestTimestamp("communications", "analytics.communications", "created_at"),
        latestTimestamp("leads_cohort", "analytics.leads_cohort", "created_at"),
        latestTimestamp(
          "status_changes",
          "analytics.lead_status_changes",
          "event_at",
        ),
        // SLA table has no row-level recompute timestamp — `last_contact_at`
        // is the most-recently-updated field across the table, so it's the
        // closest proxy. Surfaced for diagnostics only; not used in the
        // health verdict (heartbeat is ground truth).
        latestTimestamp("sla", "analytics.sla", "last_contact_at"),
        analyticsDb.execute<{ n: string | number }>(sql`
          SELECT COUNT(*) AS n
          FROM analytics.communications
          WHERE lead_id IS NULL
            AND phone IS NOT NULL
            AND phone <> ''
            AND communication_type LIKE 'call%'
        `),
      ]);

    const sources = [communications, leadsCohort, statusChanges, sla];
    const noDataSources = sources.filter((s) => s.ageSec === null);
    const enrichmentBacklog = Number(backlogRes.rows[0]?.n ?? 0);

    // Liveness verdict — based on the heartbeat row, NOT on per-table
    // MAX(created_at). This avoids the night-quiet false positive where
    // Kommo has 0 events and analytics MAX freezes at yesterday's last
    // event. The cron writes last_completed_at after every successful
    // runSync, so a fresh heartbeat means the pipeline is alive even when
    // every step processed 0 rows.
    const heartbeatStale =
      heartbeat.ageSec !== null && heartbeat.ageSec > STALE_THRESHOLD_MIN * 60;
    const heartbeatMissing = heartbeat.ageSec === null;
    const stale = heartbeatStale;
    // No-data covers the fresh-deploy case: heartbeat row hasn't been
    // written yet (cron has never completed). Treat as 200 with a hint,
    // not as 503 — uptime checks shouldn't page on a clean deploy.
    const noData = !stale && heartbeatMissing;
    const degraded = !stale && !noData && enrichmentBacklog > BACKLOG_DEGRADED_THRESHOLD;

    const status = stale ? "stale" : noData ? "no_data" : degraded ? "degraded" : "ok";
    const httpStatus = stale ? 503 : 200;
    const staleSources: { source: string }[] = stale ? [{ source: "cron-heartbeat" }] : [];

    // Send a Sentry signal on unhealthy state — but throttle. Badge polls
    // every 60s; without throttling a stale episode of 1 h would fire 60
    // captures. We send at most one per status per SENTRY_COOLDOWN_MS, and
    // always send when status flips (e.g., ok → stale, or degraded → stale).
    if (stale || degraded) {
      const now = Date.now();
      const statusChanged = lastSentryReportAt?.status !== status;
      const cooldownPassed =
        !lastSentryReportAt ||
        now - lastSentryReportAt.at >= SENTRY_COOLDOWN_MS;

      if (statusChanged || cooldownPassed) {
        const ages = sources
          .map((s) => `${s.source}=${s.ageSec ?? "null"}s`)
          .join(", ");
        captureEtlMessage(
          stale
            ? `cron heartbeat stale: ${heartbeat.ageSec ?? "null"}s since last_completed_at`
            : `enrichment backlog ${enrichmentBacklog} > ${BACKLOG_DEGRADED_THRESHOLD}`,
          stale ? "error" : "warning",
          {
            step: stale ? "health:cron-heartbeat" : "health:enrichment-backlog",
            severity: stale ? "fatal" : "warning",
            extra: {
              heartbeat_age_sec: heartbeat.ageSec,
              heartbeat_last_completed_at: heartbeat.lastCompletedAt,
              data_ages: ages,
              enrichmentBacklog,
              statusChanged,
            },
          },
        );
        lastSentryReportAt = { status, at: now };
      }
    } else if (lastSentryReportAt && lastSentryReportAt.status !== "ok") {
      // Recovered — clear the cache so the next stale episode fires
      // immediately instead of waiting out the cooldown.
      lastSentryReportAt = null;
    }

    return NextResponse.json(
      {
        status,
        timestamp: new Date().toISOString(),
        thresholds: {
          stale_min: STALE_THRESHOLD_MIN,
          backlog_degraded: BACKLOG_DEGRADED_THRESHOLD,
        },
        heartbeat: {
          last_completed_at: heartbeat.lastCompletedAt,
          age_sec: heartbeat.ageSec,
        },
        freshness: {
          communications,
          leads_cohort: leadsCohort,
          status_changes: statusChanges,
          sla,
        },
        enrichment: {
          unlinked_calls_pending: enrichmentBacklog,
        },
        stale_sources: staleSources.map((s) => s.source),
        no_data_sources: noDataSources.map((s) => s.source),
      },
      { status: httpStatus },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("[health/etl] probe failed:", err);
    return NextResponse.json(
      { status: "error", error: message },
      { status: 500 },
    );
  }
}
