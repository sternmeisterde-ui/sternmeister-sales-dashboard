// ETL: sync lead_status_changes from Kommo Events API
// After insert, runs SQL to compute:
//   last_event_at, next_status_id, next_event_at

import { getStatusChangeEvents } from "@/lib/kommo/client";
import { analyticsDb } from "@/lib/db/analytics";
import { leadStatusChanges } from "@/lib/db/schema-analytics";
import { sql } from "drizzle-orm";
import type { LeadCacheEntry } from "./sync-leads";
import type { KommoLookups } from "./lookups";

const AMO_DOMAIN = "sternmeister.kommo.com";

export async function syncStatusChanges(
  fromDate: Date,
  toDate: Date,
  leadCache: LeadCacheEntry[],
  lookups: KommoLookups,
): Promise<number> {
  const fromTs = Math.floor(fromDate.getTime() / 1000);
  const toTs = Math.floor(toDate.getTime() / 1000);

  const events = await getStatusChangeEvents(fromTs, toTs);
  console.log(`[ETL] status-changes: ${events.length} events`);

  if (events.length === 0) return 0;

  const leadMap = new Map(leadCache.map((e) => [e.leadId, e]));

  type Row = typeof leadStatusChanges.$inferInsert;
  const rows: Row[] = [];

  for (const ev of events) {
    const lead = leadMap.get(ev.leadId);
    const pipeline = lookups.pipelines.get(ev.afterPipelineId);
    const status = pipeline?.statuses.get(ev.afterStatusId);

    rows.push({
      amoDomain: AMO_DOMAIN,
      leadId: ev.leadId,
      pipelineId: ev.afterPipelineId,
      pipeline: pipeline?.name ?? String(ev.afterPipelineId),
      statusId: ev.afterStatusId,
      status: status?.name ?? String(ev.afterStatusId),
      sort: status?.sort ?? 0,
      eventAt: new Date(ev.createdAt * 1000),
      leadCreatedAt: lead?.createdAt ?? null,
      lastEventAt: null,   // computed via SQL below
      nextStatusId: null,  // computed via SQL below
      nextEventAt: null,   // computed via SQL below
      manager: lead?.manager ?? (ev.createdBy ? (lookups.users.get(ev.createdBy) ?? "") : ""),
    });
  }

  // INSERT … ON CONFLICT DO UPDATE on the natural key (lead_id, event_at,
  // status_id). Idempotent: a retry of a fetch that already committed
  // server-side becomes a no-op UPDATE instead of a duplicate row. The old
  // DELETE-then-INSERT shape was race-prone — see migration 0014.
  //
  // We still UPDATE the snapshot fields (pipeline name/sort/manager,
  // lead_created_at) on conflict because Kommo can rename a status or
  // reassign a lead's manager; the window-function pass below recomputes
  // last_event_at / next_status_id / next_event_at so we don't touch those
  // here.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await analyticsDb
      .insert(leadStatusChanges)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [
          leadStatusChanges.leadId,
          leadStatusChanges.eventAt,
          leadStatusChanges.statusId,
        ],
        set: {
          amoDomain: sql`EXCLUDED.amo_domain`,
          pipelineId: sql`EXCLUDED.pipeline_id`,
          pipeline: sql`EXCLUDED.pipeline`,
          status: sql`EXCLUDED.status`,
          sort: sql`EXCLUDED.sort`,
          leadCreatedAt: sql`EXCLUDED.lead_created_at`,
          manager: sql`EXCLUDED.manager`,
        },
      });
  }

  // Compute last_event_at, next_status_id, next_event_at via window functions
  // Affects ALL rows for the leads touched in this sync (may span beyond date range)
  const leadIds = [...new Set(events.map((e) => e.leadId))];
  await analyticsDb.execute(sql`
    WITH ordered AS (
      SELECT
        lead_id,
        pipeline_id,
        status_id,
        event_at,
        MAX(event_at) OVER (PARTITION BY lead_id) AS last_event,
        LEAD(status_id) OVER (PARTITION BY lead_id ORDER BY event_at) AS next_sid,
        LEAD(event_at)  OVER (PARTITION BY lead_id ORDER BY event_at) AS next_eat
      FROM analytics.lead_status_changes
      WHERE lead_id IN (${sql.raw(leadIds.join(","))})
    )
    UPDATE analytics.lead_status_changes lsc
    SET
      last_event_at  = o.last_event,
      next_status_id = o.next_sid,
      next_event_at  = o.next_eat
    FROM ordered o
    WHERE lsc.lead_id   = o.lead_id
      AND lsc.status_id = o.status_id
      AND lsc.event_at  = o.event_at
  `);

  console.log(`[ETL] sync-status-changes: inserted ${rows.length} rows`);
  return rows.length;
}
