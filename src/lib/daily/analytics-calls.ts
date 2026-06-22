// Call metrics sourced from the analytics DB (mirror of the 3rd-party integrator's
// MySQL — see docs/mysql-analytics.md). Replaces Kommo `/api/v4/notes` aggregation
// for Daily because:
//   • counts are more accurate (integrator reads Kommo event log + CDR, we only
//     read the paginated notes API which misses calls on frequent-hit days);
//   • one query serves both B2G and B2B (filtered by pipeline_id);
//   • works for past dates where Kommo notes may have expired from our cache.
//
// The analytics DB keys on `manager` (display name). We resolve back to
// `master_managers.id` via name match (with a small alias table for known
// Latin/Cyrillic drift in the integrator feed).

import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";
import { getPipelineIds } from "@/lib/kommo/pipeline-config";
import type { UserCallMetrics } from "@/lib/kommo/metrics";
import { cached } from "@/lib/kommo/cache";

// 60s TTL + in-flight dedup для всех analytics-запросов. В months-mode 12
// параллельных buildDailyResponse фирят ~60 дублирующихся HTTP-fetch'ей на
// одни и те же SQL — кэш рубит их до 1 запроса per key.
const ANALYTICS_TTL = 60 * 1000;

// Known name drift between `master_managers.name` (authoritative) and
// `analytics.communications.manager` (from integrator). Add entries here when
// a new manager shows up with a transliteration mismatch — verified from prod
// on 2026-04-24.
import { NAME_ALIASES } from "./name-aliases";

interface AnalyticsRow {
  manager: string;
  calls_total: string | number;
  calls_connected: string | number;
  outgoing_total: string | number;
  outgoing_connected: string | number;
  incoming_total: string | number;
  missed_incoming: string | number;
  total_duration_s: string | number;
  avg_wait_seconds: string | number | null;
}

/**
 * Fetch per-manager call metrics for a department in the given time window.
 * Returns a Map keyed by master_managers.id (via name match + aliases).
 *
 * Pass the list of active master managers so we can do the name → id resolution
 * and so callers downstream can keep indexing by master id like they already do.
 */
export async function getAnalyticsCallMetricsByMaster(
  managers: Array<{ id: string; name: string }>,
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<Map<string, UserCallMetrics>> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  if (pipelineIds.length === 0) return new Map();
  const managerIds = managers.map((m) => m.id).sort().join(",");
  const cacheKey = `call-metrics:${dept}:${fromTs}:${toTs}:${managerIds}`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchCallMetricsByMaster(managers, dept, pipelineIds, fromTs, toTs));
}

async function fetchCallMetricsByMaster(
  managers: Array<{ id: string; name: string }>,
  dept: "b2g" | "b2b",
  pipelineIds: number[],
  fromTs: number,
  toTs: number,
): Promise<Map<string, UserCallMetrics>> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);

  const pipelineList = sql.join(
    pipelineIds.map((id) => sql`${id}`),
    sql`, `,
  );

  // Call counting aligned with src/app/api/analytics/looker/data/route.ts on
  // the "which rows count as calls" axis (communication_type LIKE 'call%').
  //
  // "Дозвон от 1 сек" (Excel spec) = duration >= 1s — the person on the other
  // end picked up, regardless of whether the conversation was productive.
  // Looker's success_calls uses >= 10s which is a different, stricter
  // "successful call" metric and would undercount дозвоны here.
  //
  // Missed incoming mirrors the same threshold: anything under 1s (or NULL)
  // counts as a miss. total_duration_s sums across every call row to stay
  // consistent with Looker's total_duration_sec.
  //
  // DISTINCT ON (communication_id) collapses Pattern-A enrichment fan-out:
  // a single CDR call may have N rows (one per lead the contact has) after
  // enrich-telephony-leads runs. Each row carries the same manager/duration/
  // call_status/created_at, so picking one is consistent. We dedup INSIDE the
  // dept filter so cross-dept rows of the same call don't accidentally count
  // toward both depts.
  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<AnalyticsRow>(sql`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, manager, duration, call_status, wait_seconds
      FROM analytics.communications
      WHERE created_at >= ${fromDate}
        AND created_at <= ${toDate}
        -- pipeline_id IS NULL covers calls made before a lead enters a pipeline
        -- (или после удаления лида). Такие коммуникации всё равно принадлежат
        -- менеджеру — без NULL теряли ~60% звонков линии 2. Проверено 2026-04-24:
        -- ни один мастер-менеджер не числится одновременно в b2g и b2b, поэтому
        -- "double count" между департаментами невозможен.
        AND (pipeline_id IN (${pipelineList}) OR pipeline_id IS NULL)
        AND manager IS NOT NULL AND manager <> ''
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      manager,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%')                                       AS calls_total,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1)                     AS calls_connected,
      COUNT(*) FILTER (WHERE communication_type = 'call_out')                                       AS outgoing_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_out' AND duration >= 1)                     AS outgoing_connected,
      COUNT(*) FILTER (WHERE communication_type = 'call_in')                                        AS incoming_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in' AND (duration IS NULL OR duration < 1)) AS missed_incoming,
      COALESCE(SUM(duration) FILTER (WHERE communication_type LIKE 'call%'), 0)                     AS total_duration_s,
      AVG(wait_seconds) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1)            AS avg_wait_seconds
    FROM deduped
    GROUP BY manager
  `);

  const byName = new Map<string, UserCallMetrics>();
  for (const row of result.rows) {
    const callsTotal = Number(row.calls_total);
    const callsConnected = Number(row.calls_connected);
    const totalSeconds = Number(row.total_duration_s);
    const totalMinutes = Math.round(totalSeconds / 60);
    byName.set(row.manager, {
      kommoUserId: 0, // unused on this path — metrics are keyed by master id
      callsTotal,
      callsConnected,
      totalMinutes,
      avgDialogMinutes: callsConnected > 0 ? Math.round(totalSeconds / 60 / callsConnected) : 0,
      dialPercent: callsTotal > 0 ? Math.round((callsConnected / callsTotal) * 100) : 0,
      missedIncoming: Number(row.missed_incoming),
      incomingTotal: Number(row.incoming_total),
      outgoingTotal: Number(row.outgoing_total),
      outgoingConnected: Number(row.outgoing_connected),
      avgWaitSeconds: row.avg_wait_seconds == null ? 0 : Math.round(Number(row.avg_wait_seconds)),
    });
  }

  // Resolve analytics name → master_managers.id (with aliases).
  const byMaster = new Map<string, UserCallMetrics>();
  for (const m of managers) {
    let metrics = byName.get(m.name);
    if (!metrics) {
      const aliases = NAME_ALIASES[m.name];
      if (aliases) {
        for (const alias of aliases) {
          const hit = byName.get(alias);
          if (hit) { metrics = hit; break; }
        }
      }
    }
    if (metrics) byMaster.set(m.id, metrics);
  }
  return byMaster;
}

