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

// Known name drift between `master_managers.name` (authoritative) and
// `analytics.communications.manager` (from integrator). Add entries here when
// a new manager shows up with a transliteration mismatch — verified from prod
// on 2026-04-24.
const NAME_ALIASES: Record<string, string[]> = {
  "Максим Алекперов": ["Maksim Alekperov"],
  "Гульназ Сираждинова": ["Гульназ Cираждинова"], // Latin C in integrator feed
  "Елизавета Трапезникова": ["Єлизавета Трапезникова"], // Ukrainian Є vs Russian Е
};

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

  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);

  const pipelineList = sql.join(
    pipelineIds.map((id) => sql`${id}`),
    sql`, `,
  );

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<AnalyticsRow>(sql`
    SELECT
      manager,
      COUNT(*) FILTER (WHERE communication_type IN ('call_out','call_in'))                           AS calls_total,
      COUNT(*) FILTER (WHERE communication_type IN ('call_out','call_in') AND call_status = 4)       AS calls_connected,
      COUNT(*) FILTER (WHERE communication_type = 'call_out')                                        AS outgoing_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in')                                         AS incoming_total,
      COUNT(*) FILTER (WHERE communication_type = 'call_in' AND (call_status IS NULL OR call_status <> 4)) AS missed_incoming,
      COALESCE(SUM(CASE WHEN call_status = 4 THEN duration ELSE 0 END), 0)                           AS total_duration_s
    FROM analytics.communications
    WHERE created_at >= ${fromDate}
      AND created_at <= ${toDate}
      AND pipeline_id IN (${pipelineList})
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
