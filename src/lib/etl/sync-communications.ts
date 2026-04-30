// ETL: sync NON-CALL communications (chat / email / SMS) from Kommo
// Events API → analytics.communications.
//
// Calls are owned by sync-telephony (CallGear + CloudTalk CDR). Until the
// 2026-04-28 hard-split this file also fetched `getAllCallNotesByDate` and
// double-counted calls that telephony already had. The split removes that
// duplication; Kommo /notes is no longer the call source of truth.
//
// Message events come from /api/v4/events filtered to chat/email/SMS types
// via getMessageEvents — entity_type=lead, so lead_id = entity_id directly,
// no contact→lead resolution needed (that was only required for call notes).
//
// Computed fields populated at insert time:
//   first_contact_flg, last_contact_flg,
//   business_hours_sla, business_hours_since_communication

import { getMessageEvents } from "@/lib/kommo/client";
import { analyticsDb } from "@/lib/db/analytics";
import { communications } from "@/lib/db/schema-analytics";
import { sql } from "drizzle-orm";
import { businessHoursSeconds } from "./business-hours";
import type { LeadCacheEntry } from "./sync-leads";
import type { KommoLookups } from "./lookups";
import { APP_TZ, parseDateBoundary } from "@/lib/utils/date";

type CommRow = typeof communications.$inferInsert;

/** Truncate a UTC instant to 00:00 of its Berlin-local civil day, returning a
 *  UTC Date. Used for `lead_day_start` so cohort grouping bucket matches the
 *  Berlin business calendar instead of UTC midnight (which is 02:00 / 01:00
 *  Berlin and shifts a sliver of leads into the wrong day). The non-null
 *  assertion is safe: `toLocaleDateString("en-CA")` always returns a string
 *  matching parseDateBoundary's regex. */
function berlinDayStart(instant: Date): Date {
  const civil = instant.toLocaleDateString("en-CA", { timeZone: APP_TZ });
  return parseDateBoundary(civil, "start")!;
}

function buildLeadMap(cache: LeadCacheEntry[]): Map<number, LeadCacheEntry> {
  const m = new Map<number, LeadCacheEntry>();
  for (const e of cache) m.set(e.leadId, e);
  return m;
}