// Single call row, attributed to a master manager. Shape matches what
// /api/tracking's buildTimeline consumes — `eventType` carries the direction,
// `durationSec` drives the blue-segment width / "сколько на линии" math.
export interface AnalyticsCallEvent {
  managerId: string;        // master_managers.id
  eventId: string;          // unique key (analytics communication_id)
  eventType: "incoming_call" | "outgoing_call";
  createdAt: Date;
  durationSec: number;      // 0 for missed/unanswered
}

/**
 * Per-call rows for a department + window, attributed via NAME_ALIASES to
 * master_managers.id. Drives the Активность tab's blue segments — same
 * underlying source as Звонки/Daily/Dashboard so call counts agree across
 * tabs (and survive Kommo PBX-integration outages, since analytics.
 * communications is fed by direct CallGear+CloudTalk CDR pulls in our own
 * ETL — see src/lib/etl/sync-telephony.ts — independent of Kommo /notes).
 *
 * Pattern A dedup: a single CDR call appears as N rows (one per lead the
 * caller's contact is in). DISTINCT ON (communication_id) collapses them —
 * manager/duration/created_at are constant across the fanout. Pipeline
 * filter mirrors getAnalyticsCallMetricsByMaster: dept pipelines + NULL
 * (telephony rows that enrich-telephony-leads couldn't tie to a lead still
 * belong to the manager).
 */
export async function getAnalyticsCallEventsByMaster(
  managers: Array<{ id: string; name: string }>,
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<AnalyticsCallEvent[]> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  if (pipelineIds.length === 0) return [];
  const managerIds = managers.map((m) => m.id).sort().join(",");
  const cacheKey = `call-events:${dept}:${fromTs}:${toTs}:${managerIds}`;
  return cached(cacheKey, ANALYTICS_TTL, () =>
    fetchCallEventsByMaster(managers, pipelineIds, fromTs, toTs),
  );
}

async function fetchCallEventsByMaster(
  managers: Array<{ id: string; name: string }>,
  pipelineIds: number[],
  fromTs: number,
  toTs: number,
): Promise<AnalyticsCallEvent[]> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(
    pipelineIds.map((id) => sql`${id}`),
    sql`, `,
  );

  // Build name → master_managers.id map (with aliases) up front so the loop
  // below stays O(N).
  const nameToMaster = new Map<string, string>();
  for (const m of managers) {
    nameToMaster.set(m.name, m.id);
    for (const alias of NAME_ALIASES[m.name] ?? []) {
      nameToMaster.set(alias, m.id);
    }
  }

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{
    communication_id: string | number;
    communication_type: string;
    manager: string;
    duration: string | number | null;
    created_at: string;
  }>(sql`
    SELECT DISTINCT ON (communication_id)
      communication_id, communication_type, manager, duration, created_at
    FROM analytics.communications
    WHERE created_at >= ${fromDate}
      AND created_at <= ${toDate}
      AND communication_type LIKE 'call%'
      AND (pipeline_id IN (${pipelineList}) OR pipeline_id IS NULL)
      AND manager IS NOT NULL AND manager <> ''
    ORDER BY communication_id, lead_id NULLS LAST
  `);

  const out: AnalyticsCallEvent[] = [];
  for (const row of result.rows) {
    const managerId = nameToMaster.get(row.manager);
    if (!managerId) continue; // ex-manager / unmapped name → skip
    const direction =
      row.communication_type === "call_in" ? "incoming_call" : "outgoing_call";
    out.push({
      managerId,
      eventId: `comm:${row.communication_id}`,
      eventType: direction,
      createdAt: new Date(row.created_at),
      durationSec: Number(row.duration ?? 0),
    });
  }
  return out;
}

