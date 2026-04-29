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

  // ── Persist: full message-row replacement in window ─────────────────
  // Wipe message rows (chat/email/SMS) in the window, then INSERT fresh.
  // Mirrors sync-telephony's pattern for the same reason: post-0005 the
  // unique key is `(communication_id, COALESCE(lead_id, 0))`, which Drizzle
  // can't express in `onConflictDoUpdate({ target })` (the COALESCE is part
  // of the index expression, not a column). The previous upsert against
  // `target: communicationId` referenced a dropped index and crashed the
  // ETL on every run.
  //
  // Safe because `getMessageEvents` filters Kommo /events by created_at and
  // the events feed is append-only — message edits don't re-emit older
  // event ids with their original timestamps, so we never miss rows the
  // DELETE didn't see. Call rows (call_in/call_out) stay untouched here;
  // sync-telephony owns them and the legacy-cleanup sweep above wipes any
  // orphan call rows that pre-date the 2026-04-28 hard-split.
  await analyticsDb.execute(
    sql`DELETE FROM analytics.communications
        WHERE created_at >= ${fromDate} AND created_at <= ${toDate}
          AND communication_type IN ('incoming_chat_message', 'outgoing_chat_message')`,
  );

  const CHUNK = 500;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    await analyticsDb.insert(communications).values(allRows.slice(i, i + CHUNK));
  }

  console.log(`[ETL] sync-communications: upserted ${allRows.length} rows`);
  return allRows.length;
}
