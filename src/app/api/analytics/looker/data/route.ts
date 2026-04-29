import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";
import { getDeptManagerWhitelist, getDeptScheduleOverrides } from "@/lib/daily/dept-manager-whitelist";

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
const VALID_VIEWS = new Set([
  "all_calls",
  "cohorts",
  "cohorts_detail", // per-lead drill-down for one manager (SLA worst-deals)
  "detail",
  "tlt_summary",
  "tlt_detail",
  "conversions",
  "meta",
]);
const VALID_SLA = new Set(["0-9", "10-29", "30+"]);
// "none" hides the slice column entirely — UI sends it when the user picks
// the "—" option in the срез dropdown. SELECT emits NULL for that param,
// GROUP BY skips it, and the client hides the column.
const VALID_SLICES = new Set(["manager", "utm_source", "status", "pipeline", "category", "none"]);

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

    // Shift-start hour per manager (canonical name) — master default.
    // Default 9 (09:00 Berlin) when the master has no shift configured.
    const shiftCases: string[] = [];
    for (const [name, hour] of shiftHourByName) {
      shiftCases.push(`WHEN fl.manager = '${esc(name)}' THEN ${hour}`);
    }
    const masterShiftHourExpr = shiftCases.length > 0
      ? `CASE ${shiftCases.join(" ")} ELSE 9 END`
      : `9`;

    // Per-day shift overrides from manager_schedule (Daily calendar).
    // Built as an inline VALUES CTE and LEFT JOIN'd on (manager, lead_date).
    // Empty-safe: if no overrides in the date range, we still emit a dummy
    // row with NULLs so the LEFT JOIN never matches and the master default
    // stands. PG doesn't allow `VALUES` with zero rows.
    const scheduleOverrides = await getDeptScheduleOverrides(dept, fromStr, toStr);
    const scheduleValues = scheduleOverrides.length > 0
      ? scheduleOverrides
          .map((o) => `('${esc(o.name)}', DATE '${esc(o.date)}', ${o.hour})`)
          .join(", ")
      : `(NULL::text, NULL::date, NULL::int)`;
    const scheduleOverridesCte = `
      schedule_overrides(manager_name, schedule_date, shift_hour) AS (
        VALUES ${scheduleValues}
      )
    `;
    // Effective shift hour: per-day override wins, master default is fallback.
    const effectiveShiftHourExpr = `COALESCE(so.shift_hour, ${masterShiftHourExpr})`;

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

    // ─── B2B SLA eligibility filter ───────────────────────────────────────
    // For Коммерция (b2b) SLA is computed only on real prospects:
    //   1) at first_call + 2h the lead is still in {Бух Комм, Мед Комм}
    //      (skips leads that drifted out of the funnel quickly), and
    //   2) the lead is NOT closed-not-realized at +2h with reason ∈
    //      {Неквал лид, Спам, Предложение сотрудничества}. Closed-lost with
    //      ANY OTHER reason stays in the pool.
    //
    // Reason source: Kommo custom field 876383 "Причины закрытия (Обязательное
    // поле)" — required by Kommo when status_id=143 on B2B pipelines, mirrored
    // into analytics.leads_cohort.b2b_close_reason_enum_id by sync-leads. The
    // standard Kommo loss_reason_id is intentionally NOT used here: managers
    // leave it NULL on this account, the custom field is what they actually
    // populate.
    //
    // The +2h state comes from analytics.lead_status_changes. Calls /
    // messages / counts are NOT filtered — that data is shared with other
    // tabs. The gate only suppresses the call-pair from the SLA AVG; the
    // lead row itself is still counted.
    //
    // For B2G this CTE is omitted and the SLA gate is empty (legacy behaviour).
    const isB2B = dept === "b2b";
    // Custom field 876383 enum_ids:
    //   740587 Неквал лид · 740593 Спам · 740595 Предложение сотрудничества
    const B2B_BAD_CLOSE_ENUM_IDS = [740587, 740593, 740595];
    const B2B_PIPELINES_AT_2H = ["Бух Комм", "Мед Комм"];
    const B2B_CLOSED_LOST_STATUSES = ["Closed - lost", "Закрыто и не реализовано"];
    const slaEligibilityCte = isB2B
      ? `,
      sla_eligibility AS (
        SELECT
          fl.lead_id,
          COALESCE(sc.pipeline, lc_full.pipeline) AS pipeline_at_plus2h,
          COALESCE(sc.status,   lc_full.status)   AS status_at_plus2h,
          lc_full.b2b_close_reason_enum_id        AS close_reason_enum_id
        FROM filtered_leads fl
        JOIN analytics.sla s          ON s.lead_id = fl.lead_id
        JOIN analytics.leads_cohort lc_full ON lc_full.lead_id = fl.lead_id
        LEFT JOIN LATERAL (
          SELECT pipeline, status
          FROM analytics.lead_status_changes lsc
          WHERE lsc.lead_id = fl.lead_id
            AND lsc.event_at <= s.first_call_out_at + INTERVAL '2 hours'
          ORDER BY lsc.event_at DESC
          LIMIT 1
        ) sc ON TRUE
        WHERE s.first_call_out_at IS NOT NULL
      )
    `
      : "";
    const slaEligibilityJoin = isB2B
      ? `LEFT JOIN sla_eligibility sle ON sle.lead_id = fl.lead_id`
      : "";
    // SQL fragment usable inside an existing WHERE/CASE WHEN — leading "AND".
    // Drops the lead-call pair only when (closed-lost-at-+2h AND reason in
    // junk set). NULL close_reason_enum_id is treated as «not junk» → kept,
    // matching user's «по любой причине, кроме …» semantics. Pipeline-at-+2h
    // arm stays (must be in B2B funnels at the 2h checkpoint).
    const slaEligibilityCondition = isB2B
      ? `
          AND sle.pipeline_at_plus2h IN (${B2B_PIPELINES_AT_2H.map((p) => `'${esc(p)}'`).join(", ")})
          AND NOT (
            sle.status_at_plus2h IN (${B2B_CLOSED_LOST_STATUSES.map((s) => `'${esc(s)}'`).join(", ")})
            AND sle.close_reason_enum_id IN (${B2B_BAD_CLOSE_ENUM_IDS.join(", ")})
          )
        `
      : "";

    // Looker cohort views aggregate calls PER LEAD via JOIN on lead_id.
    // Post enrich-telephony-leads (2026-04-28) telephony rows are fanned out
    // to one row per linked lead via Kommo phone→contact resolution, so they
    // participate in this aggregation just like Kommo-source rows do. Phones
    // Kommo couldn't resolve stay lead_id=NULL and are correctly excluded —
    // they show up only in Daily/Звонки's dept-totals (which include
    // pipeline_id=NULL fallback).
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
      //
      // Shift hour precedence:
      //   1. manager_schedule.shift_start_time for the lead's Berlin date (per-day override)
      //   2. master_managers.shift_start_time (manager's default)
      //   3. 9 (fallback)
      // Both SLA columns exclude leads without an outgoing call.
      //
      // For dept=b2b, SLA averaging is gated by sla_eligibility (see CTE
      // above): a lead-call pair must be in {Бух Комм, Мед Комм} at +2h and
      // not closed-as-junk to count toward SLA. lead_count / outgoing_calls /
      // messages / success_pct intentionally stay unfiltered — they reflect
      // the same cohort the rest of the dashboard sees.
      mainQuery = `
        WITH ${filteredLeadsCte},
        ${commAggCte},
        ${scheduleOverridesCte}${slaEligibilityCte}
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
                  ${slaEligibilityCondition}
                 THEN EXTRACT(EPOCH FROM (s.first_call_out_at - s.sla_start))
            END
          )) AS avg_sla_lead_to_call_sec,
          ROUND(AVG(
            CASE WHEN s.first_call_out_at IS NOT NULL
                  ${slaEligibilityCondition}
                 THEN GREATEST(0, EXTRACT(EPOCH FROM (
                   s.first_call_out_at
                   - GREATEST(
                       s.sla_start,
                       date_trunc('day', s.sla_start) + (${effectiveShiftHourExpr}) * INTERVAL '1 hour'
                     )
                 )))
            END
          )) AS avg_sla_from_shift_sec,
          COUNT(*) FILTER (
            WHERE s.first_call_out_at IS NOT NULL ${slaEligibilityCondition}
          ) AS sla_lead_count
        FROM filtered_leads fl
        LEFT JOIN comm_agg ca ON ca.lead_id = fl.lead_id
        LEFT JOIN analytics.sla s ON s.lead_id = fl.lead_id
        ${slaEligibilityJoin}
        LEFT JOIN schedule_overrides so
          ON so.manager_name = fl.manager
         AND so.schedule_date = s.sla_start::date
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
      // Each slice can be "none" — UI sends it when the user picks "—" in
      // the срез dropdown. NULL is projected for that paramN, the column is
      // dropped from GROUP BY, and the client hides the column entirely.
      // All three "none" → no GROUP BY → single aggregate row for the
      // selected window.
      const projectSlice = (slice: string, n: number): string =>
        slice === "none"
          ? `NULL::text AS param${n}`
          : `COALESCE(fl.${slice}::text, '—') AS param${n}`;
      const groupCols = [slice1, slice2, slice3]
        .filter((s) => s !== "none")
        .map((s) => `fl.${s}`);
      const groupByClause = groupCols.length > 0 ? `GROUP BY ${groupCols.join(", ")}` : "";

      mainQuery = `
        WITH ${tltFilteredLeadsCte},
        ${commAggCte},
        ${callGapsCte}
        SELECT
          ${projectSlice(slice1, 1)},
          ${projectSlice(slice2, 2)},
          ${projectSlice(slice3, 3)},
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
        ${groupByClause}
        ORDER BY lead_count DESC
      `;
      countQuery = mainQuery;
    } else if (view === "cohorts_detail") {
      // Per-lead drill-down for ONE manager — surfaces every lead in their
      // cohort with its SLA, call counts, and a Kommo deep-link so the user
      // can click on the worst-SLA row and inspect the actual deal. Used by
      // the inline expand on the Cohorts table.
      //
      // The manager param is REQUIRED — without it the query would return
      // every lead in the dept and the UI would render an unbounded list.
      // Status name comes from leads_cohort directly (already canonicalised
      // by the integrator's mirror).
      if (!normalisedManagerParam) {
        return NextResponse.json(
          { error: "manager param required for cohorts_detail view" },
          { status: 400 },
        );
      }
      // For B2B, surface a per-lead `is_sla_eligible` flag so the user can
      // see which leads are counted toward the cohort SLA average and which
      // were filtered out. The lead row itself is still shown — only the SLA
      // numbers are blanked when ineligible.
      const eligibilityFlagExpr = isB2B
        ? `CASE
             WHEN s.first_call_out_at IS NULL THEN NULL
             WHEN sle.pipeline_at_plus2h IN (${B2B_PIPELINES_AT_2H.map((p) => `'${esc(p)}'`).join(", ")})
              AND NOT (
                sle.status_at_plus2h IN (${B2B_CLOSED_LOST_STATUSES.map((s) => `'${esc(s)}'`).join(", ")})
                AND sle.close_reason_enum_id IN (${B2B_BAD_CLOSE_ENUM_IDS.join(", ")})
              )
             THEN TRUE
             ELSE FALSE
           END`
        : `TRUE`;
      mainQuery = `
        WITH ${filteredLeadsCte},
        ${commAggCte}${slaEligibilityCte}
        SELECT
          fl.lead_id,
          fl.created_at AS lead_created_at,
          (SELECT lc.status FROM analytics.leads_cohort lc WHERE lc.lead_id = fl.lead_id LIMIT 1) AS current_status,
          (SELECT lc.pipeline FROM analytics.leads_cohort lc WHERE lc.lead_id = fl.lead_id LIMIT 1) AS pipeline,
          s.first_call_out_at,
          s.sla_first_call_seconds,
          s.sla_first_call_calendar_seconds,
          s.sla_first_call_from_shift_seconds,
          COALESCE(ca.total_calls, 0) AS total_calls,
          COALESCE(ca.success_calls, 0) AS success_calls,
          COALESCE(ca.outgoing_calls, 0) AS outgoing_calls,
          COALESCE(ca.messages_sent, 0) AS messages_sent,
          ca.avg_duration_sec,
          ${eligibilityFlagExpr} AS is_sla_eligible
        FROM filtered_leads fl
        LEFT JOIN comm_agg ca ON ca.lead_id = fl.lead_id
        LEFT JOIN analytics.sla s ON s.lead_id = fl.lead_id
        ${slaEligibilityJoin}
        ORDER BY
          -- worst SLA first (NULL = no call yet, also worth showing — push to bottom)
          s.sla_first_call_seconds DESC NULLS LAST,
          ca.total_calls DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;
      countQuery = `
        WITH ${filteredLeadsCte}
        SELECT COUNT(*) AS count FROM filtered_leads
      `;
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
    if (view === "detail" || view === "tlt_detail" || view === "cohorts_detail") {
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
