// GET /api/dashboard/termins/leads
//   Bucket mode (line drill):
//     ?date=YYYY-MM-DD&leg=dc|aa
//   Period mode (tile drill):
//     ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&mode=cohort|leg|rescheduled[&leg=dc|aa]
//   Common params:
//     &bucketBy=created_at|termin_date  &granularity=day|week  &useFirst=1|0
//     &statusIds=id,id,...    (optional BERATER status allow-list — see parent)
//
// Drill-down for the cohort-metric line charts (chart 1 by created_at,
// chart 2 by termin_date). Returns the lead-level rows that contribute to
// either a single (date, leg) point or a whole-period summary tile.
//
// statusIds (added 2026-05-14): mirrors parent endpoint exactly. Omitted →
// legacy `<> TERM_DC_CANCELLED` default; empty → empty result; non-empty →
// `lc.status_id IN (...)`. Drill must use the same filter as the chart so the
// rows shown actually sum back to the displayed metric.
//
// Modes (period only):
//   cohort       → all leads in the cohort (chart 1: created in window with
//                  any termin; chart 2: dc OR aa termin in window). Dedup by
//                  lead_id — chart's "Сделок в когорте" tile.
//   leg          → leg=dc or aa across whole period. "Ср. до Термин ДЦ/АА"
//                  tile. Same per-leg rules as bucket mode.
//   rescheduled  → leads in cohort with at least one TERM_DC_CANCELLED event.
//                  "Перенесено" tile.
//
// Mirrors src/app/api/dashboard/termins/route.ts filter rules exactly.

