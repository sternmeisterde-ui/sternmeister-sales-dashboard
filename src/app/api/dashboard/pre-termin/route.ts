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
import {
  BERATER_STATUSES,
  MED_BERATER_STATUSES,
  getBeraterPipelineIds,
  type Vertical,
} from "@/lib/kommo/pipeline-config";

/** Вертикаль b2g из query (buh/med/all). Иначе undefined = буховый (legacy). */
function parseTerminVertical(raw: string | null): Vertical | undefined {
  return raw === "buh" || raw === "med" || raw === "all" ? raw : undefined;
}

interface PreTerminRow {
  bucket: "pre_dc" | "post_dc";
  statusId: number;
  statusName: string;
  count: number;
  avgDaysInStatus: number | null;
}

// Стадии по имени с бух/мед status_id. Kommo-сверка 2026-07-05: воронки Бух и
// Мед Бератер структурно идентичны (из буховой удалили «Взято в работу»/
// «Недозвон»/«Контакт установлен»/«Термин АА»), поэтому у каждой стадии есть
// оба id. Порядок = порядок отображения. Order in list IS display order.
const STAGE_DEFS: Array<{
  bucket: PreTerminRow["bucket"];
  name: string;
  buh: number;
  med: number | null;
}> = [
  { bucket: "pre_dc", name: "Принято от первой линии", buh: BERATER_STATUSES.RECEIVED_FROM_FIRST, med: MED_BERATER_STATUSES.RECEIVED_FROM_FIRST },
  { bucket: "pre_dc", name: "Доведение", buh: BERATER_STATUSES.DOVEDENIE, med: MED_BERATER_STATUSES.DOVEDENIE },
  { bucket: "pre_dc", name: "Консультация перед термином ДЦ", buh: BERATER_STATUSES.CONSULT_BEFORE_DC, med: MED_BERATER_STATUSES.CONSULT_BEFORE_DC },
  { bucket: "pre_dc", name: "Термин ДЦ отменен/перенесен", buh: BERATER_STATUSES.TERM_DC_CANCELLED, med: MED_BERATER_STATUSES.TERM_DC_CANCELLED },
  { bucket: "pre_dc", name: "Консультация перед термином ДЦ проведена", buh: BERATER_STATUSES.CONSULT_BEFORE_DC_DONE, med: MED_BERATER_STATUSES.CONSULT_BEFORE_DC_DONE },
  { bucket: "post_dc", name: "Термин ДЦ состоялся", buh: BERATER_STATUSES.TERM_DC_DONE, med: MED_BERATER_STATUSES.TERM_DC_DONE },
  { bucket: "post_dc", name: "Консультация перед термином АА", buh: BERATER_STATUSES.CONSULT_BEFORE_AA, med: MED_BERATER_STATUSES.CONSULT_BEFORE_AA },
  { bucket: "post_dc", name: "Термин АА отменен/перенесен", buh: BERATER_STATUSES.TERM_AA_CANCELLED, med: MED_BERATER_STATUSES.TERM_AA_CANCELLED },
  { bucket: "post_dc", name: "Консультация перед термином АА проведена", buh: BERATER_STATUSES.CONSULT_BEFORE_AA_DONE, med: MED_BERATER_STATUSES.CONSULT_BEFORE_AA_DONE },
];

export async function GET(request: Request) {
  const vertical = parseTerminVertical(new URL(request.url).searchParams.get("vertical"));
  const pipelineList = sql.join(
    getBeraterPipelineIds(vertical).map((id) => sql`${id}`),
    sql`, `,
  );

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
      WHERE pipeline_id IN (${pipelineList})
      GROUP BY lead_id
    )
    SELECT
      lc.status_id::text AS status_id,
      COUNT(*)::int AS cnt,
      ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - le.last_at)) / 86400.0)
        FILTER (WHERE le.last_at IS NOT NULL)::numeric, 1) AS avg_days
    FROM analytics.leads_cohort lc
    LEFT JOIN last_event le ON le.lead_id = lc.lead_id
    WHERE lc.pipeline_id IN (${pipelineList})
    GROUP BY lc.status_id
  `);

  const byStatus = new Map<number, { count: number; avgDays: number | null }>();
  for (const r of result.rows) {
    byStatus.set(Number(r.status_id), {
      count: Number(r.cnt),
      avgDays: r.avg_days == null ? null : Number(r.avg_days),
    });
  }

  // id(ы) стадии для выбранной вертикали (buh → [buh], med → [med?], all → оба).
  const stageIds = (s: (typeof STAGE_DEFS)[number]): number[] => {
    if (vertical === "med") return s.med != null ? [s.med] : [];
    if (vertical === "all") return s.med != null ? [s.buh, s.med] : [s.buh];
    return [s.buh]; // buh / undefined
  };

  const data: PreTerminRow[] = STAGE_DEFS
    // Стадии без мед-эквивалента скрываем в режиме Мед.
    .filter((s) => stageIds(s).length > 0)
    .map((s) => {
      const ids = stageIds(s);
      let count = 0;
      let daysWeighted = 0;
      let daysCount = 0;
      for (const id of ids) {
        const hit = byStatus.get(id);
        if (!hit) continue;
        count += hit.count;
        if (hit.avgDays != null) {
          daysWeighted += hit.avgDays * hit.count;
          daysCount += hit.count;
        }
      }
      return {
        bucket: s.bucket,
        statusId: ids[0], // репрезентативный id (для ключа на фронте)
        statusName: s.name,
        count,
        avgDaysInStatus: daysCount > 0 ? Math.round((daysWeighted / daysCount) * 10) / 10 : null,
      };
    });

  return NextResponse.json(data, {
    headers: { "Cache-Control": "private, max-age=60" },
  });
}