/**
 * Team-level call aggregate across ALL managers (including ex-managers no longer
 * in master_managers). Use this for the dept-wide call rollup so numbers match
 * the 3rd-party Looker / Excel which count every call regardless of current
 * manager status. Per-manager breakdown stays on getAnalyticsCallMetricsByMaster.
 */
export async function getAnalyticsTeamCallMetrics(
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<UserCallMetrics> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  if (pipelineIds.length === 0) {
    return { kommoUserId: 0, callsTotal: 0, callsConnected: 0, totalMinutes: 0, avgDialogMinutes: 0, dialPercent: 0, missedIncoming: 0, incomingTotal: 0, outgoingTotal: 0 };
  }
  const cacheKey = `team-calls:${dept}:${fromTs}:${toTs}`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchTeamCallMetrics(pipelineIds, fromTs, toTs));
}

/**
 * Per-pipeline team call aggregate. Used for the B2B departmental tiles
 * which are split into Бух Комм + Мед Комм columns instead of the B2G
 * Линия 1/2/3 split. Returns one UserCallMetrics per pipelineId — all
 * pipelines are queried in a single SQL grouped by pipeline_id (cheaper
 * than running getAnalyticsTeamCallMetrics N times).
 *
 * Pipelines without any matching call rows in the window get an all-zero
 * UserCallMetrics so the consumer can render empty buckets without null
 * checks.
 */
export async function getAnalyticsTeamCallMetricsByPipeline(
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<Map<number, UserCallMetrics>> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  if (pipelineIds.length === 0) return new Map();
  const cacheKey = `team-calls-by-pipeline:${dept}:${fromTs}:${toTs}`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchTeamCallMetricsByPipeline(pipelineIds, fromTs, toTs));
}

async function fetchTeamCallMetricsByPipeline(
  pipelineIds: number[],
  fromTs: number,
  toTs: number,
): Promise<Map<number, UserCallMetrics>> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);

  // Per-pipeline view INTENTIONALLY double-counts a CDR call across the
  // pipelines whose leads the contact is in. Pattern A (docs/mysql-analytics.md):
  // "A single communication_id can appear on multiple leads and pipelines
  // simultaneously" — sum of pipeline tiles ≥ dept total. Used for the B2B
  // BK/MK split. NO DISTINCT ON here.
  //
  // Unenriched telephony rows (pipeline_id=NULL) are dropped on purpose —
  // they have no pipeline to attribute to. They surface in the unscoped
  // totals tile via fetchTeamCallMetrics's NULL-fallback.
  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{
    pipeline_id: string | number;
    calls_total: string | number;
    calls_connected: string | number;
    outgoing_total: string | number;
    incoming_total: string | number;
    missed_incoming: string | number;
    total_duration_s: string | number;
  }>(sql`
    SELECT
      pipeline_id,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%')                                        AS calls_total,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1)                      AS calls_connected,
      COUNT(*) FILTER (WHERE communication_type = 'call_out')                                        AS outgoing_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in')                                         AS incoming_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in' AND (duration IS NULL OR duration < 1))  AS missed_incoming,
      COALESCE(SUM(duration) FILTER (WHERE communication_type LIKE 'call%'), 0)                      AS total_duration_s
    FROM analytics.communications
    WHERE created_at >= ${fromDate}
      AND created_at <= ${toDate}
      AND pipeline_id IN (${pipelineList})
    GROUP BY pipeline_id
  `);

  const out = new Map<number, UserCallMetrics>();
  for (const pid of pipelineIds) {
    out.set(pid, { kommoUserId: 0, callsTotal: 0, callsConnected: 0, totalMinutes: 0, avgDialogMinutes: 0, dialPercent: 0, missedIncoming: 0, incomingTotal: 0, outgoingTotal: 0 });
  }
  for (const row of result.rows) {
    const callsTotal = Number(row.calls_total);
    const callsConnected = Number(row.calls_connected);
    const totalSeconds = Number(row.total_duration_s);
    out.set(Number(row.pipeline_id), {
      kommoUserId: 0,
      callsTotal,
      callsConnected,
      totalMinutes: Math.round(totalSeconds / 60),
      avgDialogMinutes: callsConnected > 0 ? Math.round(totalSeconds / 60 / callsConnected) : 0,
      dialPercent: callsTotal > 0 ? Math.round((callsConnected / callsTotal) * 100) : 0,
      missedIncoming: Number(row.missed_incoming),
      incomingTotal: Number(row.incoming_total),
      outgoingTotal: Number(row.outgoing_total),
    });
  }
  return out;
}