import { NextRequest, NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { B2G_PIPELINES, BERATER_STATUSES } from "@/lib/kommo/pipeline-config";
import { formatDaysDuration } from "@/lib/utils/duration";

const HARD_CAP = 500;

interface RawRow {
  lead_id: string | number;
  status_name: string | null;
  pipeline_name: string | null;
  manager: string | null;
  created_at_iso: string | null;
  dc_termin_iso: string | null;
  aa_termin_iso: string | null;
  duration_days: string | number | null;
  cancel_events: string | number | null;
  total_count: string | number;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date");
  const dateFromParam = url.searchParams.get("dateFrom");
  const dateToParam = url.searchParams.get("dateTo");
  const legParam = url.searchParams.get("leg");
  const bucketBy =
    url.searchParams.get("bucketBy") === "termin_date"
      ? "termin_date"
      : "created_at";
  const granularity =
    url.searchParams.get("granularity") === "week" ? "week" : "day";
  const useFirst = url.searchParams.get("useFirst") !== "0";
  const modeParam = url.searchParams.get("mode");

  const isBucket = !!dateParam;
  const isPeriod = !dateParam && !!dateFromParam && !!dateToParam;
  if (!isBucket && !isPeriod) {
    return NextResponse.json(
      { error: "must provide either 'date' (bucket) or 'dateFrom'+'dateTo' (period)" },
      { status: 400 },
    );
  }
  for (const v of [dateParam, dateFromParam, dateToParam]) {
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return NextResponse.json(
        { error: "date params must be YYYY-MM-DD" },
        { status: 400 },
      );
    }
  }
  const mode = isBucket
    ? "leg"
    : modeParam === "cohort" || modeParam === "rescheduled"
      ? modeParam
      : "leg";
  const leg = legParam === "dc" || legParam === "aa" ? legParam : null;
  if (mode === "leg" && !leg) {
    return NextResponse.json(
      { error: "leg='dc' or 'aa' required for bucket/leg-mode drill" },
      { status: 400 },
    );
  }

  // Status allow-list — same semantics as parent endpoint. See termins/route.ts
  // header for full spec. Drill MUST mirror the chart's cohort filter or rows
  // shown won't reconcile with the displayed average.
  const statusIdsRaw = url.searchParams.get("statusIds");
  let statusIds: number[] | null = null;
  if (statusIdsRaw !== null) {
    statusIds = statusIdsRaw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0);
  }
  if (statusIds !== null && statusIds.length === 0) {
    return NextResponse.json(
      { leads: [], totalCount: 0, truncated: false },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const pipelineId = B2G_PIPELINES.BERATER;
  const cancelledStatusId = BERATER_STATUSES.TERM_DC_CANCELLED;
  const dcCol = useFirst ? sql`lc.termin_date_first` : sql`lc.termin_date`;
  const aaCol = useFirst ? sql`lc.aa_termin_date_first` : sql`lc.aa_termin_date`;

  const statusFilter: SQL =
    statusIds && statusIds.length > 0
      ? sql`lc.status_id IN (${sql.join(
          statusIds.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql`lc.status_id <> ${cancelledStatusId}`;

  // Range expressions for created_at vs termin_date cohorts.
  const createdRange: SQL = isBucket
    ? granularity === "week"
      ? sql`DATE_TRUNC('week', (lc.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date = ${dateParam}::date`
      : sql`DATE((lc.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') = ${dateParam}::date`
    : sql`DATE((lc.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') BETWEEN ${dateFromParam}::date AND ${dateToParam}::date`;

  const dcSlotRange: SQL = isBucket
    ? granularity === "week"
      ? sql`DATE_TRUNC('week', (${dcCol} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date = ${dateParam}::date`
      : sql`DATE((${dcCol} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') = ${dateParam}::date`
    : sql`DATE((${dcCol} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') BETWEEN ${dateFromParam}::date AND ${dateToParam}::date`;

  const aaSlotRange: SQL = isBucket
    ? granularity === "week"
      ? sql`DATE_TRUNC('week', (${aaCol} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date = ${dateParam}::date`
      : sql`DATE((${aaCol} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') = ${dateParam}::date`
    : sql`DATE((${aaCol} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') BETWEEN ${dateFromParam}::date AND ${dateToParam}::date`;

  // Common SELECT shape with cancellations join. cancel_events used for
  // "rescheduled" mode + label hint.
  const cancellationsCte = sql`
    cancellations AS (
      SELECT lead_id, COUNT(*)::int AS cancel_events
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${pipelineId}
        AND status_id = ${cancelledStatusId}
      GROUP BY lead_id
    )
  `;

  let query: SQL;

  if (mode === "leg") {
    const slotCol = leg === "dc" ? dcCol : aaCol;

    if (bucketBy === "created_at") {
      // Chart 1 cohort + future-termin guard. AA baseline = created_at.
      query = sql`
        WITH ${cancellationsCte}
        SELECT
          lc.lead_id,
          lc.status AS status_name,
          lc.pipeline AS pipeline_name,
          lc.manager,
          (lc.created_at AT TIME ZONE 'UTC')::timestamptz AS created_at_iso,
          (${dcCol} AT TIME ZONE 'UTC')::timestamptz AS dc_termin_iso,
          (${aaCol} AT TIME ZONE 'UTC')::timestamptz AS aa_termin_iso,
          ROUND((EXTRACT(EPOCH FROM (${slotCol} - lc.created_at)) / 86400.0)::numeric, 1)
            AS duration_days,
          COALESCE(c.cancel_events, 0) AS cancel_events,
          COUNT(*) OVER ()::bigint AS total_count
        FROM analytics.leads_cohort lc
        LEFT JOIN cancellations c ON c.lead_id = lc.lead_id
        WHERE lc.pipeline_id = ${pipelineId}
          AND ${statusFilter}
          AND ${createdRange}
          AND ${slotCol} IS NOT NULL
          AND ${slotCol} >= lc.created_at
          AND ${slotCol} <= (NOW() AT TIME ZONE 'UTC')
        ORDER BY duration_days DESC NULLS LAST, lc.created_at ASC
        LIMIT ${HARD_CAP}
      `;
    } else if (leg === "dc") {
      query = sql`
        WITH ${cancellationsCte}
        SELECT
          lc.lead_id,
          lc.status AS status_name,
          lc.pipeline AS pipeline_name,
          lc.manager,
          (lc.created_at AT TIME ZONE 'UTC')::timestamptz AS created_at_iso,
          (${dcCol} AT TIME ZONE 'UTC')::timestamptz AS dc_termin_iso,
          (${aaCol} AT TIME ZONE 'UTC')::timestamptz AS aa_termin_iso,
          ROUND((EXTRACT(EPOCH FROM (${dcCol} - lc.created_at)) / 86400.0)::numeric, 1)
            AS duration_days,
          COALESCE(c.cancel_events, 0) AS cancel_events,
          COUNT(*) OVER ()::bigint AS total_count
        FROM analytics.leads_cohort lc
        LEFT JOIN cancellations c ON c.lead_id = lc.lead_id
        WHERE lc.pipeline_id = ${pipelineId}
          AND ${statusFilter}
          AND ${dcCol} IS NOT NULL
          AND ${dcCol} >= lc.created_at
          AND ${dcSlotRange}
        ORDER BY duration_days DESC NULLS LAST, ${dcCol} ASC
        LIMIT ${HARD_CAP}
      `;
    } else {
      query = sql`
        WITH ${cancellationsCte}
        SELECT
          lc.lead_id,
          lc.status AS status_name,
          lc.pipeline AS pipeline_name,
          lc.manager,
          (lc.created_at AT TIME ZONE 'UTC')::timestamptz AS created_at_iso,
          (${dcCol} AT TIME ZONE 'UTC')::timestamptz AS dc_termin_iso,
          (${aaCol} AT TIME ZONE 'UTC')::timestamptz AS aa_termin_iso,
          ROUND((EXTRACT(EPOCH FROM (${aaCol} - COALESCE(${dcCol}, lc.created_at))) / 86400.0)::numeric, 1)
            AS duration_days,
          COALESCE(c.cancel_events, 0) AS cancel_events,
          COUNT(*) OVER ()::bigint AS total_count
        FROM analytics.leads_cohort lc
        LEFT JOIN cancellations c ON c.lead_id = lc.lead_id
        WHERE lc.pipeline_id = ${pipelineId}
          AND ${statusFilter}
          AND ${aaCol} IS NOT NULL
          AND ${aaCol} >= COALESCE(${dcCol}, lc.created_at)
          AND ${aaSlotRange}
        ORDER BY duration_days DESC NULLS LAST, ${aaCol} ASC
        LIMIT ${HARD_CAP}
      `;
    }
  } else {
    // mode = cohort | rescheduled. Both period-only.
    // Cohort definition mirrors parent endpoint:
    //   chart 1 (created_at): created in window AND has at least one termin.
    //   chart 2 (termin_date): dc_termin in window OR aa_termin in window.
    const cohortMatch: SQL =
      bucketBy === "created_at"
        ? sql`(${createdRange}) AND (${dcCol} IS NOT NULL OR ${aaCol} IS NOT NULL)`
        : sql`(
            (${dcCol} IS NOT NULL AND ${dcSlotRange})
            OR
            (${aaCol} IS NOT NULL AND ${aaSlotRange})
          )`;

    const reschedFilter =
      mode === "rescheduled" ? sql`AND COALESCE(c.cancel_events, 0) > 0` : sql``;

    query = sql`
      WITH ${cancellationsCte}
      SELECT
        lc.lead_id,
        lc.status AS status_name,
        lc.pipeline AS pipeline_name,
        lc.manager,
        (lc.created_at AT TIME ZONE 'UTC')::timestamptz AS created_at_iso,
        (${dcCol} AT TIME ZONE 'UTC')::timestamptz AS dc_termin_iso,
        (${aaCol} AT TIME ZONE 'UTC')::timestamptz AS aa_termin_iso,
        NULL::numeric AS duration_days,
        COALESCE(c.cancel_events, 0) AS cancel_events,
        COUNT(*) OVER ()::bigint AS total_count
      FROM analytics.leads_cohort lc
      LEFT JOIN cancellations c ON c.lead_id = lc.lead_id
      WHERE lc.pipeline_id = ${pipelineId}
        AND ${statusFilter}
        AND (${cohortMatch})
        ${reschedFilter}
      ORDER BY c.cancel_events DESC NULLS LAST, lc.created_at DESC
      LIMIT ${HARD_CAP}
    `;
  }

  const result = await (
    analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }
  ).execute<RawRow>(query);

  const totalCount =
    result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
  const truncated = totalCount > result.rows.length;

  const leads = result.rows.map((r) => {
    const days = r.duration_days == null ? null : Number(r.duration_days);
    const cancels = Number(r.cancel_events ?? 0);
    let label: string;
    if (mode === "rescheduled") {
      label = cancels === 1 ? "1 перенос" : `${cancels} переносов`;
    } else if (mode === "cohort") {
      label = cancels > 0 ? `${cancels} переносов · в когорте` : "В когорте";
    } else {
      const tag = leg === "dc" ? "ДЦ" : "АА";
      label =
        days == null
          ? `${tag}: длительность не определена`
          : `${tag}: ${formatDaysDuration(days)}`;
    }
    return {
      leadId: Number(r.lead_id),
      statusName: r.status_name,
      pipelineName: r.pipeline_name,
      responsible: r.manager,
      contributionLabel: label,
      contributionValue: mode === "leg" ? days : cancels,
      createdAt: r.created_at_iso,
      dcTermin: r.dc_termin_iso,
      aaTermin: r.aa_termin_iso,
    };
  });

  return NextResponse.json(
    { leads, totalCount, truncated },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