export async function syncCommunications(
  fromDate: Date,
  toDate: Date,
  leadCache: LeadCacheEntry[],
  lookups: KommoLookups,
): Promise<number> {
  const fromTs = Math.floor(fromDate.getTime() / 1000);
  const toTs = Math.floor(toDate.getTime() / 1000);

  const leadMap = buildLeadMap(leadCache);

  const msgEvents = await getMessageEvents(fromTs, toTs);
  console.log(`[ETL] comm: ${msgEvents.length} message events`);

  const byLead = new Map<number, CommRow[]>();
  const orphanRows: CommRow[] = [];

  const addRow = (row: CommRow) => {
    const lid = row.leadId ?? null;
    if (lid === null) {
      orphanRows.push(row);
      return;
    }
    if (!byLead.has(lid)) byLead.set(lid, []);
    byLead.get(lid)!.push(row);
  };

  for (const ev of msgEvents) {
    const lead = leadMap.get(ev.leadId);
    addRow({
      communicationId: ev.messageId,
      communicationType: ev.type,
      entityId: ev.leadId,
      createdAt: new Date(ev.createdAt * 1000),
      leadId: ev.leadId,
      pipelineId: lead?.pipelineId ?? null,
      pipelineName: lead?.pipelineName ?? null,
      category: lead?.category ?? null,
      leadCreatedAt: lead?.createdAt ?? null,
      leadDayStart: lead ? berlinDayStart(new Date(lead.createdAt)) : null,
      callStatus: null,
      duration: null,
      manager: ev.createdBy ? (lookups.users.get(ev.createdBy) ?? "") : "",
      statusId: lead?.statusId ?? null,
      statusName: lead?.statusName ?? null,
      utmSource: null,
      firstContactFlg: null,
      lastContactFlg: null,
      firstCallAt: null,
      businessHoursSla: null,
      businessHoursSinceCommunication: null,
    });
  }

  const allRows: CommRow[] = [];

  for (const [, rows] of byLead) {
    rows.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));

    let prevCommAt: Date | null = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const at = row.createdAt ?? null;
      const leadCreatedAt = row.leadCreatedAt;

      // First/last "contact" flags computed across messages only — calls
      // live in telephony rows now, with their own ordering. Consumers that
      // need a true cross-source first contact should query both row sets
      // (compute-sla.ts already does the right thing via per-type MIN()).
      row.firstContactFlg = i === 0 ? 1 : 0;
      row.lastContactFlg = i === rows.length - 1 ? 1 : 0;

      if (at && leadCreatedAt) {
        row.businessHoursSla = businessHoursSeconds(leadCreatedAt, at);
      }
      if (at && prevCommAt) {
        row.businessHoursSinceCommunication = businessHoursSeconds(prevCommAt, at);
      }

      prevCommAt = at;
      allRows.push(row);
    }
  }

  for (const row of orphanRows) allRows.push(row);

  // ── Deduplicate within batch by (communication_id, lead_id ?? 0) ─────
  // Postgres rejects ON CONFLICT DO UPDATE when the same SQL statement
  // tries to update one row twice ("cannot affect row a second time").
  // Kommo /events can return multiple rows for the same message id when
  // a chat thread has both a delivery and a read receipt with the same
  // event id (rare but observed during 2026-04-30 backfill). Dedup in
  // JS — last entry wins, so the latest event wins on contact-flag /
  // SLA computations recomputed in the loop above.
  const dedupMap = new Map<string, CommRow>();
  for (const row of allRows) {
    const key = `${row.communicationId ?? "null"}|${row.leadId ?? 0}`;
    dedupMap.set(key, row);
  }
  allRows.length = 0;
  for (const row of dedupMap.values()) allRows.push(row);

  // ── Legacy pre-hard-split cleanup (transitional) ─────────────────────
  // Wipe orphan call rows that landed before 2026-04-28 hard-split — they
  // have `communication_type` ∈ {call_in, call_out} but no telephony
  // prefix in `communication_id` (or NULL). sync-telephony does the same
  // sweep when it runs, but that one only fires when telephony tokens
  // are configured; this duplicate keeps cleanup running even without
  // them. Safe to remove a few weeks after the hard-split lands in prod.
  await analyticsDb.execute(
    sql`DELETE FROM analytics.communications
        WHERE created_at >= ${fromDate} AND created_at <= ${toDate}
          AND communication_type IN ('call_in', 'call_out')
          AND (
            communication_id IS NULL
            OR (
              communication_id NOT LIKE 'cg-leg:%'
              AND communication_id NOT LIKE 'ct:%'
            )
          )`,
  );

  if (allRows.length === 0) {
    console.log("[ETL] sync-communications: 0 rows (only legacy cleanup ran)");
    return 0;
  }

  // ── Persist: INSERT … ON CONFLICT DO UPDATE on mutable snapshot fields
  // The previous DELETE-in-window + INSERT pattern was race-prone: a Kommo
  // event whose `created_at` landed outside the cron window (event
  // registration time ≠ message send time, or two cron ticks overlapping
  // their 5-min windows) escaped the DELETE and the INSERT crashed on the
  // partial unique index
  // `(communication_id, COALESCE(lead_id, 0)) WHERE communication_id IS NOT NULL`
  // (migration 0005). Symptom: `23505 duplicate key … communications_comm_lead_unique`,
  // observed at 2026-04-30 13:57Z aborting all downstream steps
  // (telephony / enrichment / SLA).
  //
  // We now INSERT … ON CONFLICT DO UPDATE on the snapshot fields that can
  // legitimately drift between when the row was first inserted and when it
  // is re-seen by a later tick — `manager` (Kommo user rename / re-assignment),
  // `pipeline_id` / `pipeline_name` (lead reassigned to a different pipeline),
  // `status_id` / `status_name` (status moved), `category` (recategorisation),
  // and the within-batch contact-flag / SLA computations. Immutable fields
  // (communication_id, communication_type, entity_id, created_at, lead_id,
  // lead_created_at) are NOT touched on conflict.
  //
  // Why DO UPDATE not DO NOTHING: `analytics-calls.ts` reads
  // `communications.manager` and `communications.pipeline_id` directly
  // without JOINing `leads_cohort` for current state, so a stale snapshot
  // mis-attributes calls when a manager renames or a lead is reassigned
  // across departments.
  //
  // The expression target `(communication_id, COALESCE(lead_id, 0))` cannot
  // be specified via Drizzle's `onConflictDoUpdate({ target })` because the
  // COALESCE is part of the index expression (not a column). Use raw SQL
  // with the same jsonb_to_recordset pattern as `bulkInsertFanouts` in
  // `enrich-telephony-leads.ts` so the target is matched implicitly through
  // the constraint.
  //
  // Call rows (`call_in`/`call_out`) are written by `sync-telephony`; the
  // legacy-cleanup sweep above wipes any orphan call rows that pre-date the
  // 2026-04-28 hard-split.
  const CHUNK = 500;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    await upsertCommunications(allRows.slice(i, i + CHUNK));
  }

  console.log(`[ETL] sync-communications: upserted ${allRows.length} rows (mutable fields refreshed on conflict)`);
  return allRows.length;
}

