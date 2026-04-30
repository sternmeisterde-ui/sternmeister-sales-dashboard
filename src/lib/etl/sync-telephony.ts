// ETL: pull dial attempts from telephony providers (CallGear today, CloudTalk
// once creds are wired) and land them in analytics.communications alongside
// rows produced by sync-communications (which sources from Kommo /notes).
//
// The two sources are complementary, not redundant:
//   - sync-communications writes one row per Kommo note. PBX integrators
//     write a note for connected calls but skip instant hangups, route
//     failures, and operator-cancelled dials. → ~50% of attempts missed.
//   - sync-telephony writes one row per operator LEG straight from the PBX
//     report. → 100% of attempts an operator participated in.
//
// Distinct communication_id namespaces (`note:N`, `cg-leg:N`, `ct:N`) keep
// them from colliding inside analytics.communications. The dashboard query
// (`WHERE communication_type LIKE 'call%'`) sees them as the same rows but
// the prefix lets us re-run telephony backfill without disturbing Kommo
// rows in the same date range.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { masterManagers } from "@/lib/db/schema-existing";
import { analyticsDb } from "@/lib/db/analytics";
import { communications } from "@/lib/db/schema-analytics";
import { getCallsByDate as getCallGearCallsByDate } from "@/lib/telephony/callgear";
import { getCallsByDate as getCloudTalkCallsByDate } from "@/lib/telephony/cloudtalk";
import type { TelephonyCall } from "@/lib/telephony/types";

type CommRow = typeof communications.$inferInsert;

interface ManagerLink {
  id: string;
  name: string;
  department: string;
  callgearEmployeeId: string | null;
  cloudtalkAgentId: string | null;
}

async function loadManagerLinks(): Promise<ManagerLink[]> {
  const rows = await db
    .select({
      id: masterManagers.id,
      name: masterManagers.name,
      department: masterManagers.department,
      callgearEmployeeId: masterManagers.callgearEmployeeId,
      cloudtalkAgentId: masterManagers.cloudtalkAgentId,
    })
    .from(masterManagers)
    .where(eq(masterManagers.isActive, true));
  return rows;
}

function indexByCallgearId(
  links: ManagerLink[],
): Map<string, ManagerLink> {
  const m = new Map<string, ManagerLink>();
  for (const link of links) {
    if (link.callgearEmployeeId) m.set(link.callgearEmployeeId, link);
  }
  return m;
}

function indexByCloudtalkId(
  links: ManagerLink[],
): Map<string, ManagerLink> {
  const m = new Map<string, ManagerLink>();
  for (const link of links) {
    if (link.cloudtalkAgentId) m.set(link.cloudtalkAgentId, link);
  }
  return m;
}

// Convert TelephonyCall → analytics.communications row.
//
// pipeline_id stays NULL — telephony attempts happen outside any single
// Kommo pipeline (call comes first, then a lead is created or matched).
// Dashboard queries that read this table must include `OR pipeline_id IS
// NULL` in their pipeline filter; getAnalyticsCallMetricsByMaster +
// fetchTeamCallMetrics + getAnalyticsDailyTrend all do.
//
// call_status mirrors Kommo's encoding (4 = connected) so the existing
// Daily-trend query — which counts connected via `call_status = 4` — sees
// our answered legs as connected without changing its filter.
function callToCommRow(
  call: TelephonyCall,
  manager: ManagerLink | null,
  fallbackName: string,
): CommRow {
  const commType =
    call.type === "incoming"
      ? "call_in"
      : call.type === "outgoing"
        ? "call_out"
        : "call_out";

  return {
    communicationId: call.externalId,
    communicationType: commType,
    entityId: null,
    createdAt: call.startedAt,
    leadId: null,
    pipelineId: null,
    pipelineName: null,
    category: null,
    leadCreatedAt: null,
    leadDayStart: null,
    callStatus: call.status === "answered" ? 4 : null,
    duration: call.talkDurationSec,
    manager: manager?.name ?? fallbackName,
    statusId: null,
    statusName: null,
    utmSource: null,
    firstContactFlg: null,
    lastContactFlg: null,
    firstCallAt: null,
    businessHoursSla: null,
    businessHoursSinceCommunication: null,
    // Phone is the linkage key for enrich-telephony-leads. Stored on every
    // row (raw + fanned-out enriched copies) so the enrichment scan can find
    // un-enriched rows by `WHERE lead_id IS NULL AND phone IS NOT NULL`.
    phone: call.phone ?? null,
  };
}

