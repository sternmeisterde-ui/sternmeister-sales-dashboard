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
export function callToCommRow(
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
    // No-agent CDRs (queue ring / missed inbound) carry NO manager — they're
    // attributed to the department by line_name, not by operator. Everyone else
    // gets the matched master name (or the raw agent name as fallback).
    manager: call.noAgent ? null : (manager?.name ?? fallbackName),
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
    // Ring/queue seconds before pickup — copied verbatim into fan-out rows by
    // enrich-telephony-leads so the per-CDR value is consistent across copies.
    waitSeconds: call.waitSec ?? null,
    // CloudTalk line name (KOM…/GOS…) — department-by-number attribution.
    lineName: call.lineName ?? null,
  };
}

export interface TelephonySyncResult {
  callgearLegs: number;
  cloudtalkCalls: number;
  unmatchedAgents: { source: "callgear" | "cloudtalk"; agentId: string; name: string; count: number }[];
  inserted: number;
}

export type TelephonyProvider = "callgear" | "cloudtalk";

export interface SyncTelephonyOptions {
  /** Restrict providers fetched in this run. Default = both.
   *  CallGear has a ~6h data-availability embargo on its API; the main
   *  10-min cron should pass `["cloudtalk"]` and let a separate hourly
   *  job pull CallGear with a 7h+ lag (see /api/analytics/sync/callgear). */
  providers?: TelephonyProvider[];
  /** Sweep mode: INSERT only CDRs whose communication_id is absent from
   *  analytics.communications; rows already present are left untouched
   *  (no DELETE+re-INSERT). For wide-lookback cron ticks that self-heal
   *  windows lost to failed/skipped ticks: a full replace would wipe the
   *  enrichment fan-out of every re-pulled row and burn Kommo lookups
   *  re-resolving the same phones every tick. CDRs are post-completion
   *  records (effectively immutable), so skipping the replace loses
   *  nothing. Backfills should keep the default (full replace). */
  skipExisting?: boolean;
}

