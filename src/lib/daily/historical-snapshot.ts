// Historical snapshot reconstruction for past Daily dates.
//
// The Daily tab's funnel metrics (A2/B1/B2+, Бератер termDC/AA, Доведение,
// appeals, awaitTerm, etc.) are "snapshot" metrics — they reflect the pipeline
// state AT a point in time. For today's view that's just the current
// leads_cohort state. For past dates we need to reconstruct what each lead's
// status was on that date.
//
// Source of truth: analytics.lead_status_changes — event log of every
// (lead_id, pipeline_id, status_id, event_at) transition from the ETL. For
// a given asOf timestamp we pick the last transition per lead with
// event_at <= asOf, then join leads_cohort to filter out leads that didn't
// yet exist OR were already closed.
//
// Cached at day-granularity with 24 h TTL because, for any date strictly in
// the past, the historical snapshot never changes. Today's partial view
// goes through the live getAnalyticsLeads path instead.

import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";
import { cached } from "@/lib/kommo/cache";
import type { KommoLead } from "@/lib/kommo/types";

const HISTORICAL_TTL_PAST = 24 * 60 * 60 * 1000;
const HISTORICAL_TTL_RECENT = 5 * 60 * 1000;

interface HistoricalRow {
  lead_id: number | string;
  pipeline_id: number | string | null;
  status_id: number | string | null;
  created_at: Date | string | null;
  closed_at: Date | string | null;
  responsible_user_id: number | string | null;
  category: string | null;
  non_qual_enum_id: number | string | null;
  loss_reason_id: number | string | null;
}

export interface HistoricalSnapshot {
  /** Leads alive (created ≤ asOf, not closed by asOf) with their historical
   *  pipeline_id + status_id. Cast to the KommoLead shape for plug-in
   *  compatibility with getFunnelFact and downstream filters. */
  leads: KommoLead[];
  /** per-responsible_user_id count, for per-manager funnel rows. */
  perUser: Map<number, number>;
}

/** Reconstruct leads_cohort state as it was at asOfTs, scoped to pipelineIds.
 *  Returns leads with their *historical* status (from lead_status_changes),
 *  which is what the Daily funnel metrics need for past-date views. */
export async function reconstructSnapshotAt(
  asOfTs: number,
  pipelineIds: number[],
): Promise<HistoricalSnapshot> {
  if (pipelineIds.length === 0) return { leads: [], perUser: new Map() };
  const dayKey = new Date(asOfTs * 1000).toISOString().slice(0, 10);
  const pipelineKey = [...pipelineIds].sort().join(",");
  const nowSec = Math.floor(Date.now() / 1000);
  // Only freeze the cache for strictly-past dates. Today's "end of day" may
  // still be moving (users creating/closing leads) so refresh every 5 min.
  const ttl = asOfTs < nowSec - 24 * 60 * 60 ? HISTORICAL_TTL_PAST : HISTORICAL_TTL_RECENT;
  const cacheKey = `historical-snapshot:${dayKey}:${pipelineKey}`;
  return cached(cacheKey, ttl, () => fetchSnapshotAt(asOfTs, pipelineIds));
}

async function fetchSnapshotAt(
  asOfTs: number,
  pipelineIds: number[],
): Promise<HistoricalSnapshot> {
  const asOf = new Date(asOfTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);

  // Last status change per lead with event_at <= asOf — this is the
  // "status as of date" reconstruction. DISTINCT ON is the cheapest way
  // in Postgres when backed by an index on (lead_id, event_at DESC) — the
  // existing `lead_status_changes_lead_id_event_at_index` suffices.
  //
  // We then join leads_cohort to (a) drop leads not yet created at asOf
  // and (b) drop leads already closed before asOf, and to pull the
  // additional fields downstream filters need (category, non_qual,
  // responsible_user_id, loss_reason_id).
  const result = await (analyticsDb as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<HistoricalRow>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (lead_id)
        lead_id,
        pipeline_id,
        status_id
      FROM analytics.lead_status_changes
      WHERE event_at <= ${asOf}
        AND pipeline_id IN (${pipelineList})
      ORDER BY lead_id, event_at DESC
    )
    SELECT
      lc.lead_id                AS lead_id,
      latest.pipeline_id        AS pipeline_id,
      latest.status_id          AS status_id,
      lc.created_at             AS created_at,
      lc.closed_at              AS closed_at,
      lc.responsible_user_id    AS responsible_user_id,
      lc.category               AS category,
      lc.non_qual_enum_id       AS non_qual_enum_id,
      lc.loss_reason_id         AS loss_reason_id
    FROM latest
    JOIN analytics.leads_cohort lc USING (lead_id)
    WHERE lc.created_at <= ${asOf}
      AND (lc.closed_at IS NULL OR lc.closed_at > ${asOf})
  `);

  const perUser = new Map<number, number>();
  const leads: KommoLead[] = [];
  for (const row of result.rows) {
    const pid = row.pipeline_id != null ? Number(row.pipeline_id) : 0;
    const sid = row.status_id != null ? Number(row.status_id) : 0;
    const uid = row.responsible_user_id != null ? Number(row.responsible_user_id) : 0;
    const createdAtSec = row.created_at instanceof Date
      ? Math.floor(row.created_at.getTime() / 1000)
      : row.created_at ? Math.floor(new Date(row.created_at).getTime() / 1000) : 0;
    // closed_at is forced to null because these leads are ALIVE at asOf by
    // construction (SQL WHERE guarantees `closed_at IS NULL OR closed_at >
    // asOf`). Existing funnel filters test `!l.closed_at` to mean "open" —
    // if we emitted a future timestamp here, they'd treat the lead as
    // closed and under-count active status buckets.
    void row.closed_at;

    // KommoLead shape — only the fields Daily's getFunnelFact + funnel
    // filters actually read. `updated_at` is synthetic (= created_at)
    // because the mirror doesn't store a historical update timestamp;
    // any flow-metric that depends on the exact touch time is an
    // approximation for past dates.
    const customFields: NonNullable<KommoLead["custom_fields_values"]> = [];
    if (row.category) {
      customFields.push({
        field_id: 866934,
        field_name: "Category",
        field_code: null,
        field_type: "select",
        values: [{ value: row.category }],
      });
    }
    if (row.non_qual_enum_id != null) {
      customFields.push({
        field_id: 879824,
        field_name: "Причина закрытия Госники",
        field_code: null,
        field_type: "select",
        values: [{ value: "", enum_id: Number(row.non_qual_enum_id) }],
      });
    }
    leads.push({
      id: Number(row.lead_id),
      pipeline_id: pid,
      status_id: sid,
      created_at: createdAtSec,
      updated_at: createdAtSec,
      closed_at: null,
      is_deleted: false,
      responsible_user_id: uid,
      price: 0,
      loss_reason_id: row.loss_reason_id != null ? Number(row.loss_reason_id) : null,
      custom_fields_values: customFields.length > 0 ? customFields : null,
    } as unknown as KommoLead);

    if (uid) perUser.set(uid, (perUser.get(uid) ?? 0) + 1);
  }

  return { leads, perUser };
}