export interface TelephonySyncResult {
  callgearLegs: number;
  cloudtalkCalls: number;
  unmatchedAgents: { source: "callgear" | "cloudtalk"; agentId: string; name: string; count: number }[];
  inserted: number;
}

export async function syncTelephony(
  fromDate: Date,
  toDate: Date,
): Promise<TelephonySyncResult> {
  const links = await loadManagerLinks();
  const cgIndex = indexByCallgearId(links);
  const ctIndex = indexByCloudtalkId(links);

  const rows: CommRow[] = [];
  const unmatched = new Map<
    string,
    { count: number; name: string; source: "callgear" | "cloudtalk" }
  >();

  // Pull both providers in parallel — they're independent APIs.
  const [cgCalls, ctCalls] = await Promise.all([
    getCallGearCallsByDate(fromDate, toDate).catch((err) => {
      console.error(
        `[ETL telephony] CallGear failed (skipping): ${err instanceof Error ? err.message : err}`,
      );
      return [] as TelephonyCall[];
    }),
    process.env.CLOUDTALK_API_ID
      ? getCloudTalkCallsByDate(fromDate, toDate).catch((err) => {
          console.error(
            `[ETL telephony] CloudTalk failed (skipping): ${err instanceof Error ? err.message : err}`,
          );
          return [] as TelephonyCall[];
        })
      : Promise.resolve([] as TelephonyCall[]),
  ]);

  console.log(
    `[ETL telephony] CallGear: ${cgCalls.length} operator legs, CloudTalk: ${ctCalls.length} calls`,
  );

  for (const call of cgCalls) {
    if (!call.agentId) continue;
    const manager = cgIndex.get(call.agentId) ?? null;
    if (!manager) {
      const key = `cg:${call.agentId}`;
      const existing = unmatched.get(key);
      if (existing) existing.count += 1;
      else unmatched.set(key, { count: 1, name: call.agentName ?? "?", source: "callgear" });
    }
    rows.push(callToCommRow(call, manager, call.agentName ?? `CG:${call.agentId}`));
  }

  for (const call of ctCalls) {
    if (!call.agentId) continue;
    const manager = ctIndex.get(call.agentId) ?? null;
    if (!manager) {
      const key = `ct:${call.agentId}`;
      const existing = unmatched.get(key);
      if (existing) existing.count += 1;
      else unmatched.set(key, { count: 1, name: call.agentName ?? "?", source: "cloudtalk" });
    }
    rows.push(callToCommRow(call, manager, call.agentName ?? `CT:${call.agentId}`));
  }

  if (unmatched.size > 0) {
    console.warn(
      `[ETL telephony] ${unmatched.size} unmatched agent ids — set master_managers.callgear_employee_id / cloudtalk_agent_id to attribute them:`,
    );
    for (const [key, info] of unmatched) {
      console.warn(`  ${key.padEnd(20)} ${info.name.padEnd(40)} ${info.count} calls (${info.source})`);
    }
  }

  if (rows.length === 0) {
    return {
      callgearLegs: cgCalls.length,
      cloudtalkCalls: ctCalls.length,
      unmatchedAgents: [],
      inserted: 0,
    };
  }

  // ── Persist: legacy cleanup + idempotent upsert ─────────────────────
  // (1) Wipe legacy non-prefixed call rows (Kommo /notes era, pre-2026-04-28
  //     hard-split). They predate the cg-leg:*/ct:* prefix scheme and
  //     wouldn't conflict with our ON CONFLICT below — they'd just persist
  //     forever as orphans.
  // (2) Upsert raw telephony rows by (communication_id, COALESCE(lead_id, 0)).
  //
  // Why upsert (changed 2026-04-30, sister fix to sync-communications.ts):
  // the previous DELETE-window+INSERT pattern was race-prone on the cron's
  // 5-min overlap window. CallGear/CloudTalk can return the same CDR with
  // a slightly different `created_at` between consecutive ticks (timestamp
  // rounding, in-progress→completed transitions), and the prior tick's
  // row would survive the DELETE filter — then INSERT crashed on
  // `communications_comm_lead_unique` (23505), aborting `sync-telephony`
  // and the downstream enrichment. With runStep isolation the tick
  // continues, but data is missing for ~10 min until the next tick covers
  // the same range.
  //
  // DO UPDATE refreshes mutable fields (manager / call_status / duration /
  // first_call_at — the call may end after first sync, picking up a real
  // duration on a later tick). Immutable fields (communication_id,
  // communication_type, entity_id, created_at, lead_id, phone) stay frozen.
  //
  // Note we DO NOT wipe enriched fan-out copies anymore — they have the
  // same communication_id but non-NULL lead_id, so they're unaffected by
  // the upsert against `(comm_id, COALESCE(lead_id, 0)) = (comm_id, 0)`.
  // Enrichment ran once for them; replaying it on every tick was wasted
  // Kommo /contacts budget.
  await analyticsDb.execute(
    sql`DELETE FROM analytics.communications
        WHERE created_at >= ${fromDate}
          AND created_at <= ${toDate}
          AND communication_type IN ('call_in', 'call_out')
          AND (
            communication_id IS NULL
            OR (communication_id NOT LIKE 'cg-leg:%' AND communication_id NOT LIKE 'ct:%')
          )`,
  );

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await upsertTelephony(rows.slice(i, i + CHUNK));
  }
  console.log(`[ETL telephony] upserted ${rows.length} raw rows (lead_id=NULL — enrichment to follow)`);

  return {
    callgearLegs: cgCalls.length,
    cloudtalkCalls: ctCalls.length,
    unmatchedAgents: [...unmatched.entries()].map(([key, info]) => ({
      source: info.source,
      agentId: key.replace(/^(cg|ct):/, ""),
      name: info.name,
      count: info.count,
    })),
    inserted: rows.length,
  };
}

