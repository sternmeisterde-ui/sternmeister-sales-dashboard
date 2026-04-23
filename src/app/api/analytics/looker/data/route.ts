import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";

const DEPT_PIPELINES: Record<string, readonly string[]> = {
  b2g: ["Бух Гос", "Бух Бератер"],
  b2b: ["Бух Комм", "Мед Комм"],
} as const;

const VALID_STATUSES = new Set([
  "Термин ДЦ состоялся",
  "Термин ДЦ отменен/перенесен",
  "Термин ДЦ",
  "Термин АА отменен/перенесен",
  "Принято от первой линии",
  "Принимает решение",
  "Новый лид",
  "Недозвон",
  "На рассмотрении бератера",
  "Контакт установлен",
  "Консультация проведена",
  "Консультация перед термином ДЦ проведена",
  "Консультация перед термином ДЦ",
  "Консультация перед термином АА проведена",
  "Консультация перед термином АА",
  "Успешно реализовано",
  "Рассрочка",
  "Новый лид 3",
  "Новый лид 2",
  "Нет предварительного согласия",
  "ИНТЕРЕС ПОДТВЕРЖДЕН",
  "Закрыто и не реализовано",
  "Взят в работу",
  "База",
  "Счет выставлен",
]);

const VALID_CATEGORIES = new Set(["A", "B", "C", "D", "E"]);
const VALID_VIEWS = new Set(["all_calls", "cohorts", "detail"]);
const VALID_SLA = new Set(["0-9", "10-29", "30+"]);

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function clampInt(value: string | null, defaultVal: number, max: number): number {
  if (!value) return defaultVal;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return defaultVal;
  return Math.min(parsed, max);
}