async function fetchTeamCallMetrics(pipelineIds: number[], fromTs: number, toTs: number): Promise<UserCallMetrics> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);

  // DISTINCT ON inside the dept filter — Pattern A enrichment fans one CDR
  // into N rows; we want one count per CDR for the dept-wide tile.
  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<AnalyticsRow>(sql`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, duration, call_status
      FROM analytics.communications
      WHERE created_at >= ${fromDate}
        AND created_at <= ${toDate}
        -- pipeline_id IS NULL is required for telephony-sourced rows that
        -- enrich-telephony-leads couldn't resolve (phone not in any Kommo
        -- contact). They still belong to the dept by manager attribution.
        -- Mirrors getAnalyticsCallMetricsByMaster.
        AND (pipeline_id IN (${pipelineList}) OR pipeline_id IS NULL)
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      '' AS manager,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%')                                        AS calls_total,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1)                      AS calls_connected,
      COUNT(*) FILTER (WHERE communication_type = 'call_out')                                        AS outgoing_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in')                                         AS incoming_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in' AND (duration IS NULL OR duration < 1))  AS missed_incoming,
      COALESCE(SUM(duration) FILTER (WHERE communication_type LIKE 'call%'), 0)                      AS total_duration_s
    FROM deduped
  `);

  const row = result.rows[0];
  if (!row) {
    return { kommoUserId: 0, callsTotal: 0, callsConnected: 0, totalMinutes: 0, avgDialogMinutes: 0, dialPercent: 0, missedIncoming: 0, incomingTotal: 0, outgoingTotal: 0 };
  }
  const callsTotal = Number(row.calls_total);
  const callsConnected = Number(row.calls_connected);
  const totalSeconds = Number(row.total_duration_s);
  return {
    kommoUserId: 0,
    callsTotal,
    callsConnected,
    totalMinutes: Math.round(totalSeconds / 60),
    avgDialogMinutes: callsConnected > 0 ? Math.round(totalSeconds / 60 / callsConnected) : 0,
    dialPercent: callsTotal > 0 ? Math.round((callsConnected / callsTotal) * 100) : 0,
    missedIncoming: Number(row.missed_incoming),
    incomingTotal: Number(row.incoming_total),
    outgoingTotal: Number(row.outgoing_total),
  };
}

/**
 * Combined team + per-manager frozen-lead counts via GROUPING SETS.
 * A "frozen" lead is one the integrator flagged in
 * `analytics.sla.sla_status = 'frozen'` — typically: lead created, SLA clock
 * started, no first-call attempt within the expected window. Replaces the
 * old getFrozenLeadsByManager + getFrozenLeadsTeam pair which hit the same
 * WHERE clause twice.
 *
 * Returns { team, perManager: Map<master_manager.id, count> }. Zero for
 * managers with no frozen leads in the window.
 */
export async function getFrozenLeadsCombined(
  managers: Array<{ id: string; name: string }>,
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<{ team: number; perManager: Map<string, number> }> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  if (pipelineIds.length === 0) return { team: 0, perManager: new Map() };
  const managerIds = managers.map((m) => m.id).sort().join(",");
  const cacheKey = `frozen-combined:${dept}:${fromTs}:${toTs}:${managerIds}`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchFrozenLeadsCombined(managers, pipelineIds, fromTs, toTs));
}

async function fetchFrozenLeadsCombined(
  managers: Array<{ id: string; name: string }>,
  pipelineIds: number[],
  fromTs: number,
  toTs: number,
): Promise<{ team: number; perManager: Map<string, number> }> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ manager: string | null; is_total: number; frozen_cnt: string | number }>(sql`
    SELECT
      manager                AS manager,
      GROUPING(manager)::int AS is_total,
      COUNT(*)               AS frozen_cnt
    FROM analytics.sla
    WHERE sla_status = 'frozen'
      AND lead_created_at >= ${fromDate}
      AND lead_created_at <= ${toDate}
      AND pipeline_id IN (${pipelineList})
    GROUP BY GROUPING SETS ((), (manager))
  `);

  let team = 0;
  const byName = new Map<string, number>();
  for (const row of result.rows) {
    const n = Number(row.frozen_cnt);
    if (row.is_total === 1) {
      team = n;
    } else if (row.manager) {
      byName.set(row.manager, n);
    }
  }

  // Name → master id (with aliases, same pattern as call metrics above).
  const byMaster = new Map<string, number>();
  for (const m of managers) {
    let n = byName.get(m.name) ?? 0;
    if (!n) {
      const aliases = NAME_ALIASES[m.name];
      if (aliases) {
        for (const alias of aliases) {
          const v = byName.get(alias);
          if (v) { n = v; break; }
        }
      }
    }
    byMaster.set(m.id, n);
  }
  return { team, perManager: byMaster };
}

/** @deprecated Use getFrozenLeadsCombined which fetches team + per-manager
 *  in a single round-trip. Kept as a thin wrapper for callers that only
 *  need per-manager; to be removed once all callers are migrated. */
export async function getFrozenLeadsByManager(
  managers: Array<{ id: string; name: string }>,
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<Map<string, number>> {
  const { perManager } = await getFrozenLeadsCombined(managers, department, fromTs, toTs);
  return perManager;
}

/**
 * Overdue task counts per manager from analytics.tasks. An overdue task
 * is one with is_completed=0 AND deadline < NOW() (or the snapshot date,
 * for historical views). The integrator mirror refreshes continuously so
 * this is more authoritative than Kommo /api/v4/tasks which is paginated
 * and eventually-consistent.
 */
export async function getOverdueTasksByManager(
  managers: Array<{ id: string; name: string }>,
  asOfTs?: number,
): Promise<Map<string, number>> {
  // Bucket asOf to the nearest minute — snapshot metric, per-request stability
  // matters more than sub-minute freshness.
  const bucket = asOfTs ? Math.floor(asOfTs / 60) : Math.floor(Date.now() / 60_000);
  const managerIds = managers.map((m) => m.id).sort().join(",");
  const cacheKey = `overdue-tasks:${bucket}:${managerIds}`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchOverdueTasks(managers, asOfTs));
}

