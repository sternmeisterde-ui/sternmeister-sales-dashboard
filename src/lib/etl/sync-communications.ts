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

type CommRow = typeof communications.$inferInsert;

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
      leadDayStart: lead
        ? new Date(new Date(lead.createdAt).setUTCHours(0, 0, 0, 0))
        : null,
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

  // ── DELETE existing rows for this date range, then INSERT ────────────
  // Scoped to leave telephony rows alone — sync-telephony writes `cg-leg:*`
  // and `ct:*` ids and owns its own DELETE. The earlier wide DELETE here
  // silently zeroed out PBX coverage on every Kommo backfill (fixed
  // 2026-04-28 alongside the hard-split that stopped this writer from
  // emitting call rows in the first place).
  //
  // Even with zero rows to insert we still run the DELETE — that's how
  // we drop stale call rows left over from before the hard-split. Without
  // a clean-up pass, the old `note:N` call rows would haunt the dashboard
  // until the next overlapping backfill.
  await analyticsDb.execute(
    sql`DELETE FROM analytics.communications
        WHERE created_at >= ${fromDate} AND created_at <= ${toDate}
          AND (
            communication_id IS NULL
            OR (
              communication_id NOT LIKE 'cg-leg:%'
              AND communication_id NOT LIKE 'ct:%'
            )
          )`,
  );

  if (allRows.length === 0) {
    console.log("[ETL] sync-communications: 0 rows (only DELETE ran)");
    return 0;
  }

  const CHUNK = 500;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    await analyticsDb.insert(communications).values(allRows.slice(i, i + CHUNK));
  }

  console.log(`[ETL] sync-communications: inserted ${allRows.length} rows`);
  return allRows.length;
}
