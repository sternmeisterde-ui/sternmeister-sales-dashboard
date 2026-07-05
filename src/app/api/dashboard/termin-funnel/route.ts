// GET /api/dashboard/termin-funnel?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
//
// Three-stage funnel waterfall (revamped 2026-05-07 per ROP spec):
//
//   1. BERATER:   Термин ДЦ состоялся    →  Термин АА
//      Same as before — measures the DC-visit → AA-stage delay.
//
//   2. FIRST_LINE (qualified): Создание сделки → "Термин ДЦ" (status_id=142
//      in FIRST_LINE = closed-won "Termin ДЦ").
//      Cohort: leads passing the qual allow-list (same filter as chart 3 —
//      QUAL_FIRST_LINE_STATUS_IDS + QUAL_REASON_ENUM_IDS or NULL).
//
//   3. BERATER:   "Принято от первой линии" (or creation as fallback)
//                                          →  Консультация перед термином ДЦ
//      Per ROP, the RECEIVED_FROM_FIRST event is treated as the lead's
//      effective creation in the BERATER pipeline. We use the event when
//      present, falling back to lc.created_at when the event log is missing
//      (rare, e.g. leads created directly in BERATER).
//
// For each stage, returns:
//   - count:    leads whose first `to_status` event landed in the window.
//   - avgDays:  mean days from start anchor → first `to_status` event,
//               over leads where start <= to_event.
//
// "First-event" semantics on both endpoints:
//   - Re-entry into a status (e.g. after a reschedule) doesn't double-count.
//   - One transition per lead, measured the first time it occurred.
//
// status_id 142 is WON in BOTH FIRST_LINE and BERATER. Always filter by
// pipeline_id when matching status 142 — otherwise we'd cross-contaminate.

import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
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

/** Вертикаль b2g из query (buh/med/all). Иначе undefined = буховый (legacy). */
function parseTerminVertical(raw: string | null): Vertical | undefined {
  return raw === "buh" || raw === "med" || raw === "all" ? raw : undefined;
}

const inList = (ids: number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

interface FunnelStage {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  count: number;
  avgDays: number | null;
}

type StageResult = { cnt: string | number; avg_days: string | number | null };

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

  const exec = (q: unknown) =>
    (analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }).execute<StageResult>(q);

  // Vertical-aware наборы (spec 21 §11). Без vertical → буховые (legacy).
  const vertical = parseTerminVertical(url.searchParams.get("vertical"));
  const beraterIds = getBeraterPipelineIds(vertical);
  const firstLineIds = getFirstLinePipelineIds(vertical);
  const brS = getBeraterStatusSets(vertical);
  const aaEntryIds = getTerminAAEntryStatusIds(vertical);
  const qualStatusIds = getQualFirstLineStatusIds(vertical);

  // Stage 1 — BERATER: TERM_DC_DONE → вход в АА-фазу. Бух — исторический
  // «Термин АА» (стадия убрана из воронки ~2026-03, последние события
  // 2026-03-02); мед — «Консультация перед термином АА» (аналог, своей
  // стадии Термин АА не было).
  const stage1 = exec(sql`
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
        AND status_id IN (${inList(aaEntryIds)})
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

  // Stage 2 — FIRST_LINE qualified: created_at → first time entering "Термин
  // ДЦ" (status_id 142 in FIRST_LINE pipeline). Uses the same allow-list
  // qual filter as chart 3 (frozen Kommo URL 2026-05-07); мед — зеркальные
  // статусы Мед Гос, reason-enum'ы общие (cf 879824, решение 2026-07-06).
  const stage2 = exec(sql`
    WITH to_evt AS (
      SELECT lead_id, MIN(event_at) AS at
      FROM analytics.lead_status_changes
      WHERE pipeline_id IN (${inList(firstLineIds)})
        AND status_id = 142
      GROUP BY lead_id
    )
    SELECT
      COUNT(*)::int AS cnt,
      ROUND(AVG(EXTRACT(EPOCH FROM (t.at - lc.created_at)) / 86400.0)
        FILTER (WHERE lc.created_at <= t.at)::numeric, 1) AS avg_days
    FROM to_evt t
    JOIN analytics.leads_cohort lc ON lc.lead_id = t.lead_id
    WHERE t.at >= ${fromDate} AND t.at <= ${toDateEnd}
      AND lc.status_id IN (${inList(qualStatusIds)})
      AND (
        lc.non_qual_enum_id IS NULL
        OR lc.non_qual_enum_id IN (${inList([...QUAL_REASON_ENUM_IDS])})
      )
  `);

  // Stage 3 — BERATER: RECEIVED_FROM_FIRST event (or creation as fallback)
  // → CONSULT_BEFORE_DC. Per ROP, the two anchors are equivalent in practice
  // — the COALESCE handles leads where the event log is missing.
  const stage3 = exec(sql`
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
    )
    SELECT
      COUNT(*)::int AS cnt,
      ROUND(AVG(EXTRACT(EPOCH FROM (t.at - COALESCE(f.at, lc.created_at))) / 86400.0)
        FILTER (WHERE COALESCE(f.at, lc.created_at) <= t.at)::numeric, 1) AS avg_days
    FROM to_evt t
    LEFT JOIN from_evt f ON f.lead_id = t.lead_id
    JOIN analytics.leads_cohort lc ON lc.lead_id = t.lead_id
    WHERE t.at >= ${fromDate} AND t.at <= ${toDateEnd}
  `);

  const [r1, r2, r3] = await Promise.all([stage1, stage2, stage3]);

  // Подписи этапов с учётом вертикали (стадии «Термин АА» у мед нет —
  // вход в АА-фазу считается по «Консультация перед термином АА»).
  const aaToName =
    vertical === "med" ? "Конс. перед термином АА"
    : vertical === "all" ? "Термин АА / Конс. перед АА"
    : "Термин АА";
  const creationFromName =
    vertical === "med" ? "Создание (Мед Гос)"
    : vertical === "all" ? "Создание (Бух/Мед Гос)"
    : "Создание (Бухгос)";

  const stages: FunnelStage[] = [
    {
      from: "term_dc_done",
      fromName: "Термин ДЦ состоялся",
      to: "term_aa",
      toName: aaToName,
      count: Number(r1.rows[0]?.cnt ?? 0),
      avgDays: r1.rows[0]?.avg_days == null ? null : Number(r1.rows[0].avg_days),
    },
    {
      from: "first_line_creation",
      fromName: creationFromName,
      to: "first_line_term_dc",
      toName: "Термин ДЦ",
      count: Number(r2.rows[0]?.cnt ?? 0),
      avgDays: r2.rows[0]?.avg_days == null ? null : Number(r2.rows[0].avg_days),
    },
    {
      from: "berater_received",
      fromName: "Принято от первой линии",
      to: "berater_consult_before_dc",
      toName: "Консультация перед термином ДЦ",
      count: Number(r3.rows[0]?.cnt ?? 0),
      avgDays: r3.rows[0]?.avg_days == null ? null : Number(r3.rows[0].avg_days),
    },
  ];

  return NextResponse.json(stages, {
    headers: { "Cache-Control": "private, max-age=60" },
  });
}
