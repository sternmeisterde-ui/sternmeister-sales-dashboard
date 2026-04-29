// Local-DB replacement for src/lib/kommo/client.ts:getLeads() — reads from
// analytics.leads_cohort instead of hitting Kommo API.
//
// Returns KommoLead-shaped objects so existing filter/aggregation code in
// build-response.ts works unchanged. custom_fields_values is always empty
// (we don't mirror the full custom-field payload yet); any downstream code
// that relies on `f.field_id === X` checks falls through the `if (!cf)`
// path which treats the value as "not excluded" — matches conservative
// default when data is missing.

import { analyticsDb } from "@/lib/db/analytics";
import { leadsCohort } from "@/lib/db/schema-analytics";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { KommoLead } from "@/lib/kommo/types";
import { SYNTH_LOSS_REASON_FIELD_ID } from "@/lib/kommo/metrics";
import { cached } from "@/lib/kommo/cache";

export interface AnalyticsLeadsFilter {
  pipelineIds?: number[];
  statusIds?: number[];
  /** active = closed_at IS NULL */
  activeOnly?: boolean;
  dateFilter?: {
    field: "created_at" | "updated_at" | "closed_at";
    from: number;
    to: number;
  };
}

/**
 * Fetch leads from analytics.leads_cohort matching the given filters.
 * Returned rows are mapped to the KommoLead shape so they're drop-in
 * replacements for `getLeads()` results.
 *
 * 60s TTL + in-flight dedup: для /api/daily/range 12 месяцев параллельно
 * запрашивают тот же snapshot (activeOnly=true → 1691 лид) — без дедупа
 * это было 12× одинаковых HTTP-fetch'ей к Neon, что триггерило rate-limit.
 */
export async function getAnalyticsLeads(
  opts: AnalyticsLeadsFilter,
): Promise<KommoLead[]> {
  const cacheKey = `analytics-leads:${JSON.stringify(opts)}`;
  return cached(cacheKey, 60 * 1000, () => fetchAnalyticsLeads(opts));
}

async function fetchAnalyticsLeads(opts: AnalyticsLeadsFilter): Promise<KommoLead[]> {
  const conds = [];
  if (opts.pipelineIds && opts.pipelineIds.length > 0) {
    conds.push(inArray(leadsCohort.pipelineId, opts.pipelineIds));
  }
  if (opts.statusIds && opts.statusIds.length > 0) {
    conds.push(inArray(leadsCohort.statusId, opts.statusIds));
  }
  if (opts.activeOnly) {
    conds.push(isNull(leadsCohort.closedAt));
  }
  if (opts.dateFilter) {
    const fromDate = new Date(opts.dateFilter.from * 1000);
    const toDate = new Date(opts.dateFilter.to * 1000);
    if (opts.dateFilter.field === "created_at") {
      conds.push(gte(leadsCohort.createdAt, fromDate));
      conds.push(lte(leadsCohort.createdAt, toDate));
    } else if (opts.dateFilter.field === "closed_at") {
      conds.push(gte(leadsCohort.closedAt, fromDate));
      conds.push(lte(leadsCohort.closedAt, toDate));
    } else {
      // updated_at not stored — leads_cohort doesn't track this column;
      // fall back to created_at which covers the vast majority of use cases
      // (snapshot fetches in build-response.ts use it only on the "new leads
      // in period" path which matches created_at semantics anyway).
      conds.push(gte(leadsCohort.createdAt, fromDate));
      conds.push(lte(leadsCohort.createdAt, toDate));
    }
  }

  const where = conds.length > 0 ? and(...conds) : undefined;
  const rows = await analyticsDb
    .select()
    .from(leadsCohort)
    .where(where)
    .limit(50000);

  const result: KommoLead[] = rows.map((r) => {
    // Synthesise custom_fields_values so downstream filters work:
    //   field_id=866934 (Category A/B/C/D/E) — new qual logic (per user spec
    //     2026-04-24): lead is qual iff category letter is set.
    //   field_id=879824 (non-qual reason, enum_id) — kept for backwards compat
    //     with legacy B2G per-manager funnel filters.
    const customFields: KommoLead["custom_fields_values"] = [];
    if (r.category && r.category.trim() !== "") {
      customFields.push({
        field_id: 866934,
        field_name: "Category",
        field_code: null,
        field_type: "select",
        values: [{ value: r.category }],
      });
    }
    if (r.nonQualEnumId != null) {
      customFields.push({
        field_id: 879824,
        field_name: "Non-qual reason",
        field_code: null,
        field_type: "select",
        values: [{ value: "", enum_id: Number(r.nonQualEnumId) }],
      });
    }
    // Synth: carry system-level loss_reason text so isQualLead can match
    // "Неквал лид" variants that appear only in the system field (rare, <1%
    // of LOST leads but still important to exclude correctly).
    if (r.lossReason && r.lossReason.trim() !== "") {
      customFields.push({
        field_id: SYNTH_LOSS_REASON_FIELD_ID,
        field_name: "__loss_reason_text",
        field_code: null,
        field_type: "text",
        values: [{ value: r.lossReason }],
      });
    }

    return {
      id: Number(r.leadId ?? 0),
      name: "",
      price: Number(r.budget ?? 0),
      responsible_user_id: Number(r.responsibleUserId ?? 0),
      group_id: 0,
      status_id: Number(r.statusId ?? 0),
      pipeline_id: Number(r.pipelineId ?? 0),
      loss_reason_id: r.lossReasonId != null ? Number(r.lossReasonId) : null,
      created_by: 0,
      updated_by: 0,
      created_at: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : 0,
      updated_at: r.createdAt ? Math.floor(r.createdAt.getTime() / 1000) : 0,
      closed_at: r.closedAt ? Math.floor(r.closedAt.getTime() / 1000) : null,
      closest_task_at: null,
      is_deleted: false,
      custom_fields_values: customFields.length > 0 ? customFields : null,
      score: null,
      account_id: 0,
      _links: { self: { href: "" } },
    };
  });

  return result;
}

