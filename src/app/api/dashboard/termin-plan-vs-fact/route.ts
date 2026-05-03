// GET /api/dashboard/termin-plan-vs-fact?month=YYYY-MM
//
// Calendar-month plan vs fact + end-of-month forecast for DC and AA termins.
//
// PLAN (DC)        — leads where termin_date AT TIME ZONE 'Europe/Berlin'
//                    falls in the month, status not TERM_DC_CANCELLED.
// PLAN (AA)        — same on aa_termin_date / TERM_AA_CANCELLED.
// FACT (DC)        — TERM_DC_DONE events (status_id 93886075) with event_at
//                    in the month, BERATER pipeline.
// FACT (AA)        — proxy: leads that REACHED a post-AA stage during the
//                    month. AA itself doesn't have a clean "happened" event
//                    (TERM_AA is the scheduled state), so we use the next
//                    transition (CONSULT_BEFORE_AA_DONE OR BERATER_REVIEW)
//                    as the "AA actually delivered" signal.
// FORECAST         — fact_to_date + (scheduled-future this month × historical
//                    completion rate over last 90 days).
//   completion_rate = TERM_DC_DONE events past 90d / leads with termin_date
//                    in past 90d (status not cancelled).
//
// Returns absolute numbers + percentages; the UI doesn't need to know the
// month boundaries.

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { B2G_PIPELINES, BERATER_STATUSES } from "@/lib/kommo/pipeline-config";
import { berlinCivilDate, todayCivil } from "@/lib/utils/date";

interface PlanVsFactResp {
  month: string;
  monthStart: string;
  monthEnd: string;
  isCurrentMonth: boolean;
  dc: {
    plan: number;
    fact: number;
    completionRate: number | null;
    scheduledFuture: number;
    forecast: number | null;
  };
  aa: {
    plan: number;
    fact: number;
    completionRate: number | null;
    scheduledFuture: number;
    forecast: number | null;
  };
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const today = todayCivil();
  const monthParam = url.searchParams.get("month");
  const today_y = Number(today.slice(0, 4));
  const today_m = Number(today.slice(5, 7));

