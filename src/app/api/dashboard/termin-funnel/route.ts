// GET /api/dashboard/termin-funnel?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
//
// Three-stage funnel waterfall for the BERATER pipeline. For each transition,
// returns:
//   - count:    leads whose first `to_status` event landed in the window
//   - avgDays:  mean days from first `from_status` event to first `to_status`
//               event, over those leads
//
// Stages (chosen 2026-05-03 by user):
//   1. Термин ДЦ состоялся (93886075)  → Термин АА (93860879)
//   2. Термин АА (93860879)            → На рассмотрении (93860887)
//   3. На рассмотрении (93860887)      → Гутшайн одобрен (142, BERATER pipe)
//
// "First-event" semantics for both endpoints chosen because (a) leads can
// re-enter a status after a reschedule and we want to measure the meaningful
// transition once, (b) re-entry events would otherwise inflate the count
// while leaving avgDays roughly the same.
//
// status_id 142 is WON in BOTH FIRST_LINE and BERATER — must filter by
// pipeline_id = BERATER or we'd pick up FIRST_LINE-won "Термин ДЦ" events.

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { B2G_PIPELINES, BERATER_STATUSES } from "@/lib/kommo/pipeline-config";
import { addDaysCivil, parseDateBoundary, todayCivil } from "@/lib/utils/date";

interface FunnelStage {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  count: number;
  avgDays: number | null;
}

const STAGES: Array<{
  from: string;
  fromId: number;
  fromName: string;
  to: string;
  toId: number;
  toName: string;
}> = [
  {
    from: "term_dc_done",
    fromId: BERATER_STATUSES.TERM_DC_DONE,
    fromName: "Термин ДЦ состоялся",
    to: "term_aa",
    toId: BERATER_STATUSES.TERM_AA,
    toName: "Термин АА",
  },
  {
    from: "term_aa",
    fromId: BERATER_STATUSES.TERM_AA,
    fromName: "Термин АА",
    to: "berater_review",
    toId: BERATER_STATUSES.BERATER_REVIEW,
    toName: "На рассмотрении",
  },
  {
    from: "berater_review",
    fromId: BERATER_STATUSES.BERATER_REVIEW,
    fromName: "На рассмотрении",
    to: "won",
    toId: BERATER_STATUSES.WON,
    toName: "Гутшайн одобрен",
  },
];

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

  const pipelineId = B2G_PIPELINES.BERATER;

  // One query per stage so each filter clause stays simple. With three
  // stages the round-trip cost is negligible (and Neon HTTP doesn't share
  // a transaction across statements anyway).
  const stages: FunnelStage[] = await Promise.all(
    STAGES.map(async (s) => {
      const result = await (
        analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }
      ).execute<{ cnt: string | number; avg_days: string | number | null }>(sql`
        WITH from_evt AS (
          SELECT lead_id, MIN(event_at) AS at
          FROM analytics.lead_status_changes
          WHERE pipeline_id = ${pipelineId} AND status_id = ${s.fromId}
          GROUP BY lead_id
        ),
        to_evt AS (
          SELECT lead_id, MIN(event_at) AS at
          FROM analytics.lead_status_changes
          WHERE pipeline_id = ${pipelineId} AND status_id = ${s.toId}
          GROUP BY lead_id
        )
        SELECT
          COUNT(*)::int AS cnt,
          ROUND(AVG(EXTRACT(EPOCH FROM (t.at - f.at)) / 86400.0)
            FILTER (WHERE f.at IS NOT NULL AND f.at <= t.at)::numeric, 1) AS avg_days
        FROM to_evt t
        LEFT JOIN from_evt f ON f.lead_id = t.lead_id
        WHERE t.at >= ${fromDate} AND t.at <= ${toDateEnd}
      `);
      const row = result.rows[0];
      return {
        from: s.from,
        fromName: s.fromName,
        to: s.to,
        toName: s.toName,
        count: Number(row?.cnt ?? 0),
        avgDays: row?.avg_days == null ? null : Number(row.avg_days),
      };
    }),
  );

  return NextResponse.json(stages, {
    headers: { "Cache-Control": "private, max-age=60" },
  });
}
