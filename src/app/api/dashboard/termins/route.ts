// GET /api/dashboard/termins?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&granularity=day|week&bucketBy=created_at|termin_date&useFirst=1|0
//
// Two-chart cohort aggregation for the Termin dashboard tab.
//
// chart 1 (bucketBy=created_at, default):
//   Cohort = leads CREATED in the window. For every bucket (Berlin civil day
//   or week of creation):
//     - dcAvgDays: AVG(dc_termin − created) in days. Excludes future termins
//       (dc_termin > NOW()) — waiting on un-occurred appointments would only
//       inflate the average. Excludes past-dated termins (dc_termin < created)
//       as a Kommo data-quality guard.
//     - aaAvgDays: AVG(aa_termin − created) in days. Same future + past-dated
//       guards. Baseline is creation date (NOT the dc_done event).
//     - dcCount / aaCount: leads contributing to the respective AVG.
//     - count: leads in the cohort (any termin, future-scheduled included).
//     - rescheduledCount: leads with at least one TERM_DC_CANCELLED event.
//
// chart 2 (bucketBy=termin_date):
//   Cohort = leads where DC termin OR AA termin date falls in the window.
//   Each lead can contribute to BOTH lines independently — each leg buckets
//   on its own date.
//     - DC line at bucket date X = AVG(dc_termin − created) for leads whose
//       dc_termin = X.
//     - AA line at bucket date X for leads whose aa_termin = X:
//         if dc_termin exists: AVG(aa_termin − dc_termin)
//         else:                AVG(aa_termin − created)
//   No future guard — chart 2 is forward-looking by design.
//
//   Example: client with DC=01.04 and AA=15.04 → one datapoint on the DC line
//   at 01.04 and one on the AA line at 15.04.
//
// `useFirst` controls which termin date is used in metric, bucket and filter:
//   - 1 (default): termin_date_first / aa_termin_date_first (write-once first
//     observed). Reflects the original commitment, not post-reschedule state.
//   - 0: current termin_date / aa_termin_date (live Kommo state).
//
// granularity=week: GROUP BY DATE_TRUNC('week', <bucket source>) — Monday-
// aligned (ISO 8601). Bucket dates are emitted as Berlin civil dates.
//
// Source tables:
//   analytics.leads_cohort        — created_at, termin_date(_first),
//                                   aa_termin_date(_first), pipeline_id, status_id
//   analytics.lead_status_changes — TERM_DC_CANCELLED counts (rescheduled flag)

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import {
  B2G_PIPELINES,
  BERATER_STATUSES,
} from "@/lib/kommo/pipeline-config";
import { addDaysCivil, parseDateBoundary, todayCivil } from "@/lib/utils/date";

interface TerminRow {
  date: string;
  dcAvgDays: number | null;
  aaAvgDays: number | null;
  dcCount: number;
  aaCount: number;
  count: number;
  rescheduledCount: number;
}

type DbRow = {
  cohort_date: string;
  dc_avg_days: string | number | null;
  aa_avg_days: string | number | null;
  dc_cnt: string | number;
  aa_cnt: string | number;
  cnt: string | number;
  rescheduled_cnt: string | number;
};

/** Parse YYYY-MM-DD as a Berlin-local civil date, then resolve to the UTC
 *  instant for `kind` ("start" = 00:00 Berlin, "end" = 23:59:59.999 Berlin). */
