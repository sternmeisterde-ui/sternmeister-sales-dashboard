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
  // Group all comms by lead_id so we can compute first/last flags + SLA
  // ordering. Orphan rows (no lead mapping, e.g. a call on a contact not
  // linked to any lead) go into a separate bucket — still kept for the
  // dashboard call-count metric (which groups by manager, not by lead), but
  // skip the lead-centric flag computation.
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

  // Call events → exactly ONE row per noteId. Prior code fanned out to N rows
  // when a call on a contact was linked to N leads, which double-counted the
  // same physical call in dashboard metrics (`COUNT(*)` on analytics.comms
  // counted each row). Dedup by noteId also protects against any cross-
  // entity overlap from fetchRawEvents' output.
  const seenNoteIds = new Set<number>();
  for (const ev of callEvents) {
    if (seenNoteIds.has(ev.noteId)) continue;
    seenNoteIds.add(ev.noteId);

    // Canonical lead selection:
    //   1) Lead-entity event → entity_id IS the lead.
    //   2) Contact-entity event → prefer a linked lead whose responsible_user
    //      matches the caller (active deal that prompted the call), else the
    //      most recently created linked lead.
    //   3) Company / customer / unmapped contact → orphan row (leadId=null).
    //      Still counted in manager-level call aggregates via `manager` name.
    let canonicalLeadId: number | null = null;
    if (ev.entityType === "lead") {
      canonicalLeadId = ev.entityId;
    } else if (ev.entityType === "contact") {
      const leadIds = contactMap.get(ev.entityId) ?? [];
      if (leadIds.length > 0) {
        const ownMatch = leadIds.find(
          (lid) => leadMap.get(lid)?.responsibleUserId === ev.createdBy,
        );
        if (ownMatch != null) {
          canonicalLeadId = ownMatch;
        } else {
          const mostRecent = [...leadIds].sort((a, b) => {
            const la = leadMap.get(a)?.createdAt.getTime() ?? 0;
            const lb = leadMap.get(b)?.createdAt.getTime() ?? 0;
            return lb - la;
          })[0];
          canonicalLeadId = mostRecent ?? null;
        }
      }
    }

    const lead = canonicalLeadId != null ? leadMap.get(canonicalLeadId) : undefined;

    // Manager attribution: the note's `created_by` is the user who clicked,
    // which for PBX-routed calls is often a service account — name lookup
    // misses, manager string ends up empty, and analytics-calls SQL filter
    // (`WHERE manager IS NOT NULL AND manager <> ''`) drops the row → call
    // disappears from dashboard. Fall back to:
    //   1. note.responsible_user_id (note's own responsible field)
    //   2. canonical lead's responsibleUserId (lead-owner attribution)
    // — both resolve via the same lookups.users map. Same fallback chain
    //   that tracking-sync.ts uses (single source of truth for attribution).
    let manager = ev.createdBy ? (lookups.users.get(ev.createdBy) ?? "") : "";
    if (!manager && ev.responsibleUserId) {
      manager = lookups.users.get(ev.responsibleUserId) ?? "";
    }
    if (!manager && lead?.responsibleUserId) {
      manager = lookups.users.get(lead.responsibleUserId) ?? "";
    }

    addRow({
      communicationId: String(ev.noteId),
      communicationType: ev.type,
      entityId: ev.entityId,
      createdAt: new Date(ev.createdAt * 1000),
      leadId: canonicalLeadId,
      pipelineId: lead?.pipelineId ?? null,
      pipelineName: lead?.pipelineName ?? null,
      category: lead?.category ?? null,
      leadCreatedAt: lead?.createdAt ?? null,
      leadDayStart: lead
        ? new Date(new Date(lead.createdAt).setUTCHours(0, 0, 0, 0))
        : null,
      callStatus: ev.callStatus ?? null,
      duration: ev.duration,
      manager,
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

  // Orphan rows (leadId=null) skip the per-lead flag loop but are still
  // included in the final insert — dashboard aggregates them via `manager`
  // name + pipeline_id IS NULL filter.
  for (const row of orphanRows) allRows.push(row);

  if (allRows.length === 0) {
    console.log("[ETL] sync-communications: 0 rows");
    return 0;
  }

  // ── Phase 5: DELETE existing rows for this date range, then INSERT ────────
  // (Edited-note duplicate concern handled by manual maintenance — see
  // drizzle/analytics/0004_communications_unique.sql for the unique index
  // SQL to apply via Neon SQL editor when convenient.)
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
