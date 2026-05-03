// GET /api/dashboard/qual-leads-docs?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&granularity=day|week
//
// Cohort dashboard for "Время до Документы отправлены в ДЦ" (Бух Гос pipeline).
// For every cohort bucket (day or week) of qualified leads CREATED in the
// window, returns:
//   - avgDays:     average days from creation → first event_at where status_id =
//                  FIRST_LINE_STATUSES.DOCS_SENT_DC. Computed only over leads
//                  that actually transitioned through that stage.
//   - qualCount:   number of qualified leads created in the bucket (denominator
//                  of the conversion).
//   - docsCount:   number of those leads that reached DOCS_SENT_DC at any time
//                  (numerator of the conversion).
//   - conversion:  docsCount / qualCount, percent. Null when qualCount = 0.
//
// "Qualified" follows ТЗ: leads whose `non_qual_enum_id` is NOT one of:
//   744876 Неквал лид
//   747536 Неквал Доход
//   747530 Неквал Образование
//   747532 Неквал Возраст
//   744486 Неправильный номер
// NULL counts as qualified (no non-qual flag set). Note: 747534 "Неквал Язык"
// is intentionally NOT in the exclusion list — TZ omitted it.

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import {
  B2G_PIPELINES,
  FIRST_LINE_STATUSES,
} from "@/lib/kommo/pipeline-config";
import { addDaysCivil, parseDateBoundary, todayCivil } from "@/lib/utils/date";

interface QualLeadsRow {
  date: string;
  avgDays: number | null;
  qualCount: number;
  docsCount: number;
  conversion: number | null;
}

const NON_QUAL_EXCLUDED_ENUM_IDS = [744876, 747536, 747530, 747532, 744486];

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

  const granularity =
    url.searchParams.get("granularity") === "week" ? "week" : "day";

  const pipelineId = B2G_PIPELINES.FIRST_LINE;
  const docsSentStatusId = FIRST_LINE_STATUSES.DOCS_SENT_DC;

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
    avg_days: string | number | null;
    qual_count: string | number;
    docs_count: string | number;
  }>(sql`
    WITH docs_sent AS (
      -- Earliest moment each lead entered "Документы отправлены в ДЦ".
      SELECT lead_id, MIN(event_at) AS docs_sent_at
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${pipelineId}
        AND status_id = ${docsSentStatusId}
      GROUP BY lead_id
    ),
    qual_leads AS (
      SELECT
        ${cohortBucketExpr} AS cohort_date,
        lc.lead_id,
        lc.created_at,
        ds.docs_sent_at
      FROM analytics.leads_cohort lc
      LEFT JOIN docs_sent ds ON ds.lead_id = lc.lead_id
      WHERE lc.pipeline_id = ${pipelineId}
        AND lc.created_at >= ${fromDate}
        AND lc.created_at <= ${toDateEnd}
        AND (
          lc.non_qual_enum_id IS NULL
          OR lc.non_qual_enum_id <> ALL(${NON_QUAL_EXCLUDED_ENUM_IDS})
        )
    )
    SELECT
      cohort_date::text AS cohort_date,
      ROUND(AVG(
        EXTRACT(EPOCH FROM (docs_sent_at - created_at)) / 86400.0
      ) FILTER (
        WHERE docs_sent_at IS NOT NULL
          AND docs_sent_at >= created_at
      )::numeric, 1) AS avg_days,
      COUNT(*)::int AS qual_count,
      COUNT(*) FILTER (WHERE docs_sent_at IS NOT NULL)::int AS docs_count
    FROM qual_leads
    GROUP BY cohort_date
    ORDER BY cohort_date ASC
  `);

  const data: QualLeadsRow[] = result.rows.map((r) => {
    const qualCount = Number(r.qual_count);
    const docsCount = Number(r.docs_count);
    return {
      date: r.cohort_date,
      avgDays: r.avg_days == null ? null : Number(r.avg_days),
      qualCount,
      docsCount,
      conversion:
        qualCount > 0 ? Number(((docsCount / qualCount) * 100).toFixed(1)) : null,
    };
  });

  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "private, max-age=60",
    },
  });
}
