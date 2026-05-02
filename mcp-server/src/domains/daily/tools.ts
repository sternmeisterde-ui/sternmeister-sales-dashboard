/**
 * daily.* — план-факт-отчёт по периодам, с упрощённой моделью для Phase 2b.
 *
 * Phase 2b scope (3 tools):
 *   - daily.plan_vs_fact   — план vs факт для одной метрики (любая из daily_plans.metric_key)
 *   - daily.refusals       — топ причин закрытия (B2G non_qual_enum_id, B2B b2b_close_reason_enum_id)
 *   - daily.list_metrics   — какие metric_key есть в daily_plans для отдела
 *
 * Phase 3 расширение: get_snapshot полного DailySnapshot через reuse
 * buildDailyResponse — требует адаптации Next.js path-aliases в workspace.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { d1, dashSchema, analytics, analyticsSchema } from "../../db/connections.js";
import { registerTool } from "../../registry/builder.js";
import { berlinDayBoundaryHalfOpen } from "../../utils/berlin.js";

const { dailyPlans } = dashSchema;
const { leadsCohort, refusalEnums } = analyticsSchema;

const Dept = z.enum(["b2g", "b2b"]);
const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PeriodType = z.enum(["day", "week", "month"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerDailyDomain(server: McpServer): void {
  // ─── daily.list_metrics ────────────────────────────────────────────────────
  registerTool(server, {
    name: "daily.list_metrics",
    description: `Какие metric_key есть в daily_plans для отдела. Используй ДО plan_vs_fact чтобы понять что можно спросить.`,
    inputShape: {
      dept: Dept,
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept }) => {
      const rows = await d1
        .select({
          metric_key: dailyPlans.metricKey,
          line: dailyPlans.line,
          period_type: dailyPlans.periodType,
          plan_count: sql<number>`COUNT(*)::int`,
        })
        .from(dailyPlans)
        .where(eq(dailyPlans.department, dept))
        .groupBy(dailyPlans.metricKey, dailyPlans.line, dailyPlans.periodType)
        .orderBy(dailyPlans.line, dailyPlans.metricKey);
      return { dept, count: rows.length, rows };
    },
  });

  // ─── daily.plan_vs_fact ────────────────────────────────────────────────────
  registerTool(server, {
    name: "daily.plan_vs_fact",
    description: `План vs факт для одной метрики из daily_plans. Возвращает: plans[] (все строки плана для метрики/периода), fact (value+how) если metric_key ∈ {qual_leads, qualLeads, leads, leads_count}, иначе fact: null с notes-полем. Используй после daily.list_metrics чтобы убедиться что metric_key реально существует.`,
    inputShape: {
      dept: Dept,
      metric_key: z.string().describe("Имя метрики (см. daily.list_metrics)"),
      period_type: PeriodType,
      period_date: z.string().describe("Дата периода: 'YYYY-MM-DD' (day), 'YYYY-WNN' (week), 'YYYY-MM' (month)"),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, metric_key, period_type, period_date }) => {
      // Pull plan rows (line-level + per-manager).
      const plans = await d1
        .select({
          line: dailyPlans.line,
          user_id: dailyPlans.userId,
          plan_value: dailyPlans.planValue,
        })
        .from(dailyPlans)
        .where(
          and(
            eq(dailyPlans.department, dept),
            eq(dailyPlans.metricKey, metric_key),
            eq(dailyPlans.periodType, period_type),
            eq(dailyPlans.periodDate, period_date),
          ),
        );

      // Fact computation depends on metric. Phase 2b — compute only when we
      // know how. Otherwise return plans only.
      const fact = await tryComputeFact({
        dept,
        metric_key,
        period_type,
        period_date,
      });

      return {
        dept,
        metric_key,
        period_type,
        period_date,
        plans,
        fact,
        notes: fact === null
          ? "Phase 2b считает факт только для qual_leads / qualLeads / leads / leads_count. Phase 3 расширит на все daily_plans метрики через reuse buildDailyResponse."
          : undefined,
      };
    },
  });

  // ─── daily.refusals ────────────────────────────────────────────────────────
  registerTool(server, {
    name: "daily.refusals",
    description: `Топ причин отказа за период. B2G — analytics.leads_cohort.non_qual_enum_id (Kommo field 879824). B2B — b2b_close_reason_enum_id (Kommo field 876383). Резолв через analytics.refusal_enums. WARNING: B2B field 876383 пока не синкается ETL'ом — для b2b enum_value будет (unresolved). Используй для "почему лиды не доходят?".`,
    inputShape: {
      dept: Dept,
      from: ISODate,
      to: ISODate,
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, from, to }) => {
      const range = berlinDayBoundaryHalfOpen(from, to);
      const enumColumn = dept === "b2g" ? leadsCohort.nonQualEnumId : leadsCohort.b2bCloseReasonEnumId;
      const fieldId = dept === "b2g" ? 879824 : 876383;

      // LEFT JOIN on enum_id only — refusal_enums.enum_id is the PK
      // (globally unique across Kommo fields), so adding field_id as a
      // join predicate over-constrains and silently drops labels for
      // fields that aren't yet populated in the lookup table (B2B 876383
      // is a known case — see src/lib/etl/lookups.ts:14).
      const rows = await analytics
        .select({
          enum_id: enumColumn,
          enum_value: refusalEnums.value,
          enum_field_id: refusalEnums.fieldId,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(leadsCohort)
        .leftJoin(refusalEnums, eq(refusalEnums.enumId, enumColumn))
        .where(
          and(
            isNotNull(enumColumn),
            gte(leadsCohort.createdAt, range.fromExpr),
            lt(leadsCohort.createdAt, range.toExclusiveExpr),
          ),
        )
        .groupBy(enumColumn, refusalEnums.value, refusalEnums.fieldId)
        .orderBy(desc(sql`COUNT(*)`))
        .limit(20);

      return {
        dept,
        period: { from, to },
        kommo_field_id: fieldId,
        rows: rows.map((r) => ({
          enum_id: r.enum_id,
          enum_value: r.enum_value ?? `(unresolved enum_id ${r.enum_id})`,
          enum_field_id: r.enum_field_id,
          count: r.count,
        })),
      };
    },
  });
}

interface FactArgs {
  dept: "b2g" | "b2b";
  metric_key: string;
  period_type: "day" | "week" | "month";
  period_date: string;
}

async function tryComputeFact(args: FactArgs): Promise<{ value: number; how: string } | null> {
  const { dept, metric_key, period_date, period_type } = args;
  // Map period_date → date range. day = exact day; month = full month; week
  // = ISO week (W01–W52). For week we approximate by parsing W##.
  const range = parsePeriodRange(period_type, period_date);
  if (!range) return null;
  const berlinRange = berlinDayBoundaryHalfOpen(range.from, range.to);

  // Only a few well-known metric_keys are computed inline. Anything else —
  // null so the caller knows to defer to Daily UI.
  if (metric_key === "qual_leads" || metric_key === "qualLeads") {
    const result = await analytics
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(leadsCohort)
      .where(
        and(
          gte(leadsCohort.createdAt, berlinRange.fromExpr),
          lt(leadsCohort.createdAt, berlinRange.toExclusiveExpr),
          // qual_leads ≈ leads без non_qual_enum_id (B2G) или с payment (B2B).
          dept === "b2g"
            ? sql`${leadsCohort.nonQualEnumId} IS NULL`
            : isNotNull(leadsCohort.firstPaymentDate),
        ),
      );
    return {
      value: result[0]?.count ?? 0,
      how:
        dept === "b2g"
          ? "leads_cohort WHERE created_at∈range AND non_qual_enum_id IS NULL (упрощение Phase 2b)"
          : "leads_cohort WHERE created_at∈range AND first_payment_date IS NOT NULL",
    };
  }

  if (metric_key === "leads" || metric_key === "leads_count") {
    const result = await analytics
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(leadsCohort)
      .where(
        and(
          gte(leadsCohort.createdAt, berlinRange.fromExpr),
          lt(leadsCohort.createdAt, berlinRange.toExclusiveExpr),
        ),
      );
    return {
      value: result[0]?.count ?? 0,
      how: "COUNT(leads_cohort) WHERE created_at∈range",
    };
  }

  return null;
}

function parsePeriodRange(
  type: "day" | "week" | "month",
  date: string,
): { from: string; to: string } | null {
  if (type === "day") {
    if (!ISO_DATE_RE.test(date)) return null;
    return { from: date, to: date };
  }
  if (type === "month") {
    const m = date.match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return {
      from: `${m[1]}-${m[2]}-01`,
      to: `${m[1]}-${m[2]}-${String(lastDay).padStart(2, "0")}`,
    };
  }
  // Week: 'YYYY-WNN'. ISO week 1 = week with Jan 4. Approx using simple math.
  const m = date.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const w = Number(m[2]);
  // Get the date of the first Monday of week 1.
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // 1 = Mon, 7 = Sun
  const firstMon = new Date(Date.UTC(y, 0, 4 - jan4Day + 1));
  const monday = new Date(firstMon);
  monday.setUTCDate(firstMon.getUTCDate() + (w - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    from: monday.toISOString().slice(0, 10),
    to: sunday.toISOString().slice(0, 10),
  };
}