/** Bulk upsert raw telephony rows via jsonb_to_recordset. Same pattern as
 *  sync-communications.ts:upsertCommunications and
 *  enrich-telephony-leads.ts:bulkInsertFanouts — one Neon HTTP call per
 *  batch, ON CONFLICT with the partial expression index target. */
async function upsertTelephony(batch: CommRow[]): Promise<void> {
  const safe = batch.filter((r) => r.communicationId);
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
      phone: r.phone ?? null,
    })),
  );

  await analyticsDb.execute(sql`
    INSERT INTO analytics.communications (
      communication_id, communication_type, entity_id, created_at,
      lead_id, pipeline_id, pipeline_name, category, lead_created_at,
      lead_day_start, call_status, duration, manager,
      status_id, status_name, utm_source,
      first_contact_flg, last_contact_flg, first_call_at,
      business_hours_sla, business_hours_since_communication, phone
    )
    SELECT
      i.communication_id, i.communication_type, i.entity_id, i.created_at::timestamp,
      i.lead_id, i.pipeline_id, i.pipeline_name, i.category, i.lead_created_at::timestamp,
      i.lead_day_start::timestamp, i.call_status, i.duration, i.manager,
      i.status_id, i.status_name, i.utm_source,
      i.first_contact_flg, i.last_contact_flg, i.first_call_at::timestamp,
      i.business_hours_sla, i.business_hours_since_communication, i.phone
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
      business_hours_since_communication double precision,
      phone                            text
    )
    ON CONFLICT (communication_id, COALESCE(lead_id, 0))
      WHERE communication_id IS NOT NULL
      DO UPDATE SET
        manager       = EXCLUDED.manager,
        call_status   = EXCLUDED.call_status,
        duration      = EXCLUDED.duration,
        first_call_at = EXCLUDED.first_call_at,
        phone         = COALESCE(analytics.communications.phone, EXCLUDED.phone)
  `);
}
