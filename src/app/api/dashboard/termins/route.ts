// GET /api/dashboard/termins?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&granularity=day|week&bucketBy=created_at|termin_date&useFirst=1|0
//
// Cohort-style aggregation for the Termin dashboard tab. For every cohort
// bucket (day or week, depending on `granularity`) returns:
//   - dcAvgDays: average days from creation → assigned Termin ДЦ
//   - aaAvgDays: average days to Termin АА. Baseline depends on `bucketBy`:
//       * bucketBy=created_at (chart 1): baseline is creation date, UNLESS
//         the deal passed through "Термин ДЦ состоялся" — then from that
//         status (DC visit → AA appointment lead time).
//       * bucketBy=termin_date  (chart 2): baseline is always creation date
//         (creation → AA appointment, regardless of DC visit).
//   - combinedAvgDays: per-lead time-to-termin in days, then averaged.
//       per-lead = mean(dcDays, aaDays) when both set; single one if only
//       one set; null otherwise. Both legs measured from creation_at.
//       Used for chart 2 which displays a single combined line.
//   - bothCount: leads in the bucket that have BOTH a DC and an AA termin.
//   - count: number of deals contributing to either average
//
// `bucketBy` controls both the cohort axis AND the date-window filter:
//   - "created_at" (default): bucket and filter by deal creation date.
//   - "termin_date": bucket and filter by the deal's primary termin (DC if
//     present, else AA).
//
// `useFirst` controls which termin date is used in metrics and the
// `bucketBy=termin_date` axis:
//   - 1 (default): the FIRST observed termin date (`termin_date_first` /
//     `aa_termin_date_first`). Captures the original commitment, so the
//     "avg days to termin" metric reflects how long it took to schedule
//     the *first* termin — not whatever is currently scheduled after
//     N reschedules. This matches B1=A from the planning spec.
//   - 0: current `termin_date` / `aa_termin_date`, mirrors what's in Kommo
//     right now (post-reschedules).
//
// granularity=week: GROUP BY DATE_TRUNC('week', <bucket source>). Postgres
// weeks are Monday-aligned (ISO 8601), so the returned `date` is the Monday
// of each week — the UI labels it as "01–07 апр" client-side.
//
// Excluded:
//   - deals without any termin date set
//   - deals whose computed value is negative (data-quality guard — Kommo
//     occasionally has past-dated termins from manual edits)
//
// Source tables:
//   analytics.leads_cohort        — termin_date, aa_termin_date, created_at
//   analytics.lead_status_changes — earliest event_at where status_id =
//                                   BERATER_STATUSES.TERM_DC_DONE per lead

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
  combinedAvgDays: number | null;
  count: number;
  bothCount: number;
  rescheduledCount: number;
}

/** Parse a YYYY-MM-DD as a Berlin-local civil date, then resolve to the UTC
 *  instant for `kind` ("start" = 00:00 Berlin, "end" = 23:59:59.999 Berlin).
 *  Returns null when the string is missing or malformed — caller substitutes
 *  the default. Berlin-local rather than UTC because every other dashboard
 *  surface treats dates as Berlin civil dates (matches calendar pickers). */