function parseBerlinDate(input: string | null, kind: "start" | "end"): Date | null {
  if (!input) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  return parseDateBoundary(input, kind);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const todayBerlin = todayCivil();
  const defaultFromCivil = addDaysCivil(todayBerlin, -29);

  const fromDate =
    parseBerlinDate(url.searchParams.get("dateFrom"), "start") ??
    parseDateBoundary(defaultFromCivil, "start")!;
  const toDateEnd =
    parseBerlinDate(url.searchParams.get("dateTo"), "end") ??
    parseDateBoundary(todayBerlin, "end")!;

  if (fromDate.getTime() > toDateEnd.getTime()) {
    return NextResponse.json(
      { error: "dateFrom must be on or before dateTo" },
      { status: 400 },
    );
  }

  const granularity =
    url.searchParams.get("granularity") === "week" ? "week" : "day";
  const bucketBy =
    url.searchParams.get("bucketBy") === "termin_date" ? "termin_date" : "created_at";
  const useFirst = url.searchParams.get("useFirst") !== "0";

  const pipelineId = B2G_PIPELINES.BERATER;
  const cancelledStatusId = BERATER_STATUSES.TERM_DC_CANCELLED;
  const dcCol = useFirst ? sql`lc.termin_date_first` : sql`lc.termin_date`;
  const aaCol = useFirst ? sql`lc.aa_termin_date_first` : sql`lc.aa_termin_date`;

  const exec = (q: unknown) =>
    (analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }).execute<DbRow>(q);

  let rows: DbRow[];

  if (bucketBy === "termin_date") {
    // Chart 2 — termin-date cohort, two-leg per-line bucketing.
    // DC bucket axis = dc_termin date (Berlin); AA bucket axis = aa_termin date.
    // A lead with both termins in the window contributes to both lines, each
    // at the respective leg's own bucket date.
    const dcBucketExpr =
      granularity === "week"
        ? sql`DATE_TRUNC('week', dc_termin AT TIME ZONE 'Europe/Berlin')::date`
        : sql`DATE(dc_termin AT TIME ZONE 'Europe/Berlin')`;
    const aaBucketExpr =
      granularity === "week"
        ? sql`DATE_TRUNC('week', aa_termin AT TIME ZONE 'Europe/Berlin')::date`
        : sql`DATE(aa_termin AT TIME ZONE 'Europe/Berlin')`;

    const result = await exec(sql`
      WITH cancellations AS (
        SELECT lead_id, COUNT(*)::int AS cancel_events
        FROM analytics.lead_status_changes
        WHERE pipeline_id = ${pipelineId}
          AND status_id = ${cancelledStatusId}
        GROUP BY lead_id
      ),
      base_leads AS (
        SELECT
          lc.lead_id,
          lc.created_at,
          ${dcCol} AS dc_termin,
          ${aaCol} AS aa_termin,
          COALESCE(c.cancel_events, 0) AS cancel_events
        FROM analytics.leads_cohort lc
        LEFT JOIN cancellations c ON c.lead_id = lc.lead_id
        WHERE lc.pipeline_id = ${pipelineId}
          AND lc.status_id <> ${cancelledStatusId}
          AND (
            (${dcCol} IS NOT NULL AND ${dcCol} >= ${fromDate} AND ${dcCol} <= ${toDateEnd})
            OR
            (${aaCol} IS NOT NULL AND ${aaCol} >= ${fromDate} AND ${aaCol} <= ${toDateEnd})
          )
      ),
      dc_leg AS (
        SELECT
          ${dcBucketExpr} AS bucket_date,
          lead_id,
          cancel_events,
          EXTRACT(EPOCH FROM (dc_termin - created_at)) / 86400.0 AS days
        FROM base_leads
        WHERE dc_termin IS NOT NULL
          AND dc_termin >= created_at
          AND dc_termin >= ${fromDate}
          AND dc_termin <= ${toDateEnd}
      ),
      aa_leg AS (
        -- AA per-leg formula:
        --   if dc_termin exists: aa_termin − dc_termin (DC visit → AA appointment)
        --   else:                aa_termin − created_at (full creation → AA)
        SELECT
          ${aaBucketExpr} AS bucket_date,
          lead_id,
          cancel_events,
          EXTRACT(EPOCH FROM (aa_termin - COALESCE(dc_termin, created_at)))
            / 86400.0 AS days
        FROM base_leads
        WHERE aa_termin IS NOT NULL
          AND aa_termin >= COALESCE(dc_termin, created_at)
          AND aa_termin >= ${fromDate}
          AND aa_termin <= ${toDateEnd}
      ),
      unioned AS (
        SELECT 'dc' AS leg, bucket_date, lead_id, cancel_events, days FROM dc_leg
        UNION ALL
        SELECT 'aa' AS leg, bucket_date, lead_id, cancel_events, days FROM aa_leg
      )
      SELECT
        bucket_date::text AS cohort_date,
        ROUND(AVG(days) FILTER (WHERE leg = 'dc')::numeric, 1) AS dc_avg_days,
        ROUND(AVG(days) FILTER (WHERE leg = 'aa')::numeric, 1) AS aa_avg_days,
        COUNT(*) FILTER (WHERE leg = 'dc')::int AS dc_cnt,
        COUNT(*) FILTER (WHERE leg = 'aa')::int AS aa_cnt,
        COUNT(DISTINCT lead_id)::int AS cnt,
        COUNT(DISTINCT lead_id) FILTER (WHERE cancel_events > 0)::int
          AS rescheduled_cnt
      FROM unioned
      GROUP BY bucket_date
      ORDER BY bucket_date ASC
    `);
    rows = result.rows;
  } else {
    // Chart 1 — creation cohort. AA from creation; future-termin guard.
    const cohortBucketExpr =
      granularity === "week"
        ? sql`DATE_TRUNC('week', lc.created_at AT TIME ZONE 'Europe/Berlin')::date`
        : sql`DATE(lc.created_at AT TIME ZONE 'Europe/Berlin')`;

    const result = await exec(sql`
      WITH cancellations AS (
        SELECT lead_id, COUNT(*)::int AS cancel_events
        FROM analytics.lead_status_changes
        WHERE pipeline_id = ${pipelineId}
          AND status_id = ${cancelledStatusId}
        GROUP BY lead_id
      ),
      deals AS (
        SELECT
          ${cohortBucketExpr} AS cohort_date,
          lc.lead_id,
          lc.created_at,
          ${dcCol} AS dc_termin,
          ${aaCol} AS aa_termin,
          COALESCE(c.cancel_events, 0) AS cancel_events
        FROM analytics.leads_cohort lc
        LEFT JOIN cancellations c ON c.lead_id = lc.lead_id
        WHERE lc.pipeline_id = ${pipelineId}
          AND lc.created_at >= ${fromDate}
          AND lc.created_at <= ${toDateEnd}
          AND (${dcCol} IS NOT NULL OR ${aaCol} IS NOT NULL)
          AND lc.status_id <> ${cancelledStatusId}
      )
      SELECT
        cohort_date::text AS cohort_date,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (dc_termin - created_at)) / 86400.0
        ) FILTER (
          WHERE dc_termin IS NOT NULL
            AND dc_termin >= created_at
            AND dc_termin <= (NOW() AT TIME ZONE 'UTC')
        )::numeric, 1) AS dc_avg_days,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (aa_termin - created_at)) / 86400.0
        ) FILTER (
          WHERE aa_termin IS NOT NULL
            AND aa_termin >= created_at
            AND aa_termin <= (NOW() AT TIME ZONE 'UTC')
        )::numeric, 1) AS aa_avg_days,
        COUNT(*) FILTER (
          WHERE dc_termin IS NOT NULL
            AND dc_termin >= created_at
            AND dc_termin <= (NOW() AT TIME ZONE 'UTC')
        )::int AS dc_cnt,
        COUNT(*) FILTER (
          WHERE aa_termin IS NOT NULL
            AND aa_termin >= created_at
            AND aa_termin <= (NOW() AT TIME ZONE 'UTC')
        )::int AS aa_cnt,
        COUNT(*)::int AS cnt,
        COUNT(*) FILTER (WHERE cancel_events > 0)::int AS rescheduled_cnt
      FROM deals
      GROUP BY cohort_date
      ORDER BY cohort_date ASC
    `);
    rows = result.rows;
  }

  const data: TerminRow[] = rows.map((r) => ({
    date: r.cohort_date,
    dcAvgDays: r.dc_avg_days == null ? null : Number(r.dc_avg_days),
    aaAvgDays: r.aa_avg_days == null ? null : Number(r.aa_avg_days),
    dcCount: Number(r.dc_cnt),
    aaCount: Number(r.aa_cnt),
    count: Number(r.cnt),
    rescheduledCount: Number(r.rescheduled_cnt),
  }));

  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "private, max-age=60",
    },
  });
}