  let y: number;
  let m: number;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    y = Number(monthParam.slice(0, 4));
    m = Number(monthParam.slice(5, 7));
  } else {
    y = today_y;
    m = today_m;
  }

  const monthStartCivil = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-01`;
  const lastDay = lastDayOfMonth(y, m);
  const monthEndCivil = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${lastDay.toString().padStart(2, "0")}`;
  const monthStart = berlinCivilDate(monthStartCivil);
  const monthEnd = new Date(berlinCivilDate(monthEndCivil).getTime() + 86_399_999);
  const isCurrentMonth = y === today_y && m === today_m;
  const todayBerlinDate = berlinCivilDate(today);

  const pipelineId = B2G_PIPELINES.BERATER;
  const dcDoneStatusId = BERATER_STATUSES.TERM_DC_DONE;
  const dcCancelledStatusId = BERATER_STATUSES.TERM_DC_CANCELLED;
  const aaCancelledStatusId = BERATER_STATUSES.TERM_AA_CANCELLED;

  // For "AA fact" use the post-AA transition as the proxy that the AA
  // actually delivered — see header docstring.
  const aaDeliveredStatusIds = [
    BERATER_STATUSES.CONSULT_BEFORE_AA_DONE,
    BERATER_STATUSES.BERATER_REVIEW,
  ];

  const exec = async <T>(q: unknown) =>
    (analyticsDb as { execute: <X>(q: unknown) => Promise<{ rows: X[] }> }).execute<T>(q);

  // 1) Plan: leads with termin_date in [monthStart, monthEnd], not cancelled.
  const planDc = await exec<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM analytics.leads_cohort
    WHERE pipeline_id = ${pipelineId}
      AND status_id <> ${dcCancelledStatusId}
      AND termin_date IS NOT NULL
      AND DATE(termin_date AT TIME ZONE 'Europe/Berlin') >= ${monthStartCivil}::date
      AND DATE(termin_date AT TIME ZONE 'Europe/Berlin') <= ${monthEndCivil}::date
  `);
  const planAa = await exec<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM analytics.leads_cohort
    WHERE pipeline_id = ${pipelineId}
      AND status_id <> ${aaCancelledStatusId}
      AND aa_termin_date IS NOT NULL
      AND DATE(aa_termin_date AT TIME ZONE 'Europe/Berlin') >= ${monthStartCivil}::date
      AND DATE(aa_termin_date AT TIME ZONE 'Europe/Berlin') <= ${monthEndCivil}::date
  `);

  // 2) Fact DC: TERM_DC_DONE events with event_at in month.
  const factDc = await exec<{ n: number }>(sql`
    SELECT COUNT(DISTINCT lead_id)::int AS n
    FROM analytics.lead_status_changes
    WHERE pipeline_id = ${pipelineId}
      AND status_id = ${dcDoneStatusId}
      AND event_at >= ${monthStart}
      AND event_at <= ${monthEnd}
  `);

  // 3) Fact AA: leads that reached a post-AA stage during the month.
  const factAa = await exec<{ n: number }>(sql`
    SELECT COUNT(DISTINCT lead_id)::int AS n
    FROM analytics.lead_status_changes
    WHERE pipeline_id = ${pipelineId}
      AND status_id IN (${sql.join(aaDeliveredStatusIds.map((id) => sql`${id}`), sql`, `)})
      AND event_at >= ${monthStart}
      AND event_at <= ${monthEnd}
  `);

  // 4) Scheduled future (today → monthEnd) for DC and AA.
  const futureDc = isCurrentMonth
    ? (await exec<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n
        FROM analytics.leads_cohort
        WHERE pipeline_id = ${pipelineId}
          AND status_id <> ${dcCancelledStatusId}
          AND termin_date IS NOT NULL
          AND DATE(termin_date AT TIME ZONE 'Europe/Berlin') > ${todayBerlinDate}::date
          AND DATE(termin_date AT TIME ZONE 'Europe/Berlin') <= ${monthEndCivil}::date
      `)).rows[0]?.n ?? 0
    : 0;
  const futureAa = isCurrentMonth
    ? (await exec<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n
        FROM analytics.leads_cohort
        WHERE pipeline_id = ${pipelineId}
          AND status_id <> ${aaCancelledStatusId}
          AND aa_termin_date IS NOT NULL
          AND DATE(aa_termin_date AT TIME ZONE 'Europe/Berlin') > ${todayBerlinDate}::date
          AND DATE(aa_termin_date AT TIME ZONE 'Europe/Berlin') <= ${monthEndCivil}::date
      `)).rows[0]?.n ?? 0
    : 0;

  // 5) Historical completion rate (last 90d) — what fraction of "scheduled
  //    in past day X" actually triggered a TERM_DC_DONE event?
  //
  //    Numerator: distinct leads with TERM_DC_DONE event in past 90 days.
  //    Denominator: distinct leads where termin_date sat in past 90 days
  //                 AND status_id <> CANCELLED.
  //    Approximate — overcounts deliveries for leads whose termin_date drifted,
  //    but stable enough for monthly forecasting.
  const histDc = await exec<{ planned: number; done: number }>(sql`
    WITH planned AS (
      SELECT DISTINCT lead_id
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${pipelineId}
        AND status_id <> ${dcCancelledStatusId}
        AND termin_date IS NOT NULL
        AND termin_date >= NOW() - INTERVAL '90 days'
        AND termin_date <  NOW()
    ),
    done AS (
      SELECT DISTINCT lead_id
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${pipelineId}
        AND status_id = ${dcDoneStatusId}
        AND event_at >= NOW() - INTERVAL '90 days'
    )
    SELECT
      (SELECT COUNT(*) FROM planned)::int AS planned,
      (SELECT COUNT(*) FROM done)::int    AS done
  `);
  const histAa = await exec<{ planned: number; done: number }>(sql`
    WITH planned AS (
      SELECT DISTINCT lead_id
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${pipelineId}
        AND status_id <> ${aaCancelledStatusId}
        AND aa_termin_date IS NOT NULL
        AND aa_termin_date >= NOW() - INTERVAL '90 days'
        AND aa_termin_date <  NOW()
    ),
    done AS (
      SELECT DISTINCT lead_id
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${pipelineId}
        AND status_id IN (${sql.join(aaDeliveredStatusIds.map((id) => sql`${id}`), sql`, `)})
        AND event_at >= NOW() - INTERVAL '90 days'
    )
    SELECT
      (SELECT COUNT(*) FROM planned)::int AS planned,
      (SELECT COUNT(*) FROM done)::int    AS done
  `);

  const dcPlanned = histDc.rows[0]?.planned ?? 0;
  const dcDone = histDc.rows[0]?.done ?? 0;
  const aaPlanned = histAa.rows[0]?.planned ?? 0;
  const aaDone = histAa.rows[0]?.done ?? 0;
  const dcRate = dcPlanned > 0 ? dcDone / dcPlanned : null;
  const aaRate = aaPlanned > 0 ? aaDone / aaPlanned : null;

  const dcFact = factDc.rows[0]?.n ?? 0;
  const aaFact = factAa.rows[0]?.n ?? 0;

  const dcForecast =
    dcRate == null
      ? null
      : Math.round(dcFact + futureDc * dcRate);
  const aaForecast =
    aaRate == null
      ? null
      : Math.round(aaFact + futureAa * aaRate);

  const resp: PlanVsFactResp = {
    month: `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}`,
    monthStart: monthStartCivil,
    monthEnd: monthEndCivil,
    isCurrentMonth,
    dc: {
      plan: planDc.rows[0]?.n ?? 0,
      fact: dcFact,
      completionRate: dcRate == null ? null : Number((dcRate * 100).toFixed(1)),
      scheduledFuture: futureDc,
      forecast: dcForecast,
    },
    aa: {
      plan: planAa.rows[0]?.n ?? 0,
      fact: aaFact,
      completionRate: aaRate == null ? null : Number((aaRate * 100).toFixed(1)),
      scheduledFuture: futureAa,
      forecast: aaForecast,
    },
  };

  return NextResponse.json(resp, {
    headers: { "Cache-Control": "private, max-age=60" },
  });
}
