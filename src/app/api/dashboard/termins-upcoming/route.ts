// GET /api/dashboard/termins-upcoming?days=30
//
// Per-day count of upcoming termins (DC and AA, separately) for planning the
// next N days. Reads termin_date / aa_termin_date directly — these ARE the
// planned dates.
//
// Per ROP rule (2026-05-07):
//   - DC slot: lead has termin_date set AND aa_termin_date IS NULL → counts
//     as DC on its termin_date day.
//   - AA slot: lead has aa_termin_date set → counts as AA on its
//     aa_termin_date day, regardless of whether termin_date is also set.
//     The AA stage supersedes the DC slot for planning (each calendar slot
//     is either a DC visit or an AA appointment, not both).
//
// Pipeline: BERATER only. FIRST_LINE WON (status_id=142, "Термин ДЦ"
// closed-won) leads also carry termin_date but are out of the planning
// workflow — they got termin straight away in FIRST_LINE without going
// through the BERATER consultation flow, so the ROP doesn't plan around
// them. Verified 2026-05-07: BERATER-only matches the ROP-cited 19 DC count.
//
// DC counter has no status-based exclusion — cancelled-state leads
// (TERM_DC_CANCELLED 93860875, TERM_AA_CANCELLED 93860883) keep their
// last-known termin_date and the slot is treated as "occupied / awaiting
// reschedule" rather than vacant.
//
// AA counter excludes BERATER_REVIEW (93860887): once the lead is in
// review, the AA appointment already happened and aa_termin_date is the
// historical record, not an upcoming slot.
//
// Returns a dense array (one row per Berlin civil day in the window) so the
// UI heatmap shows zeros instead of missing days.

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import {
  getBeraterPipelineIds,
  getTerminBeraterReviewStatusIds,
  type Vertical,
} from "@/lib/kommo/pipeline-config";

/** Вертикаль b2g из query (buh/med/all). Иначе undefined = буховый (legacy). */
function parseTerminVertical(raw: string | null): Vertical | undefined {
  return raw === "buh" || raw === "med" || raw === "all" ? raw : undefined;
}
import { addDaysCivil, todayCivil } from "@/lib/utils/date";

interface UpcomingRow {
  date: string;
  dcCount: number;
  aaCount: number;
  totalCount: number;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const daysParam = url.searchParams.get("days");
  const isCivil = (s: string | null): s is string =>
    !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

  // Окно: произвольный диапазон from/to (приоритет) ИЛИ «N дней вперёд от
  // сегодня» (fallback — пресеты 7/14/30/60/90). Span ограничен 366 днями,
  // чтобы generate_series не разрастался на гигантском диапазоне.
  let fromDay: string;
  let toDay: string;
  if (isCivil(fromParam) && isCivil(toParam) && fromParam <= toParam) {
    fromDay = fromParam;
    toDay = toParam;
    const spanDays = (Date.parse(toDay) - Date.parse(fromDay)) / 86_400_000;
    if (spanDays > 366) toDay = addDaysCivil(fromDay, 366);
  } else {
    const days = (() => {
      const n = Number(daysParam);
      if (!Number.isFinite(n) || n <= 0 || n > 180) return 30;
      return Math.floor(n);
    })();
    fromDay = todayCivil();
    toDay = addDaysCivil(fromDay, days - 1);
  }

  // Вертикаль Бух/Мед/Все → Бух Бератер / Мед Бератер / обе.
  const vertical = parseTerminVertical(url.searchParams.get("vertical"));
  const pipelineList = sql.join(
    getBeraterPipelineIds(vertical).map((id) => sql`${id}`),
    sql`, `,
  );
  // AA exclusion: BERATER_REVIEW means the AA appointment already happened and
  // the lead sits in review — its aa_termin_date is historical, not an upcoming
  // slot. Exclude from AA counter only. (Vertical-aware: buh/med review IDs.)
  const reviewList = sql.join(
    getTerminBeraterReviewStatusIds(vertical).map((id) => sql`${id}`),
    sql`, `,
  );

  const result = await (
    analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }
  ).execute<{
    bday: string;
    dc_count: string | number;
    aa_count: string | number;
  }>(sql`
    WITH days AS (
      SELECT generate_series(
        ${fromDay}::date,
        ${toDay}::date,
        '1 day'::interval
      )::date AS bday
    ),
    -- DC slot: termin_date set AND aa_termin_date IS NULL.
    -- TZ fix 2026-05-07: termin_date stores UTC clock; double conversion
    -- (UTC then Europe/Berlin) is needed or midnight-Berlin slips to the day
    -- before.
    dc_per_day AS (
      SELECT
        DATE((termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') AS bday,
        COUNT(*)::int AS n
      FROM analytics.leads_cohort
      WHERE pipeline_id IN (${pipelineList})
        AND termin_date IS NOT NULL
        AND aa_termin_date IS NULL
        AND DATE((termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') >= ${fromDay}::date
        AND DATE((termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') <= ${toDay}::date
      GROUP BY 1
    ),
    -- AA slot: any lead with aa_termin_date set (regardless of DC date) lands
    -- here on its AA date. This is the planning-side rule: once AA is on the
    -- calendar, the slot belongs to AA.
    aa_per_day AS (
      SELECT
        DATE((aa_termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') AS bday,
        COUNT(*)::int AS n
      FROM analytics.leads_cohort
      WHERE pipeline_id IN (${pipelineList})
        AND status_id NOT IN (${reviewList})
        AND aa_termin_date IS NOT NULL
        AND DATE((aa_termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') >= ${fromDay}::date
        AND DATE((aa_termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') <= ${toDay}::date
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
