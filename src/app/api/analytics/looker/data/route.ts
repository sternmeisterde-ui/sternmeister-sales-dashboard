import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";
import { getDeptManagerWhitelist } from "@/lib/daily/dept-manager-whitelist";

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
const VALID_VIEWS = new Set(["all_calls", "cohorts", "detail", "tlt_summary", "tlt_detail", "conversions", "meta"]);
const VALID_SLA = new Set(["0-9", "10-29", "30+"]);
const VALID_SLICES = new Set(["manager", "utm_source", "status", "pipeline", "category"]);

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

    const slice1Raw = sp.get("slice1") ?? "manager";
    const slice2Raw = sp.get("slice2") ?? "utm_source";
    const slice3Raw = sp.get("slice3") ?? "status";
    const slice1 = VALID_SLICES.has(slice1Raw) ? slice1Raw : "manager";
    const slice2 = VALID_SLICES.has(slice2Raw) ? slice2Raw : "utm_source";
    const slice3 = VALID_SLICES.has(slice3Raw) ? slice3Raw : "status";

    // Build pipeline list (server-side whitelist only)
    let activePipelines: readonly string[];
    if (pipelineParam && allowedPipelines.includes(pipelineParam)) {
      activePipelines = [pipelineParam];
    } else {
      activePipelines = allowedPipelines;
    }

    const pipelineList = activePipelines.map((p) => `'${esc(p)}'`).join(", ");

    // meta view — return data date bounds for calendar restriction
    if (view === "meta") {
      const metaQuery = `
        SELECT
          (MIN(created_at) AT TIME ZONE 'Europe/Berlin')::date AS min_date,
          (MAX(created_at) AT TIME ZONE 'Europe/Berlin')::date AS max_date
        FROM analytics.leads_cohort
        WHERE pipeline IN (${pipelineList})
      `;
      const metaRes = await analyticsDb.execute<{ min_date: string; max_date: string }>(
        sql.raw(metaQuery),
      );
      const row = metaRes.rows[0];
      return NextResponse.json({
        minDate: row?.min_date ?? null,
        maxDate: row?.max_date ?? null,
      });
    }

    // Build department manager whitelist from master_managers (role='manager',
    // is_active=true) with NAME_ALIASES folded in so integrator-side spellings match.
    // This replaces the old hardcoded EXCLUDED_MANAGERS: it also strips role=rop/admin
    // and cross-department contamination (e.g. a b2b manager attached to a b2g lead).
    const { names: whitelistNames, aliasToCanonical, shiftHourByName } = await getDeptManagerWhitelist(dept);
    if (whitelistNames.length === 0) {
      return NextResponse.json({
        view,
        rows: [],
        total: 0,
        filterOptions: { managers: [] },
      });
    }
    const whitelistSql = whitelistNames.map((n) => `'${esc(n)}'`).join(", ");

    // CASE expression mapping integrator spellings to canonical master_managers.name
    // so downstream GROUP BY aggregates aliases together and the UI shows the right name.
    const aliasCases: string[] = [];
    for (const [alias, canonical] of aliasToCanonical) {
      if (alias !== canonical) {
        aliasCases.push(`WHEN lc.manager = '${esc(alias)}' THEN '${esc(canonical)}'`);
      }
    }
    const canonicalManagerExpr = aliasCases.length > 0
      ? `CASE ${aliasCases.join(" ")} ELSE lc.manager END`
      : `lc.manager`;

    // Shift-start hour per manager (canonical name) → used to compute
    // "SLA по смене" = first_call - max(lead_time, shift_start_of_lead_day).
    // Default 9 (09:00 Berlin) when the master has no shift configured.
    const shiftCases: string[] = [];
    for (const [name, hour] of shiftHourByName) {
      shiftCases.push(`WHEN fl.manager = '${esc(name)}' THEN ${hour}`);
    }
    const shiftHourExpr = shiftCases.length > 0
      ? `CASE ${shiftCases.join(" ")} ELSE 9 END`
      : `9`;

    // Also canonicalise the manager filter param itself: the UI passes the canonical
    // name from the dropdown (which we already normalise below), but the stored row
    // might use the alias spelling.
    const normalisedManagerParam = managerParam
      ? aliasToCanonical.get(managerParam) ?? managerParam
      : "";

    const conditions: string[] = [
      `lc.created_at >= ('${esc(fromStr)} 00:00:00'::timestamp AT TIME ZONE 'Europe/Berlin')`,
      `lc.created_at <= ('${esc(toStr)} 23:59:59'::timestamp AT TIME ZONE 'Europe/Berlin')`,
      `lc.pipeline IN (${pipelineList})`,
      `lc.manager IN (${whitelistSql})`,
    ];

    if (normalisedManagerParam) {
      // Match any integrator spelling that canonicalises to the requested manager.
      const matchingAliases: string[] = [];
      for (const [alias, canonical] of aliasToCanonical) {
        if (canonical === normalisedManagerParam) matchingAliases.push(alias);
      }
      if (matchingAliases.length > 0) {
        const inList = matchingAliases.map((a) => `'${esc(a)}'`).join(", ");
        conditions.push(`lc.manager IN (${inList})`);
      } else {
        conditions.push(`lc.manager = '${esc(normalisedManagerParam)}'`);
      }
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

    // filterOptions.managers — always full dept+date range, no other filters.
    // Returns canonical names (aliases folded) so the dropdown matches the
    // Managers tab and master_managers.
    const managerOptionsQuery = `
      SELECT DISTINCT ${canonicalManagerExpr} AS manager
      FROM analytics.leads_cohort lc
      WHERE lc.created_at >= ('${esc(fromStr)} 00:00:00'::timestamp AT TIME ZONE 'Europe/Berlin')
        AND lc.created_at <= ('${esc(toStr)} 23:59:59'::timestamp AT TIME ZONE 'Europe/Berlin')
        AND lc.pipeline IN (${pipelineList})
        AND lc.manager IN (${whitelistSql})
      ORDER BY manager
      LIMIT 500
    `;

    let mainQuery: string;
    let countQuery: string;

    const filteredLeadsCte = `
      filtered_leads AS (
        SELECT lc.lead_id, ${canonicalManagerExpr} AS manager, lc.created_at
        FROM analytics.leads_cohort lc
        ${needSlaJoinInFiltered ? "LEFT JOIN analytics.sla s ON s.lead_id = lc.lead_id" : ""}
        WHERE ${baseWhere}
        ${slaCondition}
      )
    `;

    // TLT variant — includes extra columns for pivot slice grouping
    const tltFilteredLeadsCte = `
      filtered_leads AS (
        SELECT lc.lead_id, ${canonicalManagerExpr} AS manager, lc.created_at, lc.utm_source, lc.status, lc.pipeline, lc.category
        FROM analytics.leads_cohort lc
        ${needSlaJoinInFiltered ? "LEFT JOIN analytics.sla s ON s.lead_id = lc.lead_id" : ""}
        WHERE ${baseWhere}
        ${slaCondition}
      )
    `;

    const callGapsCte = `
      call_gaps AS (
        SELECT lead_id, AVG(gap_seconds) AS avg_gap_sec
        FROM (
          SELECT lead_id,
            EXTRACT(EPOCH FROM (created_at - LAG(created_at) OVER (PARTITION BY lead_id ORDER BY created_at))) AS gap_seconds
          FROM analytics.communications
          WHERE lead_id IN (SELECT lead_id FROM filtered_leads)
            AND communication_type LIKE 'call%'
        ) g
        WHERE gap_seconds IS NOT NULL
        GROUP BY lead_id
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
      // SLA metrics (both in calendar seconds, using analytics.sla naive Berlin timestamps):
      //   avg_sla_lead_to_call_sec = AVG(first_call_out_at - sla_start)
      //     — от момента падения лида до первого исходящего звонка.
      //   avg_sla_from_shift_sec   = AVG(first_call_out_at - GREATEST(sla_start, shift_start_on_lead_day))
      //     — если лид упал ДО начала смены, отсчитываем от начала смены;
      //       если ПОСЛЕ — совпадает с metric A.
      // Both excluded when no outgoing call exists or call happened before start.
      mainQuery = `
        WITH ${filteredLeadsCte},
        ${commAggCte}
        SELECT
          fl.manager,
          COUNT(fl.lead_id) AS lead_count,
          COALESCE(SUM(ca.outgoing_calls), 0) AS outgoing_calls,
          COALESCE(SUM(ca.messages_sent), 0) AS messages_sent,
          ROUND(100.0 * COALESCE(SUM(ca.success_calls), 0) / NULLIF(COALESCE(SUM(ca.total_calls), 0), 0), 0) AS success_pct,
          COALESCE(SUM(ca.success_calls), 0) AS success_calls,
          COALESCE(SUM(ca.total_calls), 0) AS total_all_calls,
          COALESCE(SUM(ca.total_duration_sec), 0) AS total_duration_sec,
          ROUND(COALESCE(SUM(ca.total_calls), 0)::numeric / NULLIF(COUNT(fl.lead_id), 0), 2) AS avg_calls_per_lead,
          ROUND(AVG(
            CASE WHEN s.first_call_out_at IS NOT NULL AND s.first_call_out_at > s.sla_start
                 THEN EXTRACT(EPOCH FROM (s.first_call_out_at - s.sla_start))
            END
          )) AS avg_sla_lead_to_call_sec,
          ROUND(AVG(
            CASE WHEN s.first_call_out_at IS NOT NULL
                 THEN GREATEST(0, EXTRACT(EPOCH FROM (
                   s.first_call_out_at
                   - GREATEST(
                       s.sla_start,
                       date_trunc('day', s.sla_start) + (${shiftHourExpr}) * INTERVAL '1 hour'
                     )
                 )))
            END
          )) AS avg_sla_from_shift_sec,
          COUNT(s.first_call_out_at) AS sla_lead_count
        FROM filtered_leads fl
        LEFT JOIN comm_agg ca ON ca.lead_id = fl.lead_id
        LEFT JOIN analytics.sla s ON s.lead_id = fl.lead_id
        GROUP BY fl.manager
        ORDER BY lead_count DESC
      `;
      countQuery = mainQuery;
    } else if (view === "detail") {
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
          s.sla_first_call_from_shift_seconds,
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
    } else if (view === "tlt_summary") {
      mainQuery = `
        WITH ${tltFilteredLeadsCte},
        ${commAggCte},
        ${callGapsCte}
        SELECT
          COALESCE(fl.${slice1}::text, '—') AS param1,
          COALESCE(fl.${slice2}::text, '—') AS param2,
          COALESCE(fl.${slice3}::text, '—') AS param3,
          COUNT(fl.lead_id) AS lead_count,
          ROUND(AVG(s.sla_first_contact_seconds)) AS avg_tlt,
          ROUND(AVG(cg.avg_gap_sec)) AS avg_gap_sec,
          COALESCE(SUM(ca.outgoing_calls), 0) AS outgoing_calls,
          COALESCE(SUM(ca.messages_sent), 0) AS messages_sent,
          COALESCE(SUM(ca.outgoing_calls), 0) + COALESCE(SUM(ca.messages_sent), 0) AS total_comms
        FROM filtered_leads fl
        LEFT JOIN analytics.sla s ON s.lead_id = fl.lead_id
        LEFT JOIN comm_agg ca ON ca.lead_id = fl.lead_id
        LEFT JOIN call_gaps cg ON cg.lead_id = fl.lead_id
        GROUP BY fl.${slice1}, fl.${slice2}, fl.${slice3}
        ORDER BY lead_count DESC
      `;
      countQuery = mainQuery;
    } else if (view === "tlt_detail") {
      // tlt_detail — per-lead, paginated
      mainQuery = `
        WITH ${tltFilteredLeadsCte},
        ${commAggCte},
        ${callGapsCte}
        SELECT
          fl.manager,
          fl.status AS current_status,
          fl.lead_id,
          s.sla_first_contact_seconds AS tlt,
          COALESCE(ca.outgoing_calls, 0) AS outgoing_calls,
          COALESCE(ca.messages_sent, 0) AS messages_sent,
          COALESCE(ca.outgoing_calls, 0) + COALESCE(ca.messages_sent, 0) AS total_comms,
          ROUND(cg.avg_gap_sec) AS avg_gap_sec
        FROM filtered_leads fl
        LEFT JOIN analytics.sla s ON s.lead_id = fl.lead_id
        LEFT JOIN comm_agg ca ON ca.lead_id = fl.lead_id
        LEFT JOIN call_gaps cg ON cg.lead_id = fl.lead_id
        ORDER BY tlt ASC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;
      countQuery = `
        WITH ${tltFilteredLeadsCte}
        SELECT COUNT(*) AS count FROM filtered_leads
      `;
    } else {
      // conversions — true funnel: how many cohort leads ever reached each status
      // Uses lead_status_changes (history) not leads_cohort (snapshot of current status).
      mainQuery = `
        WITH ${tltFilteredLeadsCte},
        pipeline_totals AS (
          SELECT pipeline, COUNT(*) AS total
          FROM filtered_leads
          GROUP BY pipeline
        )
        SELECT
          fl.pipeline,
          sc.status,
          sc.sort AS status_order,
          COUNT(DISTINCT sc.lead_id) AS lead_count,
          pt.total AS pipeline_total,
          ROUND(100.0 * COUNT(DISTINCT sc.lead_id) / pt.total, 1) AS pct
        FROM filtered_leads fl
        JOIN analytics.lead_status_changes sc
          ON sc.lead_id = fl.lead_id AND sc.pipeline = fl.pipeline
        JOIN pipeline_totals pt ON pt.pipeline = fl.pipeline
        GROUP BY fl.pipeline, sc.status, sc.sort, pt.total
        ORDER BY fl.pipeline, sc.sort ASC NULLS LAST, COUNT(DISTINCT sc.lead_id) DESC
      `;
      countQuery = mainQuery;
    }

    const [rowsResult, managerOptsResult] = await Promise.all([
      analyticsDb.execute<Record<string, unknown>>(sql.raw(mainQuery)),
      analyticsDb.execute<{ manager: string }>(sql.raw(managerOptionsQuery)),
    ]);

    let total = 0;
    if (view === "detail" || view === "tlt_detail") {
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
