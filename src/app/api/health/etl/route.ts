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

// Sentry rate-limit. Badge polls every 60s; a multi-hour stale episode
// at 5 min cooldown produced ~600 events under DASHBOARD-C. Bumped to
// 30 min so an 8 h outage produces at most ~16 events. We also
//   1. always fire on status transitions (so a flap is visible immediately),
//   2. send a stable fingerprint so the events ALWAYS group into one issue
//      regardless of the changing `ageSec` in the message.
const SENTRY_COOLDOWN_MS = 30 * 60 * 1000;
let lastSentryReportAt: { status: string; at: number } | null = null;

interface FreshnessRow {
  source: string;
  latestAt: string | null;
  ageSec: number | null;
}

// Возраст считаем В SQL (now() - col), а не в JS: колонки analytics.* — это
// `timestamp without time zone` с UTC-наивными значениями, их ::text не несёт
// зоны, и new Date("YYYY-MM-DD HH:MM:SS") в контейнере с TZ=Europe/Berlin
// парсил их как берлинские → возраст завышался ровно на +2ч и проба ВСЕГДА
// отвечала stale/503 (Sentry-шум каждые 30 мин). Сессия Neon работает в UTC,
// поэтому now()-col в Postgres даёт честный возраст.
async function latestTimestamp(
  source: string,
  table: string,
  column: string,
): Promise<FreshnessRow> {
  const res = await analyticsDb.execute<{ latest_at: string | null; age_sec: string | number | null }>(sql`
    SELECT MAX(${sql.raw(column)})::text AS latest_at,
           EXTRACT(EPOCH FROM (now() - MAX(${sql.raw(column)})))::int AS age_sec
    FROM ${sql.raw(table)}
  `);
  const row = res.rows[0];
  const latestAt = row?.latest_at ?? null;
  const ageSec = row?.age_sec == null ? null : Number(row.age_sec);
  return { source, latestAt, ageSec };
}

async function fetchHeartbeat(): Promise<{ ageSec: number | null; lastCompletedAt: string | null }> {
  // Возраст — в SQL по той же причине, что в latestTimestamp (UTC-naive
  // timestamp + берлинская TZ контейнера ломали JS-парсинг на +2ч).
  const res = await analyticsDb.execute<{
    last_completed_at: string | null;
    age_sec: string | number | null;
  }>(sql`
    SELECT last_completed_at::text AS last_completed_at,
           EXTRACT(EPOCH FROM (now() - last_completed_at))::int AS age_sec
    FROM analytics.etl_locks
    WHERE name = 'cron'
  `);
  const row = res.rows[0];
  if (!row || !row.last_completed_at) {
    return { ageSec: null, lastCompletedAt: null };
  }
  return {
    ageSec: row.age_sec == null ? null : Number(row.age_sec),
    lastCompletedAt: row.last_completed_at,
  };
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
            ? "ETL cron heartbeat stale (>30 min since last_completed_at)"
            : `ETL enrichment backlog above ${BACKLOG_DEGRADED_THRESHOLD}`,
          stale ? "error" : "warning",
          {
            step: stale ? "health:cron-heartbeat" : "health:enrichment-backlog",
            severity: stale ? "fatal" : "warning",
            // Stable fingerprint — keeps Sentry from spawning a fresh issue
            // for every distinct `ageSec` value (which is what gave us the
            // 639-event DASHBOARD-C storm).
            fingerprint: stale
              ? ["etl", "health", "cron-heartbeat-stale"]
              : ["etl", "health", "enrichment-backlog"],
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