function parseBerlinDate(input: string | null, kind: "start" | "end"): Date | null {
  if (!input) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  return parseDateBoundary(input, kind);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  // Defaults are Berlin-local: "today" in Berlin and "29 days back" in Berlin
  // civil days. Picking 30 calendar days is a UI choice; using UTC math here
  // would shift the window by ±1–2h and slip leads into the wrong cohort row.
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

  // Whitelist — anything other than "week" falls back to per-day. Keeps the
  // SQL query 100% parameterised (no string interpolation into the query).
  const granularity =
    url.searchParams.get("granularity") === "week" ? "week" : "day";

  // Whitelist — anything other than "termin_date" falls back to creation-cohort.
  const bucketBy =
    url.searchParams.get("bucketBy") === "termin_date" ? "termin_date" : "created_at";

  // useFirst defaults to 1 (first observed termin date). Pass 0 to use the
  // current rescheduled value.
  const useFirst = url.searchParams.get("useFirst") !== "0";

  // BERATER-only by design (confirmed 2026-05-03). FIRST_LINE has status_id=142
  // ("Термин ДЦ" / closed-won) leads with termin_date populated, but those are
  // "got termin straight away" — outside the planning workflow this dashboard
  // tracks. Do NOT add FIRST_LINE here without an explicit ask.
  const pipelineId = B2G_PIPELINES.BERATER;
  const dcDoneStatusId = BERATER_STATUSES.TERM_DC_DONE;
  const cancelledStatusId = BERATER_STATUSES.TERM_DC_CANCELLED;

  // Termin column references — chosen by useFirst once and reused everywhere
  // so the metric, bucket, and filter all refer to the same value.
  const dcCol = useFirst ? sql`lc.termin_date_first` : sql`lc.termin_date`;
  const aaCol = useFirst ? sql`lc.aa_termin_date_first` : sql`lc.aa_termin_date`;

  // AA baseline differs by chart per spec:
  //   chart 1 (created cohort): COALESCE(dc_done, created)  — DC→AA lead time
  //   chart 2 (termin cohort) : created                     — full creation→AA
  const aaBaseline =
    bucketBy === "termin_date"
      ? sql`created_at`
      : sql`COALESCE(dc_done_at, created_at)`;

  // Bucket source: created_at OR the deal's primary termin (DC if set, else AA).
  // The same expression drives both the GROUP BY axis and the date-window filter,
  // so the cohort always matches what the user sees on the X axis.
  const bucketSource =
    bucketBy === "termin_date"
      ? sql`COALESCE(${dcCol}, ${aaCol})`
      : sql`lc.created_at`;

  // Bucket in Europe/Berlin. PG stores `created_at` / `termin_date` as
  // `timestamp without time zone` carrying UTC (per ETL convention). Without
  // `AT TIME ZONE 'Europe/Berlin'`, weeks bucket on UTC-Monday and a Sunday-
  // night Berlin lead lands in the wrong week.
  const berlinSource = sql`(${bucketSource}) AT TIME ZONE 'Europe/Berlin'`;
  const cohortBucketExpr =
    granularity === "week"
      ? sql`DATE_TRUNC('week', ${berlinSource})::date`
      : sql`DATE(${berlinSource})`;

  const result = await (
    analyticsDb as {
      execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
    }
  ).execute<{
    cohort_date: string;
    dc_avg_days: string | number | null;
    aa_avg_days: string | number | null;
    combined_avg_days: string | number | null;
    cnt: string | number;
    both_cnt: string | number;
    rescheduled_cnt: string | number;
  }>(sql`
    WITH dc_done AS (
      SELECT lead_id, MIN(event_at) AS dc_done_at
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${pipelineId}
        AND status_id = ${dcDoneStatusId}
      GROUP BY lead_id
    ),
    -- B2: count of TERM_DC_CANCELLED events per lead (each event = one
    -- reschedule attempt — the lead either bounced into a new termin or
    -- got dropped via B3 below).
    cancellations AS (
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
        dd.dc_done_at,
        COALESCE(c.cancel_events, 0) AS cancel_events,
        -- B3: lead is "cancelled-not-rescheduled" if its CURRENT status is
        -- still TERM_DC_CANCELLED. Once a manager picks a new date, the
        -- status moves out of cancelled (back to consultation prep, etc.),
        -- so a sticky CANCELLED status means no new termin was set.
        (lc.status_id = ${cancelledStatusId}) AS dropped_no_reschedule
      FROM analytics.leads_cohort lc
      LEFT JOIN dc_done dd       ON dd.lead_id = lc.lead_id
      LEFT JOIN cancellations c  ON c.lead_id  = lc.lead_id
      WHERE lc.pipeline_id = ${pipelineId}
        AND ${bucketSource} >= ${fromDate}
        AND ${bucketSource} <= ${toDateEnd}
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
      )::numeric, 1) AS dc_avg_days,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (
          aa_termin - ${aaBaseline}
        )) / 86400.0
      ) FILTER (
        WHERE aa_termin IS NOT NULL
          AND aa_termin >= ${aaBaseline}
      )::numeric, 1) AS aa_avg_days,
      -- Combined per-lead time-to-termin in days, then averaged across the
      -- bucket. Per spec for chart 2: when a lead has both DC and AA, the
      -- lead's metric is the mean of (DC − created) and (AA − created); when
      -- only one is set, that one's distance from creation. Past-dated
      -- termins (termin < created, manual edits in Kommo) are skipped at the
      -- per-leg level — a lead with one valid leg still contributes that leg.
      ROUND(AVG(
        CASE
          WHEN dc_termin IS NOT NULL AND aa_termin IS NOT NULL
            AND dc_termin >= created_at AND aa_termin >= created_at
          THEN (
            EXTRACT(EPOCH FROM (dc_termin - created_at))
            + EXTRACT(EPOCH FROM (aa_termin - created_at))
          ) / 86400.0 / 2
          WHEN dc_termin IS NOT NULL AND dc_termin >= created_at
          THEN EXTRACT(EPOCH FROM (dc_termin - created_at)) / 86400.0
          WHEN aa_termin IS NOT NULL AND aa_termin >= created_at
          THEN EXTRACT(EPOCH FROM (aa_termin - created_at)) / 86400.0
        END
      )::numeric, 1) AS combined_avg_days,
      COUNT(*)::int AS cnt,
      COUNT(*) FILTER (
        WHERE dc_termin IS NOT NULL AND aa_termin IS NOT NULL
      )::int AS both_cnt,
      COUNT(*) FILTER (WHERE cancel_events > 0)::int AS rescheduled_cnt
    FROM deals
    GROUP BY cohort_date
    ORDER BY cohort_date ASC
  `);

  const data: TerminRow[] = result.rows.map((r) => ({
    date: r.cohort_date,
    dcAvgDays: r.dc_avg_days == null ? null : Number(r.dc_avg_days),
    aaAvgDays: r.aa_avg_days == null ? null : Number(r.aa_avg_days),
    combinedAvgDays:
      r.combined_avg_days == null ? null : Number(r.combined_avg_days),
    count: Number(r.cnt),
    bothCount: Number(r.both_cnt),
    rescheduledCount: Number(r.rescheduled_cnt),
  }));

  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "private, max-age=60",
    },
  });
}