async function fetchOverdueTasks(
  managers: Array<{ id: string; name: string }>,
  asOfTs?: number,
): Promise<Map<string, number>> {
  const asOf = asOfTs ? new Date(asOfTs * 1000) : new Date();
  // "Overdue at asOf" = deadline < asOf AND (still open at asOf). The second
  // part needs BOTH "not completed at all" OR "completed only after asOf" so
  // historical views capture tasks that were overdue then but have since
  // been closed — otherwise past Daily always showed 0 overdue tasks as
  // the mirror eventually completed them.
  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ task_manager: string; overdue_cnt: string | number }>(sql`
    SELECT task_manager, COUNT(*) AS overdue_cnt
    FROM analytics.tasks
    WHERE deadline < ${asOf}
      AND (is_completed = 0 OR completed_at IS NULL OR completed_at > ${asOf})
      AND task_manager IS NOT NULL AND task_manager <> ''
    GROUP BY task_manager
  `);

  const byName = new Map<string, number>();
  for (const row of result.rows) byName.set(row.task_manager, Number(row.overdue_cnt));

  const byMaster = new Map<string, number>();
  for (const m of managers) {
    let n = byName.get(m.name) ?? 0;
    if (!n) {
      const aliases = NAME_ALIASES[m.name];
      if (aliases) {
        for (const alias of aliases) {
          const v = byName.get(alias);
          if (v) { n = v; break; }
        }
      }
    }
    byMaster.set(m.id, n);
  }
  return byMaster;
}

/** @deprecated Use getFrozenLeadsCombined instead — pass the full manager
 *  list (an empty array is fine when only the team total matters) and pluck
 *  .team from the result. This wrapper stays so existing callers don't break. */
export async function getFrozenLeadsTeam(
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<number> {
  const { team } = await getFrozenLeadsCombined([], department, fromTs, toTs);
  return team;
}

/**
 * Dept-wide average answer-wait (ring/queue seconds before pickup) for the
 * B2B «Ожидание (сек)» tile. Averaged over ANSWERED calls only (duration >= 1)
 * since "ожидание ответа" is undefined for calls nobody picked up. Deduped by
 * communication_id so Pattern-A fan-out doesn't skew the mean. wait_seconds is
 * NULL on Kommo/message rows — AVG skips those automatically.
 */
export async function getAnalyticsAvgWaitSeconds(
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<number> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  if (pipelineIds.length === 0) return 0;
  const cacheKey = `avg-wait:${dept}:${fromTs}:${toTs}`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchAvgWaitSeconds(pipelineIds, fromTs, toTs));
}

async function fetchAvgWaitSeconds(pipelineIds: number[], fromTs: number, toTs: number): Promise<number> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ avg_wait: string | number | null }>(sql`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, duration, wait_seconds
      FROM analytics.communications
      WHERE created_at >= ${fromDate}
        AND created_at <= ${toDate}
        AND (pipeline_id IN (${pipelineList}) OR pipeline_id IS NULL)
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT AVG(wait_seconds)::float AS avg_wait
    FROM deduped
    WHERE communication_type LIKE 'call%' AND duration >= 1
  `);

  const v = result.rows[0]?.avg_wait;
  return v == null ? 0 : Math.round(Number(v));
}

/**
 * Dept-wide average "time-to-first-call" SLA in MINUTES — creation → first
 * outbound call, business-hours seconds. Reads analytics.sla, preferring the
 * frozen integrator snapshot (COALESCE) like the Looker views so historical
 * leads match. Averaged over leads CREATED in [from, to] whose pipeline is in
 * the department and that actually got a first call (value not null).
 */
export async function getAnalyticsSlaFirstCallMinutes(
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<number> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  if (pipelineIds.length === 0) return 0;
  const cacheKey = `sla-first-call-min:${dept}:${fromTs}:${toTs}`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchSlaFirstCallMinutes(pipelineIds, fromTs, toTs));
}

async function fetchSlaFirstCallMinutes(pipelineIds: number[], fromTs: number, toTs: number): Promise<number> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ avg_min: string | number | null }>(sql`
    SELECT AVG(
      COALESCE(sla_first_call_seconds_integrator, sla_first_call_seconds)
    )::float / 60.0 AS avg_min
    FROM analytics.sla
    WHERE lead_created_at >= ${fromDate}
      AND lead_created_at <= ${toDate}
      AND pipeline_id IN (${pipelineList})
      AND COALESCE(sla_first_call_seconds_integrator, sla_first_call_seconds) IS NOT NULL
  `);

  const v = result.rows[0]?.avg_min;
  return v == null ? 0 : Math.round(Number(v));
}

/**
 * Per-manager "time-to-first-call" SLA in MINUTES — same metric as
 * getAnalyticsSlaFirstCallMinutes but grouped by manager and resolved to
 * master_managers.id (via NAME_ALIASES). Drives the B2B per-manager «SLA»
 * column. Managers with no qualifying leads in the window are absent (→ 0).
 */
export async function getAnalyticsSlaFirstCallMinutesByManager(
  managers: Array<{ id: string; name: string }>,
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<Map<string, number>> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  if (pipelineIds.length === 0) return new Map();
  const managerIds = managers.map((m) => m.id).sort().join(",");
  const cacheKey = `sla-first-call-min-mgr:${dept}:${fromTs}:${toTs}:${managerIds}`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchSlaFirstCallMinutesByManager(managers, pipelineIds, fromTs, toTs));
}

