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

  // ── Persist: idempotent re-run + post-hard-split cleanup ──────────────
  // 1) Wipe our own prior writes in this window (cg-leg:* / ct:*) so the
  //    re-insert below is a true upsert.
  // 2) Wipe any stale Kommo-sourced CALL rows (`call_in` / `call_out`
  //    without a telephony prefix). Pre-2026-04-28 sync-communications
  //    wrote these; post hard-split it doesn't, so they're orphans
  //    inflating dashboard counts. Telephony rows REPLACE them with
  //    higher-fidelity per-leg/per-CDR data. Message rows (chat / email /
  //    SMS) stay untouched — they have non-call communication_type.
  await analyticsDb.execute(
    sql`DELETE FROM analytics.communications
        WHERE created_at >= ${fromDate}
          AND created_at <= ${toDate}
          AND (
            communication_id LIKE 'cg-leg:%'
            OR communication_id LIKE 'ct:%'
            OR (
              communication_type IN ('call_in', 'call_out')
              AND (
                communication_id IS NULL
                OR (
                  communication_id NOT LIKE 'cg-leg:%'
                  AND communication_id NOT LIKE 'ct:%'
                )
              )
            )
          )`,
  );

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await analyticsDb.insert(communications).values(rows.slice(i, i + CHUNK));
  }
  console.log(`[ETL telephony] inserted ${rows.length} rows`);

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
