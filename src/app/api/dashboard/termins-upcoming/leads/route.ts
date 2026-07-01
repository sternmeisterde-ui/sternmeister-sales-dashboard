// GET /api/dashboard/termins-upcoming/leads
//   ?date=YYYY-MM-DD                    (single bucket — bar drill)
//   ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD  (period — tile drill)
//   &leg=dc|aa|both
//
// Drill-down for the upcoming-termins chart. Returns the lead-level rows
// that contribute to either a single (date, leg) bar OR an entire period
// aggregate tile. Filter MUST mirror the parent endpoint exactly so the
// cardinality always matches the chart cell / tile.
//
// Mirrors src/app/api/dashboard/termins-upcoming/route.ts:
//   leg=dc → BERATER, termin_date IS NOT NULL, aa_termin_date IS NULL
//   leg=aa → BERATER, status_id <> BERATER_REVIEW, aa_termin_date IS NOT NULL
//   leg=both (period only) → UNION of the two legs (each lead can show twice
//                            if it sits in both legs over the window — same
//                            as the chart's stacked-bar count semantics)
//
// Sort: ascending on the relevant termin time so the modal reads as a
// chronological day plan (earliest slot first).

import { NextRequest, NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
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

const HARD_CAP = 500;

interface RawRow {
  lead_id: string | number;
  status_name: string | null;
  pipeline_name: string | null;
  manager: string | null;
  leg: "dc" | "aa";
  created_at_iso: string | null;
  termin_date_iso: string | null;
  aa_termin_date_iso: string | null;
  slot_iso: string | null;
  slot_date: string | null;
  total_count: string | number;
}

function dcLegSelect(rangeMatch: SQL, pipelineList: SQL): SQL {
  return sql`
    SELECT
      lead_id,
      status AS status_name,
      pipeline AS pipeline_name,
      manager,
      'dc'::text AS leg,
      (created_at AT TIME ZONE 'UTC')::timestamptz AS created_at_iso,
      (termin_date AT TIME ZONE 'UTC')::timestamptz AS termin_date_iso,
      (aa_termin_date AT TIME ZONE 'UTC')::timestamptz AS aa_termin_date_iso,
      (termin_date AT TIME ZONE 'UTC')::timestamptz AS slot_iso,
      DATE((termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::text AS slot_date
    FROM analytics.leads_cohort
    WHERE pipeline_id IN (${pipelineList})
      AND termin_date IS NOT NULL
      AND aa_termin_date IS NULL
      AND ${rangeMatch}
  `;
}

function aaLegSelect(rangeMatch: SQL, pipelineList: SQL, reviewList: SQL): SQL {
  return sql`
    SELECT
      lead_id,
      status AS status_name,
      pipeline AS pipeline_name,
      manager,
      'aa'::text AS leg,
      (created_at AT TIME ZONE 'UTC')::timestamptz AS created_at_iso,
      (termin_date AT TIME ZONE 'UTC')::timestamptz AS termin_date_iso,
      (aa_termin_date AT TIME ZONE 'UTC')::timestamptz AS aa_termin_date_iso,
      (aa_termin_date AT TIME ZONE 'UTC')::timestamptz AS slot_iso,
      DATE((aa_termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::text AS slot_date
    FROM analytics.leads_cohort
    WHERE pipeline_id IN (${pipelineList})
      AND status_id NOT IN (${reviewList})
      AND aa_termin_date IS NOT NULL
      AND ${rangeMatch}
  `;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date");
  const dateFromParam = url.searchParams.get("dateFrom");
  const dateToParam = url.searchParams.get("dateTo");
  const legParam = url.searchParams.get("leg");

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
  const leg =
    legParam === "dc" || legParam === "aa" || legParam === "both"
      ? legParam
      : null;
  if (!leg) {
    return NextResponse.json(
      { error: "leg param must be 'dc', 'aa', or 'both'" },
      { status: 400 },
    );
  }
  if (leg === "both" && !isPeriod) {
    return NextResponse.json(
      { error: "leg='both' is only valid for period drill (peak-day uses leg=dc/aa)" },
      { status: 400 },
    );
  }

  // Range expression for each leg's slot date column. Bucket mode = single
  // day; period mode = inclusive range. Both go through the same UTC→Berlin
  // double conversion as the parent.
  const dcRange = isBucket
    ? sql`DATE((termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') = ${dateParam}::date`
    : sql`DATE((termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') BETWEEN ${dateFromParam}::date AND ${dateToParam}::date`;
  const aaRange = isBucket
    ? sql`DATE((aa_termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') = ${dateParam}::date`
    : sql`DATE((aa_termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') BETWEEN ${dateFromParam}::date AND ${dateToParam}::date`;

  let body: SQL;
  const vertical = parseTerminVertical(url.searchParams.get("vertical"));
  const pipelineList = sql.join(getBeraterPipelineIds(vertical).map((id) => sql`${id}`), sql`, `);
  const reviewList = sql.join(getTerminBeraterReviewStatusIds(vertical).map((id) => sql`${id}`), sql`, `);
  if (leg === "dc") body = dcLegSelect(dcRange, pipelineList);
  else if (leg === "aa") body = aaLegSelect(aaRange, pipelineList, reviewList);
  else
    body = sql`(${dcLegSelect(dcRange, pipelineList)}) UNION ALL (${aaLegSelect(aaRange, pipelineList, reviewList)})`;

  const result = await (
    analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }
  ).execute<RawRow>(sql`
    WITH base AS (${body})
    SELECT
      base.*,
      COUNT(*) OVER ()::bigint AS total_count
    FROM base
    ORDER BY slot_iso ASC
    LIMIT ${HARD_CAP}
  `);

  const totalCount =
    result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
  const truncated = totalCount > result.rows.length;

  const leads = result.rows.map((r) => {
    const slotDate = r.slot_iso ? new Date(r.slot_iso) : null;
    const slotLabel = slotDate
      ? slotDate.toLocaleString("ru-RU", {
          ...(isPeriod
            ? { day: "2-digit", month: "2-digit" }
            : {}),
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Berlin",
        })
      : "—";
    const tag = r.leg === "dc" ? "ДЦ" : "АА";
    // contributionValue: slot epoch (sortable). Keeps the modal's outlier
    // logic neutral (no green/amber/rose hint) — there is no "outlier" for
    // a slot-time list, just chronology.
    const contributionValue = slotDate ? slotDate.getTime() / 86_400_000 : null;
    return {
      leadId: Number(r.lead_id),
      statusName: r.status_name,
      pipelineName: r.pipeline_name,
      responsible: r.manager,
      contributionLabel: `${tag} ${slotLabel}`,
      contributionValue,
      createdAt: r.created_at_iso,
      dcTermin: r.termin_date_iso,
      aaTermin: r.aa_termin_date_iso,
    };
  });

  return NextResponse.json(
    { leads, totalCount, truncated },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
