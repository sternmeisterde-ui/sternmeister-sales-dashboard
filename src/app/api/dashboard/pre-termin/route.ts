// GET /api/dashboard/pre-termin
//
// Snapshot of leads currently sitting in BERATER stages BEFORE the actual
// termin completes — the "waiting list" for monthly planning. Counts and
// average time-in-status per status, grouped into two buckets:
//
//   pre_dc      — upstream of "Термин ДЦ состоялся" (Доведение, Консультации
//                 перед ДЦ, и т.д.). Includes "Термин ДЦ отменён/перенесён"
//                 since rescheduled-DC leads are still upstream of the next
//                 attempted DC visit.
//   post_dc     — between DC done and Гутшайн (Консультации перед АА, Термин
//                 АА). Includes "Термин АА отменён/перенесён" for the same
//                 reason — they're awaiting a re-attempt.
//
// Per ROP spec 2026-05-07 the "перенесён" statuses are now visually adjacent
// to their consultation pairs (they used to live in a separate "limbo"
// bucket at the end of the chart).
//
// "Time in status" is approximated as NOW() - last status_change event_at
// for the lead (no history of CF dwell-time, but status entries are the
// natural lifecycle signal).
//
// Order in STATUS_BUCKETS IS the display order — frontend preserves it
// instead of re-sorting, so changes here propagate directly to the chart.

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { B2G_PIPELINES, BERATER_STATUSES } from "@/lib/kommo/pipeline-config";

interface PreTerminRow {
  bucket: "pre_dc" | "post_dc";
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
  // Moved up next to its consultation pair (was in "limbo" bucket previously).
  { bucket: "pre_dc", id: BERATER_STATUSES.TERM_DC_CANCELLED, name: "Термин ДЦ отменен/перенесен" },
  { bucket: "pre_dc", id: BERATER_STATUSES.CONSULT_BEFORE_DC_DONE, name: "Консультация перед термином ДЦ проведена" },
  { bucket: "post_dc", id: BERATER_STATUSES.TERM_DC_DONE, name: "Термин ДЦ состоялся" },
  { bucket: "post_dc", id: BERATER_STATUSES.CONSULT_BEFORE_AA, name: "Консультация перед термином АА" },
  // Moved up next to its consultation pair (was in "limbo" bucket previously).
  { bucket: "post_dc", id: BERATER_STATUSES.TERM_AA_CANCELLED, name: "Термин АА отменен/перенесен" },
  { bucket: "post_dc", id: BERATER_STATUSES.CONSULT_BEFORE_AA_DONE, name: "Консультация перед термином АА проведена" },
  { bucket: "post_dc", id: BERATER_STATUSES.TERM_AA, name: "Термин АА" },
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