/** Bulk INSERT … ON CONFLICT DO UPDATE via jsonb_to_recordset. One Neon HTTP
 *  call per batch instead of N. Mirrors `bulkInsertFanouts` in
 *  enrich-telephony-leads.ts but updates mutable fields on conflict. */
async function upsertCommunications(batch: CommRow[]): Promise<void> {
  // Skip rows with no communication_id — partial unique index excludes them
  // (`WHERE communication_id IS NOT NULL`), so DO UPDATE never fires and
  // duplicates can sneak in. `getMessageEvents` always returns a messageId
  // in practice; this guard is belt-and-suspenders.
  const safe = batch.filter((r) => r.communicationId !== null && r.communicationId !== undefined);
  if (safe.length === 0) return;

  const json = JSON.stringify(
    safe.map((r) => ({
      communication_id: r.communicationId,
      communication_type: r.communicationType,
      entity_id: r.entityId,
      created_at: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      lead_id: r.leadId ?? null,
      pipeline_id: r.pipelineId ?? null,
      pipeline_name: r.pipelineName ?? null,
      category: r.category ?? null,
      lead_created_at: r.leadCreatedAt instanceof Date ? r.leadCreatedAt.toISOString() : r.leadCreatedAt,
      lead_day_start: r.leadDayStart instanceof Date ? r.leadDayStart.toISOString() : r.leadDayStart,
      call_status: r.callStatus ?? null,
      duration: r.duration ?? null,
      manager: r.manager ?? null,
      status_id: r.statusId ?? null,
      status_name: r.statusName ?? null,
      utm_source: r.utmSource ?? null,
      first_contact_flg: r.firstContactFlg ?? null,
      last_contact_flg: r.lastContactFlg ?? null,
      first_call_at: r.firstCallAt instanceof Date ? r.firstCallAt.toISOString() : r.firstCallAt,
      business_hours_sla: r.businessHoursSla ?? null,
      business_hours_since_communication: r.businessHoursSinceCommunication ?? null,
    })),
  );

  await analyticsDb.execute(sql`
    INSERT INTO analytics.communications (
      communication_id, communication_type, entity_id, created_at,
      lead_id, pipeline_id, pipeline_name, category, lead_created_at,
      lead_day_start, call_status, duration, manager,
      status_id, status_name, utm_source,
      first_contact_flg, last_contact_flg, first_call_at,
      business_hours_sla, business_hours_since_communication
    )
    SELECT
      i.communication_id, i.communication_type, i.entity_id, i.created_at::timestamp,
      i.lead_id, i.pipeline_id, i.pipeline_name, i.category, i.lead_created_at::timestamp,
      i.lead_day_start::timestamp, i.call_status, i.duration, i.manager,
      i.status_id, i.status_name, i.utm_source,
      i.first_contact_flg, i.last_contact_flg, i.first_call_at::timestamp,
      i.business_hours_sla, i.business_hours_since_communication
    FROM jsonb_to_recordset(${json}::jsonb) AS i(
      communication_id                 text,
      communication_type               text,
      entity_id                        bigint,
      created_at                       text,
      lead_id                          bigint,
      pipeline_id                      bigint,
      pipeline_name                    text,
      category                         text,
      lead_created_at                  text,
      lead_day_start                   text,
      call_status                      smallint,
      duration                         integer,
      manager                          text,
      status_id                        bigint,
      status_name                      text,
      utm_source                       text,
      first_contact_flg                smallint,
      last_contact_flg                 smallint,
      first_call_at                    text,
      business_hours_sla               bigint,
      business_hours_since_communication double precision
    )
    ON CONFLICT (communication_id, COALESCE(lead_id, 0))
      WHERE communication_id IS NOT NULL
      DO UPDATE SET
        manager                              = EXCLUDED.manager,
        pipeline_id                          = EXCLUDED.pipeline_id,
        pipeline_name                        = EXCLUDED.pipeline_name,
        status_id                            = EXCLUDED.status_id,
        status_name                          = EXCLUDED.status_name,
        category                             = EXCLUDED.category,
        first_contact_flg                    = EXCLUDED.first_contact_flg,
        last_contact_flg                     = EXCLUDED.last_contact_flg,
        business_hours_sla                   = EXCLUDED.business_hours_sla,
        business_hours_since_communication   = EXCLUDED.business_hours_since_communication
  `);
}
