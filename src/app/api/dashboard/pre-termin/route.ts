// GET /api/dashboard/pre-termin
//
// Snapshot of leads currently sitting in BERATER stages BEFORE the actual
// termin completes — the "waiting list" for monthly planning. Counts and
// average time-in-status per status, grouped into three buckets:
//
//   pre_dc      — upstream of "Термин ДЦ состоялся" (Доведение, Консультации
//                 перед ДЦ, и т.д.). Leads here will eventually contribute
//                 to NEW DC termins.
//   post_dc     — between DC done and Гутшайн (Термин АА, Консультации перед
//                 АА). Will drive NEW AA termins.
//   limbo       — currently in a CANCELLED status (no committed new date).
//
// "Time in status" is approximated as NOW() - last status_change event_at
// for the lead (no history of CF dwell-time, but status entries are the
// natural lifecycle signal).

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { B2G_PIPELINES, BERATER_STATUSES } from "@/lib/kommo/pipeline-config";

interface PreTerminRow {
  bucket: "pre_dc" | "post_dc" | "limbo";
  statusId: number;
  statusName: string;
  count: number;
  avgDaysInStatus: number | null;
}

const STATUS_BUCKETS: Array<{
  bucket: PreTerminRow["bucket"];
  id: number;
  name: string;
}> = [
  { bucket: "pre_dc", id: BERATER_STATUSES.RECEIVED_FROM_FIRST, name: "Принято от первой линии" },
  { bucket: "pre_dc", id: BERATER_STATUSES.DOVEDENIE, name: "Доведение" },
  { bucket: "pre_dc", id: BERATER_STATUSES.IN_PROGRESS, name: "Взято в работу" },
  { bucket: "pre_dc", id: BERATER_STATUSES.NO_ANSWER, name: "Недозвон" },
  { bucket: "pre_dc", id: BERATER_STATUSES.CONTACT_MADE, name: "Контакт установлен" },
  { bucket: "pre_dc", id: BERATER_STATUSES.CONSULT_BEFORE_DC, name: "Консультация перед термином ДЦ" },
  { bucket: "pre_dc", id: BERATER_STATUSES.CONSULT_BEFORE_DC_DONE, name: "Консультация перед термином ДЦ проведена" },
  { bucket: "post_dc", id: BERATER_STATUSES.TERM_DC_DONE, name: "Термин ДЦ состоялся" },
  { bucket: "post_dc", id: BERATER_STATUSES.CONSULT_BEFORE_AA, name: "Консультация перед термином АА" },
  { bucket: "post_dc", id: BERATER_STATUSES.CONSULT_BEFORE_AA_DONE, name: "Консультация перед термином АА проведена" },
  { bucket: "post_dc", id: BERATER_STATUSES.TERM_AA, name: "Термин АА" },
  { bucket: "limbo", id: BERATER_STATUSES.TERM_DC_CANCELLED, name: "Термин ДЦ отменен/перенесен" },
  { bucket: "limbo", id: BERATER_STATUSES.TERM_AA_CANCELLED, name: "Термин АА отменен/перенесен" },
];

export async function GET() {
  const pipelineId = B2G_PIPELINES.BERATER;

  // Fetch counts + most-recent-event-per-lead in a single round-trip.
  const result = await (
    analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }
  ).execute<{
    status_id: string | number;
    cnt: string | number;
    avg_days: string | number | null;
  }>(sql`
    WITH last_event AS (
      SELECT lead_id, MAX(event_at) AS last_at
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${pipelineId}
      GROUP BY lead_id
    )
    SELECT
      lc.status_id::text AS status_id,
      COUNT(*)::int AS cnt,
      ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - le.last_at)) / 86400.0)
        FILTER (WHERE le.last_at IS NOT NULL)::numeric, 1) AS avg_days
    FROM analytics.leads_cohort lc
    LEFT JOIN last_event le ON le.lead_id = lc.lead_id
    WHERE lc.pipeline_id = ${pipelineId}
    GROUP BY lc.status_id
  `);

  const byStatus = new Map<number, { count: number; avgDays: number | null }>();
  for (const r of result.rows) {
    byStatus.set(Number(r.status_id), {
      count: Number(r.cnt),
      avgDays: r.avg_days == null ? null : Number(r.avg_days),
    });
  }

  const data: PreTerminRow[] = STATUS_BUCKETS.map((s) => {
    const hit = byStatus.get(s.id);
    return {
      bucket: s.bucket,
      statusId: s.id,
      statusName: s.name,
      count: hit?.count ?? 0,
      avgDaysInStatus: hit?.avgDays ?? null,
    };
  });

  return NextResponse.json(data, {
    headers: { "Cache-Control": "private, max-age=60" },
  });
}