async function fetchSlaFirstCallMinutesByManager(
  managers: Array<{ id: string; name: string }>,
  pipelineIds: number[],
  fromTs: number,
  toTs: number,
): Promise<Map<string, number>> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ manager: string | null; avg_min: string | number | null }>(sql`
    SELECT
      manager,
      AVG(COALESCE(sla_first_call_seconds_integrator, sla_first_call_seconds))::float / 60.0 AS avg_min
    FROM analytics.sla
    WHERE lead_created_at >= ${fromDate}
      AND lead_created_at <= ${toDate}
      AND pipeline_id IN (${pipelineList})
      AND COALESCE(sla_first_call_seconds_integrator, sla_first_call_seconds) IS NOT NULL
      AND manager IS NOT NULL AND manager <> ''
    GROUP BY manager
  `);

  const byName = new Map<string, number>();
  for (const row of result.rows) {
    if (row.manager == null || row.avg_min == null) continue;
    byName.set(row.manager, Math.round(Number(row.avg_min)));
  }

  const byMaster = new Map<string, number>();
  for (const m of managers) {
    let v = byName.get(m.name);
    if (v == null) {
      for (const alias of NAME_ALIASES[m.name] ?? []) {
        const hit = byName.get(alias);
        if (hit != null) { v = hit; break; }
      }
    }
    if (v != null) byMaster.set(m.id, v);
  }
  return byMaster;
}

/**
 * Dept-wide "lost calls" count for the B2B «Потерянные» tile.
 *
 * Definition (per user spec 2026-06-23): an OUTBOUND no-answer attempt
 * (call_out, duration < 1) made during business hours 09:00–19:00 Berlin,
 * for which NO further outbound call to the same number happened within the
 * next 15 minutes. "Перезвонили" = any call_out to that number in the window,
 * connected or not — so only the trailing abandoned attempt to a number counts.
 *
 * Phone match is on the last 10 digits (numbers arrive in mixed formats:
 * `+4915120489078`, `015120489078`, `49…`), which collapses country-code /
 * leading-zero variants. Pattern-A fan-out is collapsed via DISTINCT ON before
 * counting so one CDR isn't counted N times.
 *
 * Note: the 15-min callback window is wall-clock — a 18:55 miss whose callback
 * lands 19:05 still counts as answered. Only the ORIGINAL miss must be in hours.
 */
export async function getAnalyticsLostCalls(
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<number> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  if (pipelineIds.length === 0) return 0;
  const cacheKey = `lost-calls:${dept}:${fromTs}:${toTs}`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchLostCalls(pipelineIds, fromTs, toTs));
}

async function fetchLostCalls(pipelineIds: number[], fromTs: number, toTs: number): Promise<number> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ lost: string | number }>(sql`
    WITH outs AS (
      SELECT DISTINCT ON (communication_id)
        communication_id,
        created_at,
        duration,
        right(regexp_replace(phone, '\D', '', 'g'), 10) AS pnorm
      FROM analytics.communications
      WHERE created_at >= ${fromDate}
        AND created_at <= ${toDate}
        AND communication_type = 'call_out'
        AND (pipeline_id IN (${pipelineList}) OR pipeline_id IS NULL)
        AND phone IS NOT NULL AND phone <> ''
      ORDER BY communication_id, lead_id NULLS LAST
    ),
    candidates AS (
      SELECT communication_id, created_at, pnorm
      FROM outs
      WHERE (duration IS NULL OR duration < 1)
        AND pnorm <> ''
        AND EXTRACT(hour FROM (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')) >= 9
        AND EXTRACT(hour FROM (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')) < 19
    )
    SELECT COUNT(*) AS lost
    FROM candidates c
    WHERE NOT EXISTS (
      SELECT 1
      FROM analytics.communications cb
      WHERE cb.communication_type = 'call_out'
        AND (cb.pipeline_id IN (${pipelineList}) OR cb.pipeline_id IS NULL)
        AND cb.communication_id <> c.communication_id
        AND cb.created_at > c.created_at
        AND cb.created_at <= c.created_at + interval '15 minutes'
        AND right(regexp_replace(cb.phone, '\D', '', 'g'), 10) = c.pnorm
    )
  `);

  return Number(result.rows[0]?.lost ?? 0);
}

export interface DailyCallBucket {
  date: string;              // YYYY-MM-DD in Europe/Berlin
  callsTotal: number;        // call_out + call_in
  callsConnected: number;    // call_status=4
  totalMinutes: number;      // sum of duration on connected calls, minutes
  missedIncoming: number;    // call_in where call_status<>4
  incomingTotal: number;     // call_in
  outgoingTotal: number;     // call_out
}

/**
 * Per-day call buckets for a trend line, grouped by Europe/Berlin calendar day.
 * Pads missing days with zeros so chart x-axis is continuous.
 */
