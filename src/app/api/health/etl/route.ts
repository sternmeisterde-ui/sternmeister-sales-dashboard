// GET /api/health/etl
//
// Freshness probe for the analytics.* mirror that powers Dashboard / Daily /
// Looker. Returns 200 when the most recent row in each ETL-fed table is
// younger than `STALE_THRESHOLD_MIN`, 503 otherwise.
//
// Also surfaces unenriched-telephony backlog so a stuck queue (e.g., Kommo
// /contacts rate-limit storm) is visible without tailing logs.
//
// Why this exists: 2026-04-30 13:57Z the cron crashed in syncCommunications
// and the only signal was a stack trace in container logs. Dashboard kept
// rendering yesterday's numbers without any indication. This endpoint is
// the dashboard's "data is fresh through HH:MM" badge source AND the page
// target for an external uptime check.

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

export async function GET(): Promise<NextResponse> {
  try {
    // Run all freshness probes in parallel — they're independent.
    const [communications, leadsCohort, statusChanges, sla, backlogRes] =
      await Promise.all([
        latestTimestamp("communications", "analytics.communications", "created_at"),
        latestTimestamp("leads_cohort", "analytics.leads_cohort", "created_at"),
        latestTimestamp(
          "status_changes",
          "analytics.lead_status_changes",
          "event_at",
        ),
        // SLA table has no row-level recompute timestamp — `last_contact_at`
        // is the most-recently-updated field across the table, so it's the
        // closest proxy. If SLA recompute is stuck while communications are
        // still landing, last_contact_at will lag behind communications and
        // we'll catch it through both probes drifting apart.
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
    // Three-state classification:
    //   • ageSec === null       → table is empty (fresh deploy, never synced).
    //                              Not an error — return "no_data" with 200.
    //   • ageSec > threshold    → real staleness — 503.
    //   • ageSec <= threshold   → fresh.
    // Without the no-data branch a freshly-deployed instance returns 503
    // before the first cron tick lands and panics any uptime check.
    const noDataSources = sources.filter((s) => s.ageSec === null);
    const staleSources = sources.filter(
      (s) => s.ageSec !== null && s.ageSec > STALE_THRESHOLD_MIN * 60,
    );
    const enrichmentBacklog = Number(backlogRes.rows[0]?.n ?? 0);

    // Health verdict — 503 only on actual staleness. Backlog alone is
    // "degraded" not "down": OKK / Roleplay tabs still render fine. Empty
    // tables are "no_data" — 200 with a hint, so a fresh deploy doesn't
    // page anyone.
    const stale = staleSources.length > 0;
    const noData = !stale && noDataSources.length > 0;
    const degraded = !stale && !noData && enrichmentBacklog > BACKLOG_DEGRADED_THRESHOLD;

    const status = stale ? "stale" : noData ? "no_data" : degraded ? "degraded" : "ok";
    const httpStatus = stale ? 503 : 200;

    // Send a Sentry signal on every probe that comes back unhealthy. The
    // dashboard / EtlFreshnessBadge is the user-facing surface; Sentry is
    // for off-hours pages and trend alerts. Polled at 60s by the badge,
    // so de-dup is critical — we tag with the worst stale source so
    // Sentry's grouping can collapse "communications stale for an hour"
    // into one issue rather than 60 events.
    if (stale || degraded) {
      const worstSource = staleSources[0]?.source ?? "enrichment-backlog";
      const ages = sources
        .map((s) => `${s.source}=${s.ageSec ?? "null"}s`)
        .join(", ");
      captureEtlMessage(
        stale
          ? `analytics.* stale: ${staleSources.map((s) => s.source).join(", ")}`
          : `enrichment backlog ${enrichmentBacklog} > ${BACKLOG_DEGRADED_THRESHOLD}`,
        stale ? "error" : "warning",
        {
          step: `health:${worstSource}`,
          severity: stale ? "fatal" : "warning",
          extra: {
            ages,
            enrichmentBacklog,
            stale_sources: staleSources.map((s) => s.source),
            no_data_sources: noDataSources.map((s) => s.source),
          },
        },
      );
    }

    return NextResponse.json(
      {
        status,
        timestamp: new Date().toISOString(),
        thresholds: {
          stale_min: STALE_THRESHOLD_MIN,
          backlog_degraded: BACKLOG_DEGRADED_THRESHOLD,
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
