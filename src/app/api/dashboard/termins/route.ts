// GET /api/dashboard/termins?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&granularity=day|week
//
// Cohort-style aggregation for the Termin dashboard tab. For every cohort
// bucket (day or week, depending on `granularity`) that at least one Бух
// Бератер deal was created in, returns:
//   - dcAvgDays: average days from creation → assigned Termin ДЦ
//   - aaAvgDays: average days to Termin АА. Baseline is creation date,
//     UNLESS the deal passed through "Термин ДЦ состоялся" — then we measure
//     from the moment it entered that status (per ТЗ).
//   - count: number of deals contributing to either average
//
// granularity=week: GROUP BY DATE_TRUNC('week', created_at). Postgres weeks
// are Monday-aligned (ISO 8601), so the returned `date` is the Monday of
// each week — the UI labels it as "01–07 апр" client-side.
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

interface TerminRow {
  date: string;
  dcAvgDays: number | null;
  aaAvgDays: number | null;
  count: number;
}

function parseDate(input: string | null, fallback: Date): Date {
  if (!input) return fallback;
  // Strict YYYY-MM-DD — extra characters → fall back to default rather than
  // letting a malformed input drift into the SQL.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return fallback;
  const ms = Date.parse(`${input}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return fallback;
  return new Date(ms);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const defaultFrom = new Date(today);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 29);

  const fromDate = parseDate(url.searchParams.get("dateFrom"), defaultFrom);
  const toDate = parseDate(url.searchParams.get("dateTo"), today);

  if (fromDate.getTime() > toDate.getTime()) {
    return NextResponse.json(
      { error: "dateFrom must be on or before dateTo" },
      { status: 400 },
    );
  }

  // Whitelist — anything other than "week" falls back to per-day. Keeps the
  // SQL query 100% parameterised (no string interpolation into the query).
  const granularity =
    url.searchParams.get("granularity") === "week" ? "week" : "day";

  // Inclusive end-of-day for the upper bound — matches how the user picks a
  // calendar range ("through Apr 28" should include all of Apr 28).
  const toDateEnd = new Date(toDate);
  toDateEnd.setUTCHours(23, 59, 59, 999);

  const pipelineId = B2G_PIPELINES.BERATER;
  const dcDoneStatusId = BERATER_STATUSES.TERM_DC_DONE;

  // Granularity expression — pre-built SQL fragment so the main query stays
  // parameter-only. Postgres `DATE_TRUNC('week', x)` returns the Monday of
  // the ISO week at 00:00; ::date strips the time so the returned value
  // matches the per-day shape (just a YYYY-MM-DD string).
  const cohortBucketExpr =
    granularity === "week"
      ? sql`DATE_TRUNC('week', lc.created_at)::date`
      : sql`DATE(lc.created_at)`;

  const result = await (
    analyticsDb as {
      execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
    }
  ).execute<{
    cohort_date: string;
    dc_avg_days: string | number | null;
    aa_avg_days: string | number | null;
    cnt: string | number;
  }>(sql`
    WITH dc_done AS (
      SELECT lead_id, MIN(event_at) AS dc_done_at
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${pipelineId}
        AND status_id = ${dcDoneStatusId}
      GROUP BY lead_id
    ),
    deals AS (
      SELECT
        ${cohortBucketExpr} AS cohort_date,
        lc.lead_id,
        lc.created_at,
        lc.termin_date,
        lc.aa_termin_date,
        dd.dc_done_at
      FROM analytics.leads_cohort lc
      LEFT JOIN dc_done dd ON dd.lead_id = lc.lead_id
      WHERE lc.pipeline_id = ${pipelineId}
        AND lc.created_at >= ${fromDate}
        AND lc.created_at <= ${toDateEnd}
        AND (lc.termin_date IS NOT NULL OR lc.aa_termin_date IS NOT NULL)
    )
    SELECT
      cohort_date::text AS cohort_date,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (termin_date - created_at)) / 86400.0
      ) FILTER (
        WHERE termin_date IS NOT NULL
          AND termin_date >= created_at
      )::numeric, 1) AS dc_avg_days,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (
          aa_termin_date - COALESCE(dc_done_at, created_at)
        )) / 86400.0
      ) FILTER (
        WHERE aa_termin_date IS NOT NULL
          AND aa_termin_date >= COALESCE(dc_done_at, created_at)
      )::numeric, 1) AS aa_avg_days,
      COUNT(*)::int AS cnt
    FROM deals
    GROUP BY cohort_date
    ORDER BY cohort_date ASC
  `);

  const data: TerminRow[] = result.rows.map((r) => ({
    date: r.cohort_date,
    dcAvgDays: r.dc_avg_days == null ? null : Number(r.dc_avg_days),
    aaAvgDays: r.aa_avg_days == null ? null : Number(r.aa_avg_days),
    count: Number(r.cnt),
  }));

  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "private, max-age=60",
    },
  });
}
