// GET /api/dashboard/pre-termin/leads?statusId=<id>
//
// Drill-down for the pre-termin distribution chart. Returns leads currently
// sitting in the requested BERATER status (a snapshot of the "waiting list"),
// sorted by time-in-status DESC so the longest-stuck leads appear first —
// those are the ones the ROP wants to see (outliers).
//
// Mirrors src/app/api/dashboard/pre-termin/route.ts:
//   - pipeline_id = BERATER
//   - status_id = <id>
//   - "time in status" = NOW() - last status_change event_at on this lead
//
// statusId must be one of the BERATER status IDs allow-listed below
// (matches STATUS_BUCKETS in the parent endpoint). Unknown IDs → 400.

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { B2G_PIPELINES, BERATER_STATUSES } from "@/lib/kommo/pipeline-config";
import { formatDaysDuration } from "@/lib/utils/duration";

const HARD_CAP = 500;

// Allow-list, mirrors the parent route's STATUS_BUCKETS exactly. Other status
// IDs would round-trip to PG without filtering protection — block them at the
// edge instead.
const ALLOWED_STATUSES = new Set<number>([
  BERATER_STATUSES.RECEIVED_FROM_FIRST,
  BERATER_STATUSES.DOVEDENIE,
  BERATER_STATUSES.IN_PROGRESS,
  BERATER_STATUSES.NO_ANSWER,
  BERATER_STATUSES.CONTACT_MADE,
  BERATER_STATUSES.CONSULT_BEFORE_DC,
  BERATER_STATUSES.TERM_DC_CANCELLED,
  BERATER_STATUSES.CONSULT_BEFORE_DC_DONE,
  BERATER_STATUSES.TERM_DC_DONE,
  BERATER_STATUSES.CONSULT_BEFORE_AA,
  BERATER_STATUSES.TERM_AA_CANCELLED,
  BERATER_STATUSES.CONSULT_BEFORE_AA_DONE,
  BERATER_STATUSES.TERM_AA,
]);

interface RawRow {
  lead_id: string | number;
  status_name: string | null;
  pipeline_name: string | null;
  manager: string | null;
  created_at_iso: string | null;
  termin_date_iso: string | null;
  aa_termin_date_iso: string | null;
  days_in_status: string | number | null;
  total_count: string | number;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const statusIdParam = url.searchParams.get("statusId");
  const statusId = Number(statusIdParam);

  if (!Number.isFinite(statusId) || !ALLOWED_STATUSES.has(statusId)) {
    return NextResponse.json(
      { error: "statusId param missing or not allow-listed" },
      { status: 400 },
    );
  }

  const pipelineId = B2G_PIPELINES.BERATER;

  const result = await (
    analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }
  ).execute<RawRow>(sql`
    WITH last_event AS (
      SELECT lead_id, MAX(event_at) AS last_at
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${pipelineId}
      GROUP BY lead_id
    )
    SELECT
      lc.lead_id,
      lc.status AS status_name,
      lc.pipeline AS pipeline_name,
      lc.manager,
      (lc.created_at AT TIME ZONE 'UTC')::timestamptz AS created_at_iso,
      (lc.termin_date AT TIME ZONE 'UTC')::timestamptz AS termin_date_iso,
      (lc.aa_termin_date AT TIME ZONE 'UTC')::timestamptz AS aa_termin_date_iso,
      ROUND((EXTRACT(EPOCH FROM (NOW() - le.last_at)) / 86400.0)::numeric, 1)
        AS days_in_status,
      COUNT(*) OVER ()::bigint AS total_count
    FROM analytics.leads_cohort lc
    LEFT JOIN last_event le ON le.lead_id = lc.lead_id
    WHERE lc.pipeline_id = ${pipelineId}
      AND lc.status_id = ${statusId}
    ORDER BY le.last_at ASC NULLS FIRST
    LIMIT ${HARD_CAP}
  `);

  const totalCount =
    result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
  const truncated = totalCount > result.rows.length;

  const leads = result.rows.map((r) => {
    const days = r.days_in_status == null ? null : Number(r.days_in_status);
    const label =
      days == null ? "В статусе: ?" : `В статусе ${formatDaysDuration(days)}`;
    return {
      leadId: Number(r.lead_id),
      statusName: r.status_name,
      pipelineName: r.pipeline_name,
      responsible: r.manager,
      contributionLabel: label,
      contributionValue: days,
      createdAt: r.created_at_iso,
      dcTermin: r.termin_date_iso,
      aaTermin: r.aa_termin_date_iso,
    };
  });

  return NextResponse.json(
    { leads, totalCount, truncated },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
