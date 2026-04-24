// SQL-based B2B commercial fact queries against analytics.leads_cohort.
// Replaces the Kommo-live `computeB2BCommercialFacts` + `filterB2BQualLeads`
// path with pure Postgres queries so Daily Commerce opens instantly.
//
// Prerequisite: scripts/backfill-analytics.ts must have populated:
//   - first_payment_date / first_payment_amount
//   - prepayment_date / prepayment_amount
//   - loss_reason / loss_reason_id
//   - pipeline_id / status_id / created_at
// for the full reporting window.

import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";
import { B2B_PIPELINES, COMMERCIAL_STATUSES, B2B_WON_STATUSES_PER_PIPELINE } from "@/lib/kommo/pipeline-config";

export interface B2BPipelineStats {
  /** SUM(Сумма 1-го платежа where Факт.Дата ∈ period) + SUM(Сумма предоплаты where Дата пред ∈ period). */
  revenue: number;
  /** COUNT(leads where Факт.Дата 1-го платежа ∈ period). */
  salesCount: number;
  /** COUNT(leads where Дата предоплаты ∈ period). */
  prepaymentCount: number;
  /** COUNT(leads created ∈ period). */
  totalLeads: number;
  /** COUNT(leads created ∈ period minus Incoming minus lost(Неквал/Спам)). */
  qualLeads: number;
}

type Row = {
  revenue: number | string | null;
  sales_count: number | string;
  prepayment_count: number | string;
  total_leads: number | string;
  qual_leads: number | string;
};