export async function getAnalyticsDailyTrend(
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<DailyCallBucket[]> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  if (pipelineIds.length === 0) return [];

  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);

  const pipelineList = sql.join(
    pipelineIds.map((id) => sql`${id}`),
    sql`, `,
  );

  // Dept-wide trend → one count per CDR per day. DISTINCT ON collapses
  // Pattern-A fan-out (telephony rows linked to multiple leads share a comm_id).
  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{
    day: string;
    calls_total: string | number;
    calls_connected: string | number;
    outgoing_total: string | number;
    incoming_total: string | number;
    missed_incoming: string | number;
    total_duration_s: string | number;
  }>(sql`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, duration, call_status,
        to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day
      FROM analytics.communications
      WHERE created_at >= ${fromDate}
        AND created_at <= ${toDate}
        -- pipeline_id IS NULL covers telephony-sourced rows that enrichment
        -- couldn't resolve to a lead.
        AND (pipeline_id IN (${pipelineList}) OR pipeline_id IS NULL)
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      day,
      COUNT(*) FILTER (WHERE communication_type IN ('call_out','call_in'))                          AS calls_total,
      COUNT(*) FILTER (WHERE communication_type IN ('call_out','call_in') AND call_status = 4)      AS calls_connected,
      COUNT(*) FILTER (WHERE communication_type = 'call_out')                                       AS outgoing_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in')                                        AS incoming_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in' AND (call_status IS NULL OR call_status <> 4)) AS missed_incoming,
      COALESCE(SUM(CASE WHEN call_status = 4 THEN duration ELSE 0 END), 0)                          AS total_duration_s
    FROM deduped
    GROUP BY day
    ORDER BY day
  `);

  const byDay = new Map<string, DailyCallBucket>();
  for (const row of result.rows) {
    const secs = Number(row.total_duration_s);
    byDay.set(row.day, {
      date: row.day,
      callsTotal: Number(row.calls_total),
      callsConnected: Number(row.calls_connected),
      totalMinutes: Math.round(secs / 60),
      missedIncoming: Number(row.missed_incoming),
      incomingTotal: Number(row.incoming_total),
      outgoingTotal: Number(row.outgoing_total),
    });
  }

  // Pad the full range so the trend chart has continuous x-axis.
  const berlinKey = (tsSec: number) =>
    new Date(tsSec * 1000).toLocaleDateString("sv", { timeZone: "Europe/Berlin" });
  const out: DailyCallBucket[] = [];
  for (let t = fromTs; t <= toTs; t += 86400) {
    const key = berlinKey(t);
    out.push(
      byDay.get(key) ?? {
        date: key,
        callsTotal: 0,
        callsConnected: 0,
        totalMinutes: 0,
        missedIncoming: 0,
        incomingTotal: 0,
        outgoingTotal: 0,
      },
    );
  }
  return out;
}

/**
 * Per-line per-day call buckets — same shape as getAnalyticsDailyTrend but
 * each day is split across the three sales lines based on which manager
 * received/placed the call. Unmatched managers (ROPs, ex-staff, drift in
 * names) land under `none`. Returns padded continuous date series for each
 * line so the chart renders cleanly even on days with zero activity in
 * some lines.
 *
 * managersByLine — name lists already filtered to the department (caller
 * builds them from master_managers + NAME_ALIASES). Empty list for a line
 * means that line gets all-zero buckets.
 */
export async function getAnalyticsDailyTrendByLine(
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
  managersByLine: { line1: string[]; line2: string[]; line3: string[] },
): Promise<{ line1: DailyCallBucket[]; line2: DailyCallBucket[]; line3: DailyCallBucket[] }> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  const empty = padDailyTrend([], fromTs, toTs);
  if (pipelineIds.length === 0) {
    return { line1: empty, line2: empty, line3: empty };
  }

  const allNames = [
    ...managersByLine.line1,
    ...managersByLine.line2,
    ...managersByLine.line3,
  ];
  if (allNames.length === 0) {
    return { line1: empty, line2: empty, line3: empty };
  }

  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);
  const nameList = sql.join(allNames.map((n) => sql`${n}`), sql`, `);
  const line1List = managersByLine.line1.length > 0
    ? sql.join(managersByLine.line1.map((n) => sql`${n}`), sql`, `)
    : sql`NULL`;
  const line2List = managersByLine.line2.length > 0
    ? sql.join(managersByLine.line2.map((n) => sql`${n}`), sql`, `)
    : sql`NULL`;
  const line3List = managersByLine.line3.length > 0
    ? sql.join(managersByLine.line3.map((n) => sql`${n}`), sql`, `)
    : sql`NULL`;

  // DISTINCT ON inside the dept+manager filter so Pattern-A fan-out doesn't
  // multiply per-line counts. Each fanned row of the same CDR shares the
  // operator's manager, so line bucketing is unchanged after dedup.
  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{
    day: string;
    line: string;
    calls_total: string | number;
    calls_connected: string | number;
    outgoing_total: string | number;
    incoming_total: string | number;
    missed_incoming: string | number;
    total_duration_s: string | number;
  }>(sql`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, manager, duration, call_status,
        to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day
      FROM analytics.communications
      WHERE created_at >= ${fromDate}
        AND created_at <= ${toDate}
        AND (pipeline_id IN (${pipelineList}) OR pipeline_id IS NULL)
        AND manager IN (${nameList})
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      day,
      CASE
        WHEN manager IN (${line1List}) THEN '1'
        WHEN manager IN (${line2List}) THEN '2'
        WHEN manager IN (${line3List}) THEN '3'
        ELSE 'x'
      END AS line,
      COUNT(*) FILTER (WHERE communication_type IN ('call_out','call_in'))                          AS calls_total,
      COUNT(*) FILTER (WHERE communication_type IN ('call_out','call_in') AND call_status = 4)      AS calls_connected,
      COUNT(*) FILTER (WHERE communication_type = 'call_out')                                       AS outgoing_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in')                                        AS incoming_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in' AND (call_status IS NULL OR call_status <> 4)) AS missed_incoming,
      COALESCE(SUM(CASE WHEN call_status = 4 THEN duration ELSE 0 END), 0)                          AS total_duration_s
    FROM deduped
    GROUP BY day, line
    ORDER BY day
  `);

  const byLineDay = {
    line1: new Map<string, DailyCallBucket>(),
    line2: new Map<string, DailyCallBucket>(),
    line3: new Map<string, DailyCallBucket>(),
  };
  for (const row of result.rows) {
    const secs = Number(row.total_duration_s);
    const bucket: DailyCallBucket = {
      date: row.day,
      callsTotal: Number(row.calls_total),
      callsConnected: Number(row.calls_connected),
      totalMinutes: Math.round(secs / 60),
      missedIncoming: Number(row.missed_incoming),
      incomingTotal: Number(row.incoming_total),
      outgoingTotal: Number(row.outgoing_total),
    };
    if (row.line === "1") byLineDay.line1.set(row.day, bucket);
    else if (row.line === "2") byLineDay.line2.set(row.day, bucket);
    else if (row.line === "3") byLineDay.line3.set(row.day, bucket);
  }
  return {
    line1: padDailyTrend(Array.from(byLineDay.line1.values()), fromTs, toTs),
    line2: padDailyTrend(Array.from(byLineDay.line2.values()), fromTs, toTs),
    line3: padDailyTrend(Array.from(byLineDay.line3.values()), fromTs, toTs),
  };
}

