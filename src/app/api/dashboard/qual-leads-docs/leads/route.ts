// GET /api/dashboard/qual-leads-docs/leads
//   ?date=YYYY-MM-DD&granularity=day|week    (single bucket — line drill)
//   ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD    (period — tile drill)
//   &mode=docs|cohort|nodocs
//
// Drill-down for the qual-leads → first-milestone line chart. Milestone =
// MIN(event_at) over status_id ∈ {DOCS_SENT_DC, WON(142)} — same expansion
// as the parent endpoint. Per-row response indicates which event fired
// (milestoneType: "docs" | "termin") so the modal can label it accurately.
//
// mode=docs (default): leads that reached the milestone (either event).
//   Sort by largest duration first (avg-pullers).
// mode=cohort: full qual cohort regardless of milestone status. Used by
//   tiles "Квал лидов в когорте" and "Конверсия". Leads without milestone
//   surface first (NULLS FIRST = strongest non-conversion outliers).
// mode=nodocs: cohort minus those who reached the milestone — only the
//   "lost from conversion" leads. Optional diagnostic.
//
// Filter mirrors src/app/api/dashboard/qual-leads-docs/route.ts:
//   pipeline = FIRST_LINE
//   status_id ∈ QUAL_FIRST_LINE_STATUS_IDS
//   non_qual_enum_id IS NULL OR ∈ QUAL_REASON_ENUM_IDS
//   bucket(created_at) = date OR created_at BETWEEN dateFrom AND dateTo

import { NextRequest, NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import {
  QUAL_REASON_ENUM_IDS,
  getDocsSentStatusIds,
  getFirstLinePipelineIds,
  getQualFirstLineStatusIds,
  type Vertical,
} from "@/lib/kommo/pipeline-config";
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
  created_at_iso: string | null;
  docs_sent_at_iso: string | null;
  days_to_docs: string | number | null;
  milestone_type: "docs" | "termin" | null;
  total_count: string | number;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date");
  const dateFromParam = url.searchParams.get("dateFrom");
  const dateToParam = url.searchParams.get("dateTo");
  const granularity =
    url.searchParams.get("granularity") === "week" ? "week" : "day";
  const modeParam = url.searchParams.get("mode");
  const mode =
    modeParam === "cohort" || modeParam === "nodocs" ? modeParam : "docs";

  const isPeriod = !dateParam && !!dateFromParam && !!dateToParam;
  const isBucket = !!dateParam;

  if (!isPeriod && !isBucket) {
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

  // Vertical-aware (spec 21 §11): buh → Бух Гос, med → Мед Гос, all → обе.
  const vertical = parseTerminVertical(url.searchParams.get("vertical"));
  const firstLineIds = getFirstLinePipelineIds(vertical);
  const docsSentStatusIds = getDocsSentStatusIds(vertical);
  const qualStatusIds = getQualFirstLineStatusIds(vertical);
  const wonStatusId = 142; // WON общий для обеих воронок первой линии

  const berlinCreated = sql`((lc.created_at) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin'`;
  const bucketMatch: SQL = isBucket
    ? granularity === "week"
      ? sql`DATE_TRUNC('week', ${berlinCreated})::date = ${dateParam}::date`
      : sql`DATE(${berlinCreated}) = ${dateParam}::date`
    : sql`DATE(${berlinCreated}) BETWEEN ${dateFromParam}::date AND ${dateToParam}::date`;

  // docs_sent join is INNER for mode=docs, LEFT for cohort/nodocs.
  const docsJoin =
    mode === "docs"
      ? sql`JOIN docs_sent ds ON ds.lead_id = lc.lead_id`
      : sql`LEFT JOIN docs_sent ds ON ds.lead_id = lc.lead_id`;

  // mode-specific extra filter
  const docsExtra: SQL =
    mode === "docs"
      ? sql`AND ds.docs_sent_at >= lc.created_at`
      : mode === "nodocs"
        ? sql`AND ds.docs_sent_at IS NULL`
        : sql`AND TRUE`;

  // Sort:
  //   docs   → DESC days, longest delay first (avg-pullers)
  //   cohort → NULLS FIRST (no-docs leads at top — non-conversion outliers)
  //   nodocs → created_at ASC (chronological — every row is null-days)
  const orderBy =
    mode === "nodocs"
      ? sql`lc.created_at ASC`
      : mode === "cohort"
        ? sql`days_to_docs DESC NULLS FIRST, lc.created_at ASC`
        : sql`days_to_docs DESC, lc.created_at ASC`;

  const result = await (
    analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }
  ).execute<RawRow>(sql`
    WITH docs_sent AS (
      -- See parent endpoint: milestone = MIN(event_at) over docs OR termin.
      -- DISTINCT ON gives us the milestone's actual status_id alongside its
      -- timestamp, so the drill row can label which event fired.
      SELECT DISTINCT ON (lead_id)
        lead_id,
        event_at AS docs_sent_at,
        CASE
          WHEN status_id = ${wonStatusId} THEN 'termin'
          ELSE 'docs'
        END AS milestone_type
      FROM analytics.lead_status_changes
      WHERE pipeline_id IN (${inList(firstLineIds)})
        AND status_id IN (${inList([...docsSentStatusIds, wonStatusId])})
      ORDER BY lead_id, event_at ASC
    )
    SELECT
      lc.lead_id,
      lc.status AS status_name,
      lc.pipeline AS pipeline_name,
      lc.manager,
      (lc.created_at AT TIME ZONE 'UTC')::timestamptz AS created_at_iso,
      (ds.docs_sent_at AT TIME ZONE 'UTC')::timestamptz AS docs_sent_at_iso,
      CASE
        WHEN ds.docs_sent_at IS NOT NULL AND ds.docs_sent_at >= lc.created_at
        THEN ROUND((EXTRACT(EPOCH FROM (ds.docs_sent_at - lc.created_at)) / 86400.0)::numeric, 1)
        ELSE NULL
      END AS days_to_docs,
      ds.milestone_type,
      COUNT(*) OVER ()::bigint AS total_count
    FROM analytics.leads_cohort lc
    ${docsJoin}
    WHERE lc.pipeline_id IN (${inList(firstLineIds)})
      AND ${bucketMatch}
      AND lc.status_id IN (${inList(qualStatusIds)})
      AND (
        lc.non_qual_enum_id IS NULL
        OR lc.non_qual_enum_id IN (${inList([...QUAL_REASON_ENUM_IDS])})
      )
      ${docsExtra}
    ORDER BY ${orderBy}
    LIMIT ${HARD_CAP}
  `);

  const totalCount =
    result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
  const truncated = totalCount > result.rows.length;

  const leads = result.rows.map((r) => {
    const days = r.days_to_docs == null ? null : Number(r.days_to_docs);
    const milestone = r.milestone_type;
    let label: string;
    if (days == null) {
      label = "Без перехода в Док. в ДЦ / Termin";
    } else if (milestone === "termin") {
      label = `Termin ДЦ через ${formatDaysDuration(days)} (минуя Док.)`;
    } else {
      label = `Док. в ДЦ через ${formatDaysDuration(days)}`;
    }
    return {
      leadId: Number(r.lead_id),
      statusName: r.status_name,
      pipelineName: r.pipeline_name,
      responsible: r.manager,
      contributionLabel: label,
      contributionValue: days,
      createdAt: r.created_at_iso,
      docsSentAt: r.docs_sent_at_iso,
    };
  });

  return NextResponse.json(
    { leads, totalCount, truncated },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
