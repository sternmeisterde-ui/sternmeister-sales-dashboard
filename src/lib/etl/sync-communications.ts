// ETL: sync communications from Kommo Events API → analytics.communications
//
// Call events (entity_type=contact) → resolve contact→lead via batch API calls.
// Message events (entity_type=lead) → lead_id = entity_id directly.
//
// Computed fields populated at insert time:
//   first_contact_flg, last_contact_flg, first_call_at,
//   business_hours_sla, business_hours_since_communication

import {
  getAllCallNotesByDate,
  getContactsWithLeads,
  getMessageEvents,
} from "@/lib/kommo/client";
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

function buildContactMap(cache: LeadCacheEntry[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const e of cache) {
    for (const cid of e.contactIds) {
      if (!m.has(cid)) m.set(cid, []);
      m.get(cid)!.push(e.leadId);
    }
  }
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
  // Contact→lead from our lead cache (covers leads synced in this run)
  const contactMap = buildContactMap(leadCache);

  // ── Phase 1: fetch call notes directly from /contacts/notes + /leads/notes ──
  // Old path (getCallEvents via Events API) was documented to miss ~18% of
  // real calls that never emit an event row. getAllCallNotesByDate hits the
  // note endpoints directly and returns the same shape PLUS duration /
  // call_status inline, so the old Phase-2 getCallNoteParams round-trip is
  // no longer needed. Kommo's own reference confirms /notes is the
  // authoritative list for note_type=call_in/call_out.
  const callEvents = await getAllCallNotesByDate(fromTs, toTs);
  console.log(`[ETL] comm: ${callEvents.length} call notes`);

  // Resolve contacts not in our cache via batch API call
  const unknownContactIds = [
    ...new Set(
      callEvents
        .filter((e) => e.entityType === "contact" && !contactMap.has(e.entityId))
        .map((e) => e.entityId),
    ),
  ];
  if (unknownContactIds.length > 0) {
    const resolved = await getContactsWithLeads(unknownContactIds);
    for (const [cid, lids] of resolved) {
      contactMap.set(cid, lids);
    }
    console.log(`[ETL] comm: resolved ${unknownContactIds.length} unknown contacts`);
  }

  // ── Phase 2: fetch message events ────────────────────────────────────────
  const msgEvents = await getMessageEvents(fromTs, toTs);
  console.log(`[ETL] comm: ${msgEvents.length} message events`);

  // ── Phase 3: build rows per lead ─────────────────────────────────────────
  // Group all comms by lead_id so we can compute first/last flags + SLA ordering
  const byLead = new Map<number, CommRow[]>();

  const addRow = (row: CommRow) => {
    const lid = row.leadId ?? null;
    if (lid === null) return;
    if (!byLead.has(lid)) byLead.set(lid, []);
    byLead.get(lid)!.push(row);
  };

  // Call events → one row per (note, lead) pair. `duration` and `callStatus`
  // come inline from the note response — no extra round-trip needed.
  for (const ev of callEvents) {
    const leadIds =
      ev.entityType === "contact"
        ? (contactMap.get(ev.entityId) ?? [])
        : [ev.entityId];

    for (const lid of leadIds) {
      const lead = leadMap.get(lid);
      addRow({
        communicationId: String(ev.noteId),
        communicationType: ev.type,
        entityId: ev.entityId,
        createdAt: new Date(ev.createdAt * 1000),
        leadId: lid,
        pipelineId: lead?.pipelineId ?? null,
        pipelineName: lead?.pipelineName ?? null,
        category: lead?.category ?? null,
        leadCreatedAt: lead?.createdAt ?? null,
        leadDayStart: lead
          ? new Date(new Date(lead.createdAt).setUTCHours(0, 0, 0, 0))
          : null,
        callStatus: ev.callStatus ?? null,
        duration: ev.duration,
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
  }

  // Message events → one row per message
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

  // ── Phase 4: compute per-lead derived fields ──────────────────────────────
  const allRows: CommRow[] = [];

  for (const [, rows] of byLead) {
    // Sort by created_at ascending
    rows.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));

    // First call timestamp for this lead
    const firstCall = rows.find(
      (r) =>
        r.communicationType === "call_in" || r.communicationType === "call_out",
    )?.createdAt ?? null;

    let prevCommAt: Date | null = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const at = row.createdAt ?? null;
      const leadCreatedAt = row.leadCreatedAt;

      row.firstContactFlg = i === 0 ? 1 : 0;
      row.lastContactFlg = i === rows.length - 1 ? 1 : 0;
      row.firstCallAt = firstCall;

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

  if (allRows.length === 0) {
    console.log("[ETL] sync-communications: 0 rows");
    return 0;
  }

  // ── Phase 5: DELETE existing rows for this date range, then INSERT ────────
  await analyticsDb.execute(
    sql`DELETE FROM analytics.communications
        WHERE created_at >= ${fromDate} AND created_at <= ${toDate}`,
  );

  const CHUNK = 500;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    await analyticsDb.insert(communications).values(allRows.slice(i, i + CHUNK));
  }

  console.log(`[ETL] sync-communications: inserted ${allRows.length} rows`);
  return allRows.length;
}
