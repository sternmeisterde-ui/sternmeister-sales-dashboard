// GET /api/dashboard/qual-leads-docs?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&granularity=day|week
//
// Cohort dashboard for "Время до первого ключевого этапа" (Бух Гос pipeline).
// The "milestone" is the FIRST event_at where status_id ∈ {DOCS_SENT_DC, WON(142)}:
//
//   - leads that pass through "Документы отправлены в ДЦ" → milestone =
//     docs_sent_at event (historical behaviour, unchanged).
//   - leads that skip docs and go directly to "Термин ДЦ" (status 142) →
//     milestone = termin event. Per ROP 2026-05-11 these must also count
//     since they completed the funnel without leaving a docs trail.
//   - leads that hit both → MIN of the two events wins (chronologically first).
//
// For every cohort bucket (day or week) of qualified leads CREATED in the
// window, returns:
//   - avgDays:     average days from creation → milestone event. Computed
//                  only over leads that actually reached the milestone.
//   - qualCount:   number of qualified leads created in the bucket (denominator
//                  of the conversion).
//   - docsCount:   number of those leads that reached the milestone (kept the
//                  old field name for frontend compatibility; semantically =
//                  "reached docs OR termin").
//   - conversion:  docsCount / qualCount, percent. Null when qualCount = 0.
//
// "Qualified" follows ROP-frozen Kommo filter (2026-05-07): allow-list mode
// over BOTH status_id AND non_qual_enum_id (cf 879824 "Причина закрытия
// госники"). See QUAL_FIRST_LINE_STATUS_IDS and QUAL_REASON_ENUM_IDS in
// pipeline-config.ts for the exact frozen lists.
//
// In short:
//   - status MUST be one of the 10 allow-listed FIRST_LINE statuses (excludes
//     "Неразобранное" and "База" — pre-processing buckets)
//   - non_qual_enum_id MUST be NULL or in the 18-value allow-list (excludes
//     all "Неквал ..." reasons + "Неправильный номер" + any enum value not
//     explicitly allow-listed)

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import {
  B2G_PIPELINES,
  FIRST_LINE_STATUSES,
  QUAL_FIRST_LINE_STATUS_IDS,
  QUAL_REASON_ENUM_IDS,
} from "@/lib/kommo/pipeline-config";
import { addDaysCivil, parseDateBoundary, todayCivil } from "@/lib/utils/date";

interface QualLeadsRow {
  date: string;
  avgDays: number | null;
  qualCount: number;
  docsCount: number;
  conversion: number | null;
}

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

  // FIRST_LINE only (option A). Verified empirically (2026-05-03) that BERATER
  // is an independent intake — of 729 BERATER leads in 90d, 723 originated in
  // BERATER directly, only 1 transferred from FIRST_LINE. Including BERATER
  // would add 253 qual leads / 0 docs events to the cohort = noise that drags
  // conversion down without reflecting any real flow. Ever-in-FIRST_LINE via
  // status_changes (option C) is the marginally cleaner alternative if/when
  // it matters (gives 8.4% vs 8.5% — same in practice).
  const firstLineId = B2G_PIPELINES.FIRST_LINE;
  // Milestone = first time the lead enters either "Документы отправлены в
  // ДЦ" OR "Термин ДЦ" (status 142 = WON in FIRST_LINE). MIN(event_at) over
  // the union gives the chronologically first qualifying event.
  const docsSentStatusId = FIRST_LINE_STATUSES.DOCS_SENT_DC;
  const wonStatusId = FIRST_LINE_STATUSES.WON;

  // Double TZ conversion: created_at is stored as `timestamp without time
  // zone` carrying UTC; single `AT TIME ZONE 'Europe/Berlin'` would treat
  // the stored clock as already-Berlin and shift midnight rows to the prior
  // day. (Bug fixed 2026-05-07 — see termins/route.ts comment for the same
  // pattern.)
  const berlinCreated = sql`((lc.created_at) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin'`;
  const cohortBucketExpr =
    granularity === "week"
      ? sql`DATE_TRUNC('week', ${berlinCreated})::date`
      : sql`DATE(${berlinCreated})`;

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
      -- Earliest moment each lead entered EITHER "Документы отправлены в ДЦ"
      -- OR "Термин ДЦ" (status 142). Direct-to-Termin leads (no docs stop)
      -- now contribute via the second status. Kept the CTE name for diff
      -- readability — semantically this is a "first-milestone" timestamp.
      SELECT lead_id, MIN(event_at) AS docs_sent_at
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${firstLineId}
        AND status_id IN (${docsSentStatusId}, ${wonStatusId})
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
      WHERE lc.pipeline_id = ${firstLineId}
        AND lc.created_at >= ${fromDate}
        AND lc.created_at <= ${toDateEnd}
        AND lc.status_id IN (${sql.join(
          QUAL_FIRST_LINE_STATUS_IDS.map((id) => sql`${id}`),
          sql`, `,
        )})
        AND (
          lc.non_qual_enum_id IS NULL
          OR lc.non_qual_enum_id IN (${sql.join(
            QUAL_REASON_ENUM_IDS.map((id) => sql`${id}`),
            sql`, `,
          )})
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