export async function syncTelephony(
  fromDate: Date,
  toDate: Date,
  opts: SyncTelephonyOptions = {},
): Promise<TelephonySyncResult> {
  const providers = new Set<TelephonyProvider>(
    opts.providers ?? ["callgear", "cloudtalk"],
  );
  const wantCallgear = providers.has("callgear");
  const wantCloudtalk = providers.has("cloudtalk");

  const links = await loadManagerLinks();
  const cgIndex = indexByCallgearId(links);
  const ctIndex = indexByCloudtalkId(links);

  const rows: CommRow[] = [];
  const unmatched = new Map<
    string,
    { count: number; name: string; source: "callgear" | "cloudtalk" }
  >();

  // Pull selected providers in parallel — they're independent APIs.
  const [cgCalls, ctCalls] = await Promise.all([
    wantCallgear
      ? getCallGearCallsByDate(fromDate, toDate).catch((err) => {
          console.error(
            `[ETL telephony] CallGear failed (skipping): ${err instanceof Error ? err.message : err}`,
          );
          return [] as TelephonyCall[];
        })
      : Promise.resolve([] as TelephonyCall[]),
    wantCloudtalk && process.env.CLOUDTALK_API_ID
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
    // No-agent CDR (queue ring / missed inbound) — keep it, attributed to the
    // department by line_name (manager stays NULL via callToCommRow).
    if (call.noAgent || !call.agentId) {
      rows.push(callToCommRow(call, null, ""));
      continue;
    }
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

  // Dedup by (communication_id, lead_id ?? 0) — Postgres rejects
  // `ON CONFLICT DO UPDATE` when one statement targets the same row twice.
  // CallGear/CloudTalk can occasionally emit two CDR entries for one leg
  // (re-poll race, partial-then-complete writes); without this dedup the
  // upsert below crashes with `cannot affect row a second time`.
  // Last entry wins so the most recent leg snapshot (final duration /
  // call_status) is what lands.
  const telDedup = new Map<string, CommRow>();
  for (const r of rows) {
    const key = `${r.communicationId ?? "null"}|${r.leadId ?? 0}`;
    telDedup.set(key, r);
  }
  rows.length = 0;
  for (const r of telDedup.values()) rows.push(r);

  // ── Sweep mode: keep only CDRs we don't have yet ────────────────────
  if (opts.skipExisting) {
    const ids = [
      ...new Set(
        rows
          .map((r) => r.communicationId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const existing = new Set<string>();
    const LOOKUP_CHUNK = 1000;
    for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
      const chunk = ids.slice(i, i + LOOKUP_CHUNK);
      const res = (await analyticsDb.execute(
        sql`SELECT DISTINCT communication_id
            FROM analytics.communications
            WHERE communication_id IN (${sql.join(
              chunk.map((id) => sql`${id}`),
              sql`, `,
            )})`,
      )) as unknown as { rows: Array<{ communication_id: string }> };
      for (const r of res.rows) existing.add(r.communication_id);
    }
    // Свежий срез НЕ замораживаем: CloudTalk отдаёт и незавершённые звонки
    // (Cdr.ended_at nullable) — звонок, шедший во время прошлого тика, мог
    // лечь в БД с промежуточной длительностью. Всё, что началось за
    // последние FRESH_MINUTES, проходит полный DELETE+INSERT как в обычном
    // режиме (это и есть старое поведение 15-мин окна); skip-existing
    // применяется только к устоявшейся истории.
    const FRESH_MINUTES = 20;
    const freshCutoff = new Date(toDate.getTime() - FRESH_MINUTES * 60 * 1000);
    const before = rows.length;
    const keep = rows.filter(
      (r) =>
        !r.communicationId ||
        !existing.has(r.communicationId) ||
        (r.createdAt instanceof Date && r.createdAt >= freshCutoff),
    );
    rows.length = 0;
    rows.push(...keep);
    console.log(
      `[ETL telephony] sweep: ${before - rows.length} settled CDRs already present, ${rows.length} new/fresh`,
    );
    if (rows.length === 0) {
      return {
        callgearLegs: cgCalls.length,
        cloudtalkCalls: ctCalls.length,
        unmatchedAgents: [...unmatched.entries()].map(([key, info]) => ({
          source: info.source,
          agentId: key.replace(/^(cg|ct):/, ""),
          name: info.name,
          count: info.count,
        })),
        inserted: 0,
      };
    }
  }

  // ── Persist: per-CDR replacement (window-agnostic) ─────────────────
  // Wipe EVERY prior copy of each incoming communication_id — raw NULL,
  // enriched primary, and all fan-out copies — then INSERT fresh raw
  // rows. Enrich (downstream) re-fan-outs them.
  //
  // Why DELETE-by-id, not DELETE-by-window: CloudTalk/CallGear sometimes
  // surface older CDRs in a fresh window (a call at 11:33 returned by a
  // 13:31→13:46 sync because the provider's `lastModified` lags
  // `startedAt`). A `created_at BETWEEN ${from} AND ${to}` filter misses
  // those — DELETE leaves the prior raw NULL in place, INSERT then trips
  // the unique constraint with `(ct:X, 0) already exists`. Keying off
  // the actual incoming ids avoids the assumption entirely.
  //
  // Why not ON CONFLICT DO NOTHING: the unique key is
  // `(comm_id, COALESCE(lead_id, 0))`. A raw NULL row keys as
  // `(X, 0)`; an already-enriched primary keys as `(X, Y)`. They don't
  // collide — DO NOTHING would leave both rows alive, fanning a second
  // raw NULL that the next enrich tick can't update without violating
  // the primary's unique key.
  //
  // Race-condition safety: the lease lock in
  // /api/analytics/sync/cron/route.ts guarantees only one cron tick
  // runs at a time; `telDedup` above collapses intra-batch poll dupes.
  //
  // Message rows (chat/email/SMS) stay untouched — they have non-call
  // types and their own append-only path in sync-communications.
  const incomingCommIds = rows
    .map((r) => r.communicationId)
    .filter((id): id is string => Boolean(id));
  if (incomingCommIds.length > 0) {
    await analyticsDb.execute(
      sql`DELETE FROM analytics.communications
          WHERE communication_id IN (${sql.join(
            incomingCommIds.map((id) => sql`${id}`),
            sql`, `,
          )})
            AND communication_type IN ('call_in', 'call_out')`,
    );
  }

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await analyticsDb.insert(communications).values(rows.slice(i, i + CHUNK));
  }
  console.log(`[ETL telephony] inserted ${rows.length} raw rows (lead_id=NULL — enrichment to follow)`);

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