function buildSlaCondition(slaRange: string): string {
  if (slaRange === "0-9") return "AND s.sla_first_call_seconds < 600";
  if (slaRange === "10-29") return "AND s.sla_first_call_seconds >= 600 AND s.sla_first_call_seconds < 1800";
  if (slaRange === "30+") return "AND s.sla_first_call_seconds >= 1800";
  return "";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const sp = request.nextUrl.searchParams;
    const dept = sp.get("dept") ?? "";
    const view = sp.get("view") ?? "all_calls";

    const allowedPipelines = DEPT_PIPELINES[dept];
    if (!allowedPipelines) {
      return NextResponse.json({ error: "Invalid dept" }, { status: 400 });
    }
    if (!VALID_VIEWS.has(view)) {
      return NextResponse.json({ error: "Invalid view" }, { status: 400 });
    }

    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
    const fromStr = sp.get("from") ?? defaultFrom.toISOString().slice(0, 10);
    const toStr = sp.get("to") ?? now.toISOString().slice(0, 10);

    const limit = clampInt(sp.get("limit"), 100, 500);
    const offset = clampInt(sp.get("offset"), 0, Number.MAX_SAFE_INTEGER);

    const pipelineParam = sp.get("pipeline") ?? "";
    const managerParam = sp.get("manager") ?? "";
    const statusesParam = sp.get("statuses") ?? "";
    const categoryParam = sp.get("category") ?? "";
    const slaParam = sp.get("sla") ?? "";

    // Build pipeline list (server-side whitelist only)
    let activePipelines: readonly string[];
    if (pipelineParam && allowedPipelines.includes(pipelineParam)) {
      activePipelines = [pipelineParam];
    } else {
      activePipelines = allowedPipelines;
    }

    const pipelineList = activePipelines.map((p) => `'${esc(p)}'`).join(", ");

    // Build base WHERE conditions
    const conditions: string[] = [
      `lc.created_at >= '${esc(fromStr)}T00:00:00Z'::timestamptz`,
      `lc.created_at <= '${esc(toStr)}T23:59:59Z'::timestamptz`,
      `lc.pipeline IN (${pipelineList})`,
    ];

    if (managerParam) {
      conditions.push(`lc.manager = '${esc(managerParam)}'`);
    }

    if (statusesParam) {
      const statusList = statusesParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_STATUSES.has(s));
      if (statusList.length > 0) {
        const inList = statusList.map((s) => `'${esc(s)}'`).join(", ");
        conditions.push(`lc.status IN (${inList})`);
      }
    }

    if (categoryParam && VALID_CATEGORIES.has(categoryParam)) {
      conditions.push(`lc.category = '${esc(categoryParam)}'`);
    }

    const baseWhere = conditions.join(" AND ");
    const slaCondition = slaParam && VALID_SLA.has(slaParam) ? buildSlaCondition(slaParam) : "";
    const needSlaJoinInFiltered = slaCondition !== "";

    // filterOptions.managers — always full dept+date range, no other filters
    const managerOptionsQuery = `
      SELECT DISTINCT lc.manager
      FROM analytics.leads_cohort lc
      WHERE lc.created_at >= '${esc(fromStr)}T00:00:00Z'::timestamptz
        AND lc.created_at <= '${esc(toStr)}T23:59:59Z'::timestamptz
        AND lc.pipeline IN (${pipelineList})
        AND lc.manager IS NOT NULL
      ORDER BY lc.manager
      LIMIT 500
    `;

    let mainQuery: string;
    let countQuery: string;

    const filteredLeadsCte = `
      filtered_leads AS (
        SELECT lc.lead_id, lc.manager, lc.created_at
        FROM analytics.leads_cohort lc
        ${needSlaJoinInFiltered ? "LEFT JOIN analytics.sla s ON s.lead_id = lc.lead_id" : ""}
        WHERE ${baseWhere}
        ${slaCondition}
      )
    `;

    const commAggCte = `
      comm_agg AS (
        SELECT
          lead_id,
          COUNT(*) FILTER (WHERE communication_type LIKE 'call%') AS total_calls,
          COUNT(*) FILTER (WHERE communication_type = 'call_out') AS outgoing_calls,
          COUNT(*) FILTER (WHERE communication_type = 'call_in') AS incoming_calls,
          COUNT(*) FILTER (WHERE communication_type LIKE '%message%') AS messages_sent,
          COUNT(*) FILTER (WHERE duration >= 10 AND communication_type LIKE 'call%') AS success_calls,
          COALESCE(SUM(duration) FILTER (WHERE communication_type LIKE 'call%'), 0) AS total_duration_sec,
          ROUND(AVG(duration) FILTER (WHERE communication_type LIKE 'call%')) AS avg_duration_sec
        FROM analytics.communications
        WHERE lead_id IN (SELECT lead_id FROM filtered_leads)
        GROUP BY lead_id
      )
    `;

    if (view === "all_calls") {
      mainQuery = `
        WITH ${filteredLeadsCte},
        ${commAggCte}
        SELECT
          COALESCE(fl.manager, '—') AS manager,
          COALESCE(SUM(ca.total_calls), 0) AS total_calls,
          COALESCE(SUM(ca.outgoing_calls), 0) AS outgoing_calls,
          COALESCE(SUM(ca.incoming_calls), 0) AS incoming_calls,
          COALESCE(SUM(ca.messages_sent), 0) AS messages_sent,
          ROUND(100.0 * COALESCE(SUM(ca.success_calls), 0) / NULLIF(COALESCE(SUM(ca.total_calls), 0), 0), 0) AS success_pct,
          COALESCE(SUM(ca.success_calls), 0) AS success_calls,
          COALESCE(SUM(ca.total_duration_sec), 0) AS total_duration_sec
        FROM filtered_leads fl
        LEFT JOIN comm_agg ca ON ca.lead_id = fl.lead_id
        GROUP BY fl.manager
        ORDER BY total_calls DESC NULLS LAST
      `;
      countQuery = mainQuery;
    } else if (view === "cohorts") {
      mainQuery = `
        WITH ${filteredLeadsCte},
        ${commAggCte}
        SELECT
          fl.manager,
          COUNT(fl.lead_id) AS lead_count,
          COALESCE(SUM(ca.outgoing_calls), 0) AS outgoing_calls,
          COALESCE(SUM(ca.messages_sent), 0) AS messages_sent,
          ROUND(100.0 * COALESCE(SUM(ca.success_calls), 0) / NULLIF(COALESCE(SUM(ca.total_calls), 0), 0), 0) AS success_pct,
          COALESCE(SUM(ca.total_duration_sec), 0) AS total_duration_sec,
          ROUND(COALESCE(SUM(ca.total_calls), 0)::numeric / NULLIF(COUNT(fl.lead_id), 0), 2) AS avg_calls_per_lead,
          ROUND(AVG(s.sla_first_call_seconds)) AS avg_sla_first_call_sec,
          COALESCE(SUM(s.sla_first_call_seconds), 0) AS total_sla_first_call_sec
        FROM filtered_leads fl
        LEFT JOIN comm_agg ca ON ca.lead_id = fl.lead_id
        LEFT JOIN analytics.sla s ON s.lead_id = fl.lead_id
        GROUP BY fl.manager
        ORDER BY lead_count DESC
      `;
      countQuery = mainQuery;
    } else {
      // detail view — paginated
      const detailBase = `
        WITH ${filteredLeadsCte},
        ${commAggCte}
        SELECT
          fl.manager,
          fl.lead_id,
          fl.created_at AS lead_created_at,
          s.sla_start,
          s.first_call_out_at,
          COALESCE(ca.success_calls, 0) AS success_calls,
          COALESCE(ca.total_calls, 0) AS total_calls,
          ca.avg_duration_sec,
          s.sla_first_call_seconds,
          s.sla_first_call_calendar_seconds
        FROM filtered_leads fl
        LEFT JOIN comm_agg ca ON ca.lead_id = fl.lead_id
        LEFT JOIN analytics.sla s ON s.lead_id = fl.lead_id
      `;
      mainQuery = `
        ${detailBase}
        ORDER BY success_calls ASC NULLS LAST, total_calls DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;
      countQuery = `
        WITH ${filteredLeadsCte}
        SELECT COUNT(*) AS count FROM filtered_leads
      `;
    }

    const [rowsResult, managerOptsResult] = await Promise.all([
      analyticsDb.execute<Record<string, unknown>>(sql.raw(mainQuery)),
      analyticsDb.execute<{ manager: string }>(sql.raw(managerOptionsQuery)),
    ]);

    let total = 0;
    if (view === "detail") {
      const countResult = await analyticsDb.execute<{ count: string }>(sql.raw(countQuery));
      total = Number(countResult.rows[0]?.count ?? 0);
    } else {
      total = rowsResult.rows.length;
    }

    const managers = managerOptsResult.rows
      .map((r) => r.manager)
      .filter(Boolean)
      .sort();

    return NextResponse.json({
      view,
      rows: rowsResult.rows,
      total,
      filterOptions: { managers },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[Analytics Looker API]", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
