import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";
import { getDeptManagerWhitelist, getDeptScheduleOverrides } from "@/lib/daily/dept-manager-whitelist";

const DEPT_PIPELINES: Record<string, readonly string[]> = {
  // b2g — суперсет всех вертикалей (Бух + Мед). Раньше был только Бух → мед-лиды
  // вообще не показывались в Looker; теперь входят (сужаются тогглом вертикали).
  b2g: ["Бух Гос", "Бух Бератер", "Мед Гос", "Мед Бератер"],
  b2b: ["Бух Комм", "Мед Комм"],
} as const;

// Имена воронок по вертикали (b2g). Совпадают со строками leads_cohort.pipeline.
const B2G_VERTICAL_PIPELINES: Record<"buh" | "med", readonly string[]> = {
  buh: ["Бух Гос", "Бух Бератер"],
  med: ["Мед Гос", "Мед Бератер"],
};

/** Воронки в области видимости для (dept, vertical). Для b2g+buh/med — набор
 *  вертикали; иначе (b2b, либо b2g all/undefined) — весь список отдела. */
function scopedPipelines(dept: string, vertical?: "buh" | "med" | "all"): readonly string[] {
  if (dept === "b2g" && (vertical === "buh" || vertical === "med")) {
    return B2G_VERTICAL_PIPELINES[vertical];
  }
  return DEPT_PIPELINES[dept] ?? [];
}

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

    if (!DEPT_PIPELINES[dept]) {
      return NextResponse.json({ error: "Invalid dept" }, { status: 400 });
    }
    // Вертикаль Бух/Мед/Все — только b2g. Сужает набор воронок; 'all'/отсутствие
    // → все воронки отдела (для b2g это Бух+Мед). См. spec 21 §8.
    const rawVertical = sp.get("vertical");
    const vertical: "buh" | "med" | "all" | undefined =
      dept === "b2g" && (rawVertical === "buh" || rawVertical === "med" || rawVertical === "all")
        ? rawVertical
        : undefined;
    const allowedPipelines = scopedPipelines(dept, vertical);
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
    // Fallback when master_managers.shift_start_time is NULL: B2G defaults to
    // 10 (matches integrator's universal 10:00 shift start for Бух Гос/Бух
    // Бератер); B2B falls back to 9.
    const defaultShiftHour = dept === "b2g" ? 10 : 9;
    const shiftCases: string[] = [];
    for (const [name, hour] of shiftHourByName) {
      shiftCases.push(`WHEN fl.manager = '${esc(name)}' THEN ${hour}`);
    }
    const masterShiftHourExpr = shiftCases.length > 0
      ? `CASE ${shiftCases.join(" ")} ELSE ${defaultShiftHour} END`
      : `${defaultShiftHour}`;
    // End-of-shift hour for the «рабочие часы» SLA clip. Integrator uses 18:00
    // universally on B2G; we hard-code that to match exactly. (No per-manager
    // shift_end_time in master_managers yet — add later when needed.)
    const shiftEndHour = 18;

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

    // ─── SLA eligibility filter (per-pipeline) ────────────────────────────
    // Goal: replicate the integrator's `report_sternmeister_custom_report` /
    // `SLA первого звонка` metric exactly so we can drop the dependency on
    // their feed. Whitelists below were derived empirically by probing
    // 45.156.25.84/db (June 2025–April 2026 window):
    //
    //   pipeline=Бух Гос      → 8 statuses (Квалификатер; closed-lost / Term
    //                           ДЦ / Отложенный старт excluded)
    //   pipeline=Бух Бератер  → 9 statuses (Доведение; closed-lost / Гутшайн
    //                           / Апелляция / Отложенный старт excluded)
    //   pipeline=Бух Комм     → ALL statuses (integrator includes everything)
    //   pipeline=Мед Гос      → 2 statuses (very small cohort)
    //   pipeline=Мед Комм     → integrator has 0 rows; we treat as Бух Комм
    //                           (include all) as a sensible default
    //
    // Status check uses leads_cohort.status (CURRENT status). Drift can occur
    // if a lead's status moves between integrator's snapshot time and our
    // sync — addressable by gating on lead_status_changes at first_call_at.
    const isB2B = dept === "b2b";
    const isB2G = dept === "b2g";
    const needSlaEligibility = isB2B || isB2G;
    const B2G_KVALIFIKATOR_STATUSES = [
      "Недозвон",
      "Документы отправлены в ДЦ",
      "Контакт установлен",
      "Консультация проведена",
      "База",
      "Принимает решение",
      "Новый лид",
      "Взято в работу",
    ];
    const B2G_DOVEDENIE_STATUSES = [
      "Доведение",
      "Термин ДЦ состоялся",
      "Консультация перед термином ДЦ",
      "Термин ДЦ отменен/перенесен",
      "Консультация перед термином АА",
      "Консультация перед термином ДЦ проведена",
      "На рассмотрении бератера",
      "Консультация перед термином АА проведена",
      "Термин АА отменен/перенесен",
    ];
    const B2G_MED_STATUSES = [
      "Закрыто и не реализовано",
      "Консультация проведена",
    ];
    // TLT (Time between Latest Touches) uses different per-pipeline status
    // sets than SLA — defined as BLACKLIST per spec («не учитываются
    // этапы…»). Whitelist for the gate = «pipeline status NOT in blacklist».
    const slaEligibilityCte = needSlaEligibility
      ? `,
      sla_eligibility AS (
        SELECT
          fl.lead_id,
          lc_full.status   AS current_status,
          lc_full.pipeline AS current_pipeline
        FROM filtered_leads fl
        JOIN analytics.sla s          ON s.lead_id = fl.lead_id
        JOIN analytics.leads_cohort lc_full ON lc_full.lead_id = fl.lead_id
        WHERE s.first_call_out_at IS NOT NULL
      )
    `
      : "";
    const slaEligibilityJoin = needSlaEligibility
      ? `LEFT JOIN sla_eligibility sle ON sle.lead_id = fl.lead_id`
      : "";
    // Per-pipeline whitelist matched 1:1 to integrator's metric. The
    // pipeline param can pin to a single pipeline; otherwise we union all
    // dept pipelines' whitelists. Бух Комм / Мед Комм return TRUE always
    // (integrator includes ALL statuses there, no filter).
    const slaEligibilityCondition = (() => {
      if (!needSlaEligibility) return "";
      // For each pipeline in scope, build a "pipeline=X AND (whitelist OR all)" branch.
      const branches: string[] = [];
      // Область = выбранная воронка либо весь vertical-scoped набор отдела.
      const pipelinesInScope = pipelineParam ? [pipelineParam] : allowedPipelines;
      for (const p of pipelinesInScope) {
        let wl: string[] | null = null;
        if (p === "Бух Гос") wl = B2G_KVALIFIKATOR_STATUSES;
        else if (p === "Бух Бератер") wl = B2G_DOVEDENIE_STATUSES;
        else if (p === "Мед Гос") wl = B2G_MED_STATUSES;
        // Бух Комм / Мед Комм / Мед Бератер: wl stays null → match-all
        if (wl === null) {
          branches.push(`(sle.current_pipeline = '${esc(p)}')`);
        } else {
          const list = wl.map((s) => `'${esc(s)}'`).join(", ");
          branches.push(`(sle.current_pipeline = '${esc(p)}' AND sle.current_status IN (${list}))`);
        }
      }
      return `AND (${branches.join(" OR ")})`;
    })();

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
          -- Calendar SLA: prefer integrator's frozen snapshot when present
          -- (matches their Looker dashboard exactly for historical leads),
          -- fall back to our live calc otherwise.
          ROUND(AVG(
            CASE WHEN s.first_call_out_at IS NOT NULL AND s.first_call_out_at > s.sla_start
                  ${slaEligibilityCondition}
                 THEN COALESCE(
                   s.sla_first_call_calendar_seconds_integrator,
                   EXTRACT(EPOCH FROM (s.first_call_out_at - s.sla_start))
                 )
            END
          )) AS avg_sla_lead_to_call_sec,
          -- Working-hours SLA: COALESCE on integrator's exact value when
          -- present (matches Looker per-second), fall back to our computed
          -- shift-anchored formula. Same formula as integrator:
          --   bh = MAX(0, MIN(call, shift_end) - MAX(sla_start, shift_start))
          -- shift = 10:00–18:00 anchored to the CALL day.
          ROUND(AVG(
            CASE WHEN s.first_call_out_at IS NOT NULL
                  ${slaEligibilityCondition}
                 THEN COALESCE(
                   s.sla_first_call_seconds_integrator,
                   GREATEST(0, EXTRACT(EPOCH FROM (
                     LEAST(
                       s.first_call_out_at,
                       date_trunc('day', s.first_call_out_at) + ${shiftEndHour} * INTERVAL '1 hour'
                     )
                     - GREATEST(
                         s.sla_start,
                         date_trunc('day', s.first_call_out_at) + (${effectiveShiftHourExpr}) * INTERVAL '1 hour'
                       )
                   )))
                 )
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
         AND so.schedule_date = s.first_call_out_at::date
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

      // TLT (matches integrator's `report_sternmeister_custom_report`/'TLT')
      // = business_hours_since_last_contact (BH-staleness from last touch).
      // Verified by direct probe: integrator's TLT == bh_since_last_contact
      // - constant_offset (3640s, just the time between their cron ticks).
      //
      // Status whitelist = same per-pipeline set as SLA первого звонка
      // (verified empirically, identical lead sets in custom_report).
      // The user's earlier «два крайних звонка» spec is a DIFFERENT metric
      // tracked in s.tlt_seconds (kept in DB for future use) — not what
      // the integrator computes for the «TLT» dashboard column.
      mainQuery = `
        WITH ${tltFilteredLeadsCte},
        ${commAggCte},
        ${callGapsCte}${slaEligibilityCte}
        SELECT
          ${projectSlice(slice1, 1)},
          ${projectSlice(slice2, 2)},
          ${projectSlice(slice3, 3)},
          COUNT(fl.lead_id) AS lead_count,
          ROUND(AVG(
            CASE WHEN s.last_contact_at IS NOT NULL ${slaEligibilityCondition}
                 THEN COALESCE(s.tlt_integrator, s.business_hours_since_last_contact)
            END
          )) AS avg_tlt,
          ROUND(AVG(cg.avg_gap_sec)) AS avg_gap_sec,
          COALESCE(SUM(ca.outgoing_calls), 0) AS outgoing_calls,
          COALESCE(SUM(ca.messages_sent), 0) AS messages_sent,
          COALESCE(SUM(ca.outgoing_calls), 0) + COALESCE(SUM(ca.messages_sent), 0) AS total_comms
        FROM filtered_leads fl
        LEFT JOIN analytics.sla s ON s.lead_id = fl.lead_id
        LEFT JOIN comm_agg ca ON ca.lead_id = fl.lead_id
        LEFT JOIN call_gaps cg ON cg.lead_id = fl.lead_id
        ${slaEligibilityJoin}
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
      // Same eligibility logic as the cohorts gate, but flipped from
      // WHERE-fragment to a CASE expression that returns TRUE/FALSE per row.
      const eligibilityFlagExpr = needSlaEligibility
        ? (() => {
            const branches: string[] = [];
            const pipelinesInScope = pipelineParam ? [pipelineParam] : allowedPipelines;
            for (const p of pipelinesInScope) {
              let wl: string[] | null = null;
              if (p === "Бух Гос") wl = B2G_KVALIFIKATOR_STATUSES;
              else if (p === "Бух Бератер") wl = B2G_DOVEDENIE_STATUSES;
              else if (p === "Мед Гос") wl = B2G_MED_STATUSES;
              if (wl === null) {
                branches.push(`(sle.current_pipeline = '${esc(p)}')`);
              } else {
                const list = wl.map((s) => `'${esc(s)}'`).join(", ");
                branches.push(`(sle.current_pipeline = '${esc(p)}' AND sle.current_status IN (${list}))`);
              }
            }
            return `CASE
               WHEN s.first_call_out_at IS NULL THEN NULL
               WHEN ${branches.join(" OR ")} THEN TRUE
               ELSE FALSE
             END`;
          })()
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
          COALESCE(s.sla_first_call_seconds_integrator, s.sla_first_call_seconds) AS sla_first_call_seconds,
          COALESCE(s.sla_first_call_calendar_seconds_integrator, s.sla_first_call_calendar_seconds) AS sla_first_call_calendar_seconds,
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
          COALESCE(s.tlt_integrator, s.business_hours_since_last_contact) AS tlt,
          COALESCE(ca.outgoing_calls, 0) AS outgoing_calls,
          COALESCE(ca.messages_sent, 0) AS messages_sent,
          COALESCE(ca.outgoing_calls, 0) + COALESCE(ca.messages_sent, 0) AS total_comms,
          ROUND(cg.avg_gap_sec) AS avg_gap_sec
        FROM filtered_leads fl
        LEFT JOIN analytics.sla s ON s.lead_id = fl.lead_id
        LEFT JOIN comm_agg ca ON ca.lead_id = fl.lead_id
        LEFT JOIN call_gaps cg ON cg.lead_id = fl.lead_id
        ORDER BY tlt DESC NULLS LAST
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