/** Team-level pipeline stats for Bух Комм (10631243). Single round-trip. */
export async function getB2BPipelineStatsSQL(
  pipelineId: number,
  fromDate: Date,
  toDate: Date,
): Promise<B2BPipelineStats> {
  // "Incoming" status only applies to Бух (not to Medical).
  const excludeIncoming = pipelineId === B2B_PIPELINES.COMMERCIAL;
  const incomingFilter = excludeIncoming
    ? sql`AND status_id <> ${COMMERCIAL_STATUSES.INCOMING}`
    : sql``;

  // WON-family status_ids for this pipeline (sales / revenue filter).
  const wonStatuses = B2B_WON_STATUSES_PER_PIPELINE[pipelineId] ?? [142];
  const wonStatusList = sql.join(wonStatuses.map((s) => sql`${s}`), sql`, `);

  // Revenue = SUM(first_payment_amount) + SUM(prepayment_amount), ignoring NULLs.
  // lead.price is NOT used as fallback here — the ETL already wrote custom-field
  // values; if they're missing, the lead genuinely has no recorded payment yet.
  //
  // qual_leads per user spec:
  //   "квал = есть буква в Category (CFV[866934])" — т.е. A/B/C/D/E.
  //   Non-qual = category IS NULL.
  //   Дополнительно исключаем status=Incoming (только Бух, для совместимости с ТЗ).
  const result = await (analyticsDb as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<Row>(sql`
    WITH in_period AS (
      SELECT lead_id, status_id, category
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${pipelineId}
        AND created_at >= ${fromDate}
        AND created_at <= ${toDate}
    ),
    -- Payment counts/sums are restricted to WON-family statuses per Excel
    -- verification (R32 Apr: 20 с фильтром vs 26 без — Excel = 18). Included:
    --   142 WON, 82946495 Предоплата получена, 82946499 Рассрочка.
    -- Leads with first_payment_date but in other statuses (e.g. Счёт выставлен,
    -- ИНТЕРЕС ПОДТВЕРЖДЕН, closed-lost с возвратом) НЕ считаются продажами.
    -- Payments: restrict to WON-family statuses AND require non-null/positive
    -- prepayment amount (fixes false +1 where prepayment_date is set but amount
    -- is NULL — observed on Medical lead 18790160 Apr 2026).
    -- Revenue dedup per-lead: if a lead has BOTH first_payment and prepayment
    -- dates in the window, we only count first_payment (it's the headline
    -- amount; prepayment is a partial that rolls up into it). Excel verification
    -- confirmed this semantic (Medical Apr: 3500+558=4058, not 4447).
    payments AS (
      SELECT
        COALESCE(SUM(first_payment_amount) FILTER (
          WHERE first_payment_date >= ${fromDate} AND first_payment_date <= ${toDate}
            AND status_id IN (${wonStatusList})
        ), 0) AS first_sum,
        COUNT(*) FILTER (
          WHERE first_payment_date >= ${fromDate} AND first_payment_date <= ${toDate}
            AND status_id IN (${wonStatusList})
        ) AS first_count,
        COALESCE(SUM(prepayment_amount) FILTER (
          WHERE prepayment_date >= ${fromDate} AND prepayment_date <= ${toDate}
            AND status_id IN (${wonStatusList})
            AND prepayment_amount IS NOT NULL AND prepayment_amount > 0
            AND (first_payment_date IS NULL
                 OR first_payment_date < ${fromDate}
                 OR first_payment_date > ${toDate})
        ), 0) AS prepay_sum,
        COUNT(*) FILTER (
          WHERE prepayment_date >= ${fromDate} AND prepayment_date <= ${toDate}
            AND status_id IN (${wonStatusList})
            AND prepayment_amount IS NOT NULL AND prepayment_amount > 0
        ) AS prepay_count
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${pipelineId}
    )
    SELECT
      (p.first_sum + p.prepay_sum)::double precision AS revenue,
      p.first_count::int                             AS sales_count,
      p.prepay_count::int                            AS prepayment_count,
      (SELECT COUNT(*)::int FROM in_period)          AS total_leads,
      -- Квал = category ∈ {A,B,C,D}. E и NULL = не квал (per user spec 2026-04-24).
      -- Проверено на апреле 2026: A/B/C/D = 395 (близко к реальности), E = мусорная
      -- категория где почти все имеют "Неквал"-reason.
      (
        SELECT COUNT(*)::int FROM in_period ip
        WHERE UPPER(TRIM(COALESCE(ip.category, ''))) IN ('A','B','C','D')
          ${incomingFilter}
      ) AS qual_leads
    FROM payments p
  `);

  const row = result.rows[0];
  if (!row) {
    return { revenue: 0, salesCount: 0, prepaymentCount: 0, totalLeads: 0, qualLeads: 0 };
  }

  return {
    revenue: Number(row.revenue ?? 0),
    salesCount: Number(row.sales_count ?? 0),
    prepaymentCount: Number(row.prepayment_count ?? 0),
    totalLeads: Number(row.total_leads ?? 0),
    qualLeads: Number(row.qual_leads ?? 0),
  };
}

/**
 * Per-manager breakdown of the same stats. Keyed by responsible_user_id.
 * Kept as a separate query so the team-level call stays trivially fast.
 */
export async function getB2BPerManagerStatsSQL(
  pipelineId: number,
  fromDate: Date,
  toDate: Date,
): Promise<Map<number, B2BPipelineStats>> {
  const excludeIncoming = pipelineId === B2B_PIPELINES.COMMERCIAL;
  const incomingFilter = excludeIncoming
    ? sql`AND status_id <> ${COMMERCIAL_STATUSES.INCOMING}`
    : sql``;
  const wonStatuses = B2B_WON_STATUSES_PER_PIPELINE[pipelineId] ?? [142];
  const wonStatusList = sql.join(wonStatuses.map((s) => sql`${s}`), sql`, `);

  type PerMgrRow = {
    responsible_user_id: number | string;
    revenue: number | string | null;
    sales_count: number | string;
    prepayment_count: number | string;
    total_leads: number | string;
    qual_leads: number | string;
  };

  // One CTE per metric family so joins are simple. Group by responsible_user_id.
  const result = await (analyticsDb as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<PerMgrRow>(sql`
    WITH created AS (
      SELECT responsible_user_id, lead_id, status_id, category
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${pipelineId}
        AND created_at >= ${fromDate}
        AND created_at <= ${toDate}
    ),
    sold AS (
      SELECT
        responsible_user_id,
        COALESCE(SUM(first_payment_amount), 0) AS first_sum,
        COUNT(*) AS first_count
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${pipelineId}
        AND first_payment_date >= ${fromDate}
        AND first_payment_date <= ${toDate}
        AND status_id IN (${wonStatusList})
      GROUP BY responsible_user_id
    ),
    prepaid AS (
      SELECT
        responsible_user_id,
        COALESCE(SUM(prepayment_amount), 0) AS prepay_sum,
        COUNT(*) AS prepay_count
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${pipelineId}
        AND prepayment_date >= ${fromDate}
        AND prepayment_date <= ${toDate}
        AND status_id IN (${wonStatusList})
        AND prepayment_amount IS NOT NULL AND prepayment_amount > 0
      GROUP BY responsible_user_id
    ),
    qual AS (
      SELECT
        responsible_user_id,
        COUNT(*) AS qual_count
      FROM created
      WHERE UPPER(TRIM(COALESCE(category, ''))) IN ('A','B','C','D')
        ${incomingFilter}
      GROUP BY responsible_user_id
    ),
    total AS (
      SELECT responsible_user_id, COUNT(*) AS total_count
      FROM created
      GROUP BY responsible_user_id
    )
    SELECT
      COALESCE(s.responsible_user_id, p.responsible_user_id, t.responsible_user_id, q.responsible_user_id) AS responsible_user_id,
      COALESCE(s.first_sum, 0) + COALESCE(p.prepay_sum, 0) AS revenue,
      COALESCE(s.first_count, 0)::int  AS sales_count,
      COALESCE(p.prepay_count, 0)::int AS prepayment_count,
      COALESCE(t.total_count, 0)::int  AS total_leads,
      COALESCE(q.qual_count, 0)::int   AS qual_leads
    FROM sold s
    FULL OUTER JOIN prepaid p ON s.responsible_user_id = p.responsible_user_id
    FULL OUTER JOIN total   t ON COALESCE(s.responsible_user_id, p.responsible_user_id) = t.responsible_user_id
    FULL OUTER JOIN qual    q ON COALESCE(s.responsible_user_id, p.responsible_user_id, t.responsible_user_id) = q.responsible_user_id
  `);

  const out = new Map<number, B2BPipelineStats>();
  for (const r of result.rows) {
    const uid = Number(r.responsible_user_id);
    if (!Number.isFinite(uid) || uid === 0) continue;
    out.set(uid, {
      revenue: Number(r.revenue ?? 0),
      salesCount: Number(r.sales_count ?? 0),
      prepaymentCount: Number(r.prepayment_count ?? 0),
      totalLeads: Number(r.total_leads ?? 0),
      qualLeads: Number(r.qual_leads ?? 0),
    });
  }
  return out;
}
