// GET /api/dashboard/termins-upcoming?days=30
//
// Per-day count of upcoming termins (DC and AA, separately) for planning the
// next N days. Reads termin_date / aa_termin_date directly — these ARE the
// planned dates.
//
// Per ROP rule (2026-05-07):
//   - A lead with termin_date set AND aa_termin_date IS NULL → counts as DC
//     on its termin_date day.
//   - A lead with aa_termin_date set → counts as AA on its aa_termin_date
//     day, regardless of whether termin_date is also set. The AA stage
//     supersedes the DC slot for planning purposes (each calendar slot is
//     either a DC visit or an AA appointment, not both).
//
// Pipelines: BOTH FIRST_LINE (Бух Гос) and BERATER (Бух Бератер). FIRST_LINE
// leads with status_id=142 ("Термин ДЦ" closed-won) carry termin_date too —
// they're "got termin straight away" and need to appear in the planning
// view alongside BERATER-flow leads.
//
// Excludes leads whose CURRENT status is TERM_DC_CANCELLED (BERATER 93860875)
// — a lead sitting in cancelled state has no committed date.
//
// Returns a dense array (one row per Berlin civil day in the window) so the
// UI heatmap shows zeros instead of missing days.

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { B2G_PIPELINES, BERATER_STATUSES } from "@/lib/kommo/pipeline-config";
import { addDaysCivil, todayCivil } from "@/lib/utils/date";

interface UpcomingRow {
  date: string;
  dcCount: number;
  aaCount: number;
  totalCount: number;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const daysParam = url.searchParams.get("days");
  const days = (() => {
    const n = Number(daysParam);
    if (!Number.isFinite(n) || n <= 0 || n > 180) return 30;
    return Math.floor(n);
  })();

  const todayBerlin = todayCivil();
  const lastDay = addDaysCivil(todayBerlin, days - 1);

  const firstLineId = B2G_PIPELINES.FIRST_LINE;
  const beraterId = B2G_PIPELINES.BERATER;
  const cancelledStatusId = BERATER_STATUSES.TERM_DC_CANCELLED;

  const result = await (
    analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }
  ).execute<{
    bday: string;
    dc_count: string | number;
    aa_count: string | number;
  }>(sql`
    WITH days AS (
      SELECT generate_series(
        ${todayBerlin}::date,
        ${lastDay}::date,
        '1 day'::interval
      )::date AS bday
    ),
    -- DC slot: termin_date set AND aa_termin_date IS NULL — DC visit not yet
    -- progressed to AA stage. Lead with both dates set is counted as AA only.
    dc_per_day AS (
      SELECT
        DATE(termin_date AT TIME ZONE 'Europe/Berlin') AS bday,
        COUNT(*)::int AS n
      FROM analytics.leads_cohort
      WHERE pipeline_id IN (${firstLineId}, ${beraterId})
        AND status_id <> ${cancelledStatusId}
        AND termin_date IS NOT NULL
        AND aa_termin_date IS NULL
        AND DATE(termin_date AT TIME ZONE 'Europe/Berlin') >= ${todayBerlin}::date
        AND DATE(termin_date AT TIME ZONE 'Europe/Berlin') <= ${lastDay}::date
      GROUP BY 1
    ),
    -- AA slot: any lead with aa_termin_date set (regardless of DC date) lands
    -- here on its AA date. This is the planning-side rule: once AA is on the
    -- calendar, the slot belongs to AA.
    aa_per_day AS (
      SELECT
        DATE(aa_termin_date AT TIME ZONE 'Europe/Berlin') AS bday,
        COUNT(*)::int AS n
      FROM analytics.leads_cohort
      WHERE pipeline_id IN (${firstLineId}, ${beraterId})
        AND status_id <> ${cancelledStatusId}
        AND aa_termin_date IS NOT NULL
        AND DATE(aa_termin_date AT TIME ZONE 'Europe/Berlin') >= ${todayBerlin}::date
        AND DATE(aa_termin_date AT TIME ZONE 'Europe/Berlin') <= ${lastDay}::date
      GROUP BY 1
    )
    SELECT
      d.bday::text AS bday,
      COALESCE(dc.n, 0)::int AS dc_count,
      COALESCE(aa.n, 0)::int AS aa_count
    FROM days d
    LEFT JOIN dc_per_day dc ON dc.bday = d.bday
    LEFT JOIN aa_per_day aa ON aa.bday = d.bday
    ORDER BY d.bday ASC
  `);

  const data: UpcomingRow[] = result.rows.map((r) => {
    const dcCount = Number(r.dc_count);
    const aaCount = Number(r.aa_count);
    return {
      date: r.bday,
      dcCount,
      aaCount,
      totalCount: dcCount + aaCount,
    };
  });

  // No-store: planning data turns over fast (managers schedule/reschedule
  // termins live in CRM). Frontend polls every few minutes — let those polls
  // hit the server, not a stale browser cache.
  return NextResponse.json(data, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
