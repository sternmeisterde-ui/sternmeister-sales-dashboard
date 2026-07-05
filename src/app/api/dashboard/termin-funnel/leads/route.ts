// GET /api/dashboard/termin-funnel/leads?stage=1|2|3&dateFrom=...&dateTo=...
//
// Drill-down for the funnel-timing chart. Each bar in the parent endpoint
// is one stage; this returns the lead-level rows that contribute to the
// stage's avgDays computation, sorted by duration DESC so the longest
// transitions surface first (they are the ones dragging the average up).
//
// Mirrors src/app/api/dashboard/termin-funnel/route.ts:
//   stage=1 — BERATER: TERM_DC_DONE → TERM_AA
//   stage=2 — FIRST_LINE qualified (allow-list): created_at → status 142
//   stage=3 — BERATER: COALESCE(RECEIVED_FROM_FIRST event, lc.created_at)
//                       → CONSULT_BEFORE_DC
//
// Window applies to the `to_evt` (transition end) timestamp, same as the
// parent. Leads with NULL start anchor are dropped (they never had a real
// start time, so duration is undefined).

import { NextRequest, NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import {
  QUAL_REASON_ENUM_IDS,
  getBeraterPipelineIds,
  getBeraterStatusSets,
  getFirstLinePipelineIds,
  getQualFirstLineStatusIds,
  getTerminAAEntryStatusIds,
  type Vertical,
} from "@/lib/kommo/pipeline-config";
import { addDaysCivil, parseDateBoundary, todayCivil } from "@/lib/utils/date";
import { formatDaysDuration } from "@/lib/utils/duration";

const HARD_CAP = 500;

/** Вертикаль b2g из query (buh/med/all). Иначе undefined = буховый (legacy). */
function parseTerminVertical(raw: string | null): Vertical | undefined {
  return raw === "buh" || raw === "med" || raw === "all" ? raw : undefined;
}

const inList = (ids: number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

interface RawRow {
  lead_id: string | number;
  status_name: string | null;
  pipeline_name: string | null;
  manager: string | null;
  start_at_iso: string | null;
  end_at_iso: string | null;
  duration_days: string | number | null;
  total_count: string | number;
}

function parseBerlinDate(input: string | null, kind: "start" | "end"): Date | null {
  if (!input) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  return parseDateBoundary(input, kind);
}

function buildStageQuery(
  stage: 1 | 2 | 3,
  fromDate: Date,
  toDateEnd: Date,
  vertical?: Vertical,
): SQL {
  // Vertical-aware наборы (spec 21 §11). Без vertical → буховые (legacy).
  const beraterIds = getBeraterPipelineIds(vertical);
  const firstLineIds = getFirstLinePipelineIds(vertical);
  const brS = getBeraterStatusSets(vertical);

  if (stage === 1) {
    return sql`
      WITH from_evt AS (
        SELECT lead_id, MIN(event_at) AS at
        FROM analytics.lead_status_changes
        WHERE pipeline_id IN (${inList(beraterIds)})
          AND status_id IN (${inList([...brS.termDCDone])})
        GROUP BY lead_id
      ),
      to_evt AS (
        SELECT lead_id, MIN(event_at) AS at
        FROM analytics.lead_status_changes
        WHERE pipeline_id IN (${inList(beraterIds)})
          AND status_id IN (${inList(getTerminAAEntryStatusIds(vertical))})
        GROUP BY lead_id
      ),
      eligible AS (
        SELECT
          t.lead_id,
          f.at AS start_at,
          t.at AS end_at,
          ROUND((EXTRACT(EPOCH FROM (t.at - f.at)) / 86400.0)::numeric, 1) AS duration_days
        FROM to_evt t
        LEFT JOIN from_evt f ON f.lead_id = t.lead_id
        WHERE t.at >= ${fromDate} AND t.at <= ${toDateEnd}
          AND f.at IS NOT NULL
          AND f.at <= t.at
      )
      SELECT
        e.lead_id,
        lc.status AS status_name,
        lc.pipeline AS pipeline_name,
        lc.manager,
        (e.start_at AT TIME ZONE 'UTC')::timestamptz AS start_at_iso,
        (e.end_at AT TIME ZONE 'UTC')::timestamptz AS end_at_iso,
        e.duration_days,
        COUNT(*) OVER ()::bigint AS total_count
      FROM eligible e
      JOIN analytics.leads_cohort lc ON lc.lead_id = e.lead_id
      ORDER BY e.duration_days DESC NULLS LAST, e.end_at DESC
      LIMIT ${HARD_CAP}
    `;
  }

  if (stage === 2) {
    return sql`
      WITH to_evt AS (
        SELECT lead_id, MIN(event_at) AS at
        FROM analytics.lead_status_changes
        WHERE pipeline_id IN (${inList(firstLineIds)})
          AND status_id = 142
        GROUP BY lead_id
      ),
      eligible AS (
        SELECT
          t.lead_id,
          lc.created_at AS start_at,
          t.at AS end_at,
          ROUND((EXTRACT(EPOCH FROM (t.at - lc.created_at)) / 86400.0)::numeric, 1) AS duration_days,
          lc.status,
          lc.pipeline,
          lc.manager
        FROM to_evt t
        JOIN analytics.leads_cohort lc ON lc.lead_id = t.lead_id
        WHERE t.at >= ${fromDate} AND t.at <= ${toDateEnd}
          AND lc.created_at <= t.at
          AND lc.status_id IN (${inList(getQualFirstLineStatusIds(vertical))})
          AND (
            lc.non_qual_enum_id IS NULL
            OR lc.non_qual_enum_id IN (${inList([...QUAL_REASON_ENUM_IDS])})
          )
      )
      SELECT
        lead_id,
        status AS status_name,
        pipeline AS pipeline_name,
        manager,
        (start_at AT TIME ZONE 'UTC')::timestamptz AS start_at_iso,
        (end_at AT TIME ZONE 'UTC')::timestamptz AS end_at_iso,
        duration_days,
        COUNT(*) OVER ()::bigint AS total_count
      FROM eligible
      ORDER BY duration_days DESC NULLS LAST, end_at DESC
      LIMIT ${HARD_CAP}
    `;
  }

  // stage === 3
  return sql`
    WITH from_evt AS (
      SELECT lead_id, MIN(event_at) AS at
      FROM analytics.lead_status_changes
      WHERE pipeline_id IN (${inList(beraterIds)})
        AND status_id IN (${inList([...brS.receivedFromFirst])})
      GROUP BY lead_id
    ),
    to_evt AS (
      SELECT lead_id, MIN(event_at) AS at
      FROM analytics.lead_status_changes
      WHERE pipeline_id IN (${inList(beraterIds)})
        AND status_id IN (${inList([...brS.consultBeforeDC])})
      GROUP BY lead_id
    ),
    eligible AS (
      SELECT
        t.lead_id,
        COALESCE(f.at, lc.created_at) AS start_at,
        t.at AS end_at,
        ROUND((EXTRACT(EPOCH FROM (t.at - COALESCE(f.at, lc.created_at))) / 86400.0)::numeric, 1) AS duration_days,
        lc.status,
        lc.pipeline,
        lc.manager
      FROM to_evt t
      LEFT JOIN from_evt f ON f.lead_id = t.lead_id
      JOIN analytics.leads_cohort lc ON lc.lead_id = t.lead_id
      WHERE t.at >= ${fromDate} AND t.at <= ${toDateEnd}
        AND COALESCE(f.at, lc.created_at) <= t.at
    )
    SELECT
      lead_id,
      status AS status_name,
      pipeline AS pipeline_name,
      manager,
      (start_at AT TIME ZONE 'UTC')::timestamptz AS start_at_iso,
      (end_at AT TIME ZONE 'UTC')::timestamptz AS end_at_iso,
      duration_days,
      COUNT(*) OVER ()::bigint AS total_count
    FROM eligible
    ORDER BY duration_days DESC NULLS LAST, end_at DESC
    LIMIT ${HARD_CAP}
  `;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const stageParam = Number(url.searchParams.get("stage"));
  if (stageParam !== 1 && stageParam !== 2 && stageParam !== 3) {
    return NextResponse.json(
      { error: "stage param must be 1, 2, or 3" },
      { status: 400 },
    );
  }
  const stage = stageParam as 1 | 2 | 3;

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

  const vertical = parseTerminVertical(url.searchParams.get("vertical"));

  const result = await (
    analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }
  ).execute<RawRow>(buildStageQuery(stage, fromDate, toDateEnd, vertical));

  const totalCount =
    result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
  const truncated = totalCount > result.rows.length;

  // Per-stage transition labels — render the row's startAt/endAt timestamps
  // as the actual funnel step the lead crossed, not generic "Старт/Финиш".
  // The lead's "сейчас:" status badge is unrelated (current Kommo state may
  // be downstream of the transition; that's expected).
  const aaLabel =
    vertical === "med" ? "Конс. перед термином АА"
    : vertical === "all" ? "Термин АА / Конс. перед АА"
    : "Термин АА";
  const stageLabels: Record<1 | 2 | 3, { from: string; to: string; short: string }> = {
    1: {
      from: "Термин ДЦ состоялся",
      to: aaLabel,
      short: "ДЦ-состоялся → АА",
    },
    2: {
      from: "Создание сделки",
      to: "Термин ДЦ (закрытие)",
      short: "Создание → Termin ДЦ",
    },
    3: {
      from: "Принято от первой линии",
      to: "Консультация перед термином ДЦ",
      short: "1Л → Конс. перед ДЦ",
    },
  };
  const labels = stageLabels[stage];

  const leads = result.rows.map((r) => {
    const days = r.duration_days == null ? null : Number(r.duration_days);
    const label =
      days == null
        ? `${labels.short}: длительность не определена`
        : `${labels.short}: ${formatDaysDuration(days)}`;
    return {
      leadId: Number(r.lead_id),
      statusName: r.status_name,
      pipelineName: r.pipeline_name,
      responsible: r.manager,
      contributionLabel: label,
      contributionValue: days,
      startAt: r.start_at_iso,
      endAt: r.end_at_iso,
      startAtLabel: labels.from,
      endAtLabel: labels.to,
    };
  });

  return NextResponse.json(
    { leads, totalCount, truncated },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