/**
 * Per-pipeline daily trend — the B2B mirror of getAnalyticsDailyTrendByLine.
 * Splits each day's call activity across the department's pipelines (Бух
 * Комм / Мед Комм for B2B). Returns a Map<pipelineId, padded series>. NULL
 * pipeline_id rows (telephony without lead context) are dropped here since
 * they can't be attributed to a specific funnel.
 */
export async function getAnalyticsDailyTrendByPipeline(
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<Map<number, DailyCallBucket[]>> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  if (pipelineIds.length === 0) return new Map();

  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{
    day: string;
    pipeline_id: string | number;
    calls_total: string | number;
    calls_connected: string | number;
    outgoing_total: string | number;
    incoming_total: string | number;
    missed_incoming: string | number;
    total_duration_s: string | number;
  }>(sql`
    SELECT
      to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day,
      pipeline_id,
      COUNT(*) FILTER (WHERE communication_type IN ('call_out','call_in'))                          AS calls_total,
      COUNT(*) FILTER (WHERE communication_type IN ('call_out','call_in') AND call_status = 4)      AS calls_connected,
      COUNT(*) FILTER (WHERE communication_type = 'call_out')                                       AS outgoing_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in')                                        AS incoming_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in' AND (call_status IS NULL OR call_status <> 4)) AS missed_incoming,
      COALESCE(SUM(CASE WHEN call_status = 4 THEN duration ELSE 0 END), 0)                          AS total_duration_s
    FROM analytics.communications
    WHERE created_at >= ${fromDate}
      AND created_at <= ${toDate}
      AND pipeline_id IN (${pipelineList})
    GROUP BY day, pipeline_id
    ORDER BY day
  `);

  const byPipelineDay = new Map<number, Map<string, DailyCallBucket>>();
  for (const pid of pipelineIds) byPipelineDay.set(pid, new Map());
  for (const row of result.rows) {
    const pid = Number(row.pipeline_id);
    const inner = byPipelineDay.get(pid);
    if (!inner) continue;
    const secs = Number(row.total_duration_s);
    inner.set(row.day, {
      date: row.day,
      callsTotal: Number(row.calls_total),
      callsConnected: Number(row.calls_connected),
      totalMinutes: Math.round(secs / 60),
      missedIncoming: Number(row.missed_incoming),
      incomingTotal: Number(row.incoming_total),
      outgoingTotal: Number(row.outgoing_total),
    });
  }

  const out = new Map<number, DailyCallBucket[]>();
  for (const pid of pipelineIds) {
    out.set(pid, padDailyTrend(Array.from(byPipelineDay.get(pid)?.values() ?? []), fromTs, toTs));
  }
  return out;
}

function padDailyTrend(
  buckets: DailyCallBucket[],
  fromTs: number,
  toTs: number,
): DailyCallBucket[] {
  const byDay = new Map<string, DailyCallBucket>();
  for (const b of buckets) byDay.set(b.date, b);
  const berlinKey = (tsSec: number) =>
    new Date(tsSec * 1000).toLocaleDateString("sv", { timeZone: "Europe/Berlin" });
  const out: DailyCallBucket[] = [];
  for (let t = fromTs; t <= toTs; t += 86400) {
    const key = berlinKey(t);
    out.push(
      byDay.get(key) ?? {
        date: key,
        callsTotal: 0,
        callsConnected: 0,
        totalMinutes: 0,
        missedIncoming: 0,
        incomingTotal: 0,
        outgoingTotal: 0,
      },
    );
  }
  return out;
}
