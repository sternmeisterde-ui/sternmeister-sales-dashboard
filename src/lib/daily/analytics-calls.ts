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
  incoming_total: string | number;
  missed_incoming: string | number;
  total_duration_s: string | number;
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
  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<AnalyticsRow>(sql`
    SELECT
      manager,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%')                                       AS calls_total,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1)                     AS calls_connected,
      COUNT(*) FILTER (WHERE communication_type = 'call_out')                                       AS outgoing_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in')                                        AS incoming_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in' AND (duration IS NULL OR duration < 1)) AS missed_incoming,
      COALESCE(SUM(duration) FILTER (WHERE communication_type LIKE 'call%'), 0)                     AS total_duration_s
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

async function fetchTeamCallMetrics(pipelineIds: number[], fromTs: number, toTs: number): Promise<UserCallMetrics> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<AnalyticsRow>(sql`
    SELECT
      '' AS manager,
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
    SELECT
      to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day,
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