export interface AnalyticsCohortStatusRow {
  pipelineId: number;
  pipelineName: string;
  statusId: number;
  statusName: string;
  count: number;
}

/**
 * Cohort status breakdown driven by analytics.leads_cohort directly: leads
 * created in [from, to], grouped by (pipeline_id, status_id), returning the
 * Kommo-side `pipeline` / `status` text columns the ETL already mirrors.
 *
 * Why this exists instead of fetching all rows + resolving names via the Kommo
 * API: getPipelines() can fail or be missing entries (e.g. token rotated, new
 * pipeline not yet present in Kommo cache), and the previous code path then
 * fell back to the literal "Status 12345" string in the dashboard cohort
 * table. Reading names from the same DB row that already carries status_id is
 * always consistent and removes a network dependency.
 */
export async function getAnalyticsCohortStatusBreakdown(
  pipelineIds: number[],
  fromSec: number,
  toSec: number,
): Promise<AnalyticsCohortStatusRow[]> {
  if (pipelineIds.length === 0) return [];
  const cacheKey = `cohort-status:${pipelineIds.slice().sort((a, b) => a - b).join(",")}:${fromSec}:${toSec}`;
  return cached(cacheKey, 60 * 1000, async () => {
    const fromDate = new Date(fromSec * 1000);
    const toDate = new Date(toSec * 1000);
    const res = await (analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }).execute<{
      pipeline_id: number | string;
      pipeline: string | null;
      status_id: number | string;
      status: string | null;
      cnt: number | string;
    }>(sql`
      SELECT pipeline_id, pipeline, status_id, status, COUNT(*)::int AS cnt
      FROM analytics.leads_cohort
      WHERE pipeline_id IN (${sql.join(pipelineIds.map((p) => sql`${p}`), sql`, `)})
        AND created_at >= ${fromDate}
        AND created_at <= ${toDate}
      GROUP BY pipeline_id, pipeline, status_id, status
    `);
    return res.rows.map((r) => ({
      pipelineId: Number(r.pipeline_id),
      pipelineName: r.pipeline ?? `Pipeline ${r.pipeline_id}`,
      statusId: Number(r.status_id),
      statusName: r.status ?? `Status ${r.status_id}`,
      count: Number(r.cnt),
    }));
  });
}

/**
 * analytics.leads_cohort equivalent of getStatusChangeCount() — counts leads
 * that ENTERED one of the given status_ids during the window.
 *
 * Uses analytics.lead_status_changes; exact semantic match for
 * "Термин АА переведены" Daily metric.
 */
export async function getAnalyticsStatusChangeCount(
  fromSec: number,
  toSec: number,
  pipelineId: number,
  statusIds: number[],
): Promise<number> {
  if (statusIds.length === 0) return 0;
  const cacheKey = `status-change:${pipelineId}:${statusIds.join(",")}:${fromSec}:${toSec}`;
  return cached(cacheKey, 60 * 1000, async () => {
    const fromDate = new Date(fromSec * 1000);
    const toDate = new Date(toSec * 1000);
    const res = await (analyticsDb as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> }).execute<{
      cnt: number | string;
    }>(sql`
      SELECT COUNT(DISTINCT lead_id)::int AS cnt
      FROM analytics.lead_status_changes
      WHERE pipeline_id = ${pipelineId}
        AND status_id IN (${sql.join(statusIds.map((s) => sql`${s}`), sql`, `)})
        AND event_at >= ${fromDate}
        AND event_at <= ${toDate}
    `);
    return Number(res.rows[0]?.cnt ?? 0);
  });
}

// re-export for tree-shake clarity
export { or, eq };
