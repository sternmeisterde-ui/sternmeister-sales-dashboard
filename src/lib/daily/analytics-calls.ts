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
import { getPipelineIds, B2G_PIPELINES } from "@/lib/kommo/pipeline-config";
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

// Что суммировать в «Длительность / На линии».
// B2B (спека 22 п.2): правило Рузанны — плитка должна сходиться с кабинетами
// телефоний, а кабинеты считают ПО-РАЗНОМУ (сверено поштучно 26.06.2026):
//   • дашборд CloudTalk «Total talking time» = ЧИСТЫЙ РАЗГОВОР
//     (talking_time; у нас duration) — совпал секунда-в-секунду (5ч46м41с);
//   • выгрузка CallGear «Длительность звонка» = ПОЛНОЕ время лега
//     (total_duration = duration + wait_seconds, т.к. wait для cg считается
//     как total - talk) — совпала с точностью до округлений (55:49 vs 55:54).
// Поэтому b2b суммирует каждый источник так, как его считает его кабинет.
// B2G остаётся на чистом разговоре — их определение не трогаем без Димы.
// ВАЖНО: только для СУММ длительности; фильтр дозвона duration >= 1 всегда
// по чистому разговору (иначе гудки станут «дозвонами»).
function durationExpr(dept: "b2g" | "b2b") {
  return dept === "b2b"
    ? sql`(CASE WHEN communication_id LIKE 'cg-leg:%' THEN duration + COALESCE(wait_seconds, 0) ELSE duration END)`
    : sql`duration`;
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

  // Department scoping. B2B (Коммерсы) is attributed purely by AGENT — same as
  // CloudTalk's group report counts outbound — so we DROP the pipeline filter:
  // a B2B master's call belongs to B2B regardless of the lead's pipeline (no
  // master is in two departments). The old pipeline filter dropped a master's
  // calls to leads sitting in a B2G pipeline, undercounting «Исходящие».
  // B2G keeps the pipeline filter (its number-based attribution isn't wired).
  const deptCond =
    dept === "b2b"
      ? sql`TRUE`
      : sql`(pipeline_id IN (${pipelineList}) OR pipeline_id IS NULL)`;

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
        AND ${deptCond}
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
      COALESCE(SUM(${durationExpr(dept)}) FILTER (WHERE communication_type LIKE 'call%'), 0)        AS total_duration_s,
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

// Single dialer (CloudTalk) call attributed to a master manager. Drives the
// "Дайлер" view of the Активность tab. Unlike AnalyticsCallEvent it carries
// talk + wait seconds SEPARATELY — the dialer view splits «разговор» from
// «ожидание/дозвон». wrap-up follows once persisted (not yet a column).
export interface DialerCallEvent {
  managerId: string;        // master_managers.id
  eventId: string;          // stable key (analytics communication_id)
  createdAt: Date;          // CloudTalk started_at (ring start)
  direction: "incoming" | "outgoing";
  talkSec: number;          // analytics.communications.duration (talkDurationSec)
  waitSec: number;          // analytics.communications.wait_seconds (CloudTalk waiting_time)
  phone: string | null;     // remote party number (for the detail loupe)
}

/**
 * Per-call dialer rows for the window. Isolates the dialer by
 * `communication_id LIKE 'ct:%'` — CloudTalk is the B2G dialer telephony, so
 * ct: rows ≈ dialer activity (CallGear `cg-leg:` and Kommo `note:` excluded).
 * Scoping is two-layer:
 * (1) the pipeline filter `pipeline_id IN (10935879) OR pipeline_id IS NULL`
 * keeps ONLY the Бух Гос funnel (the dialer's exclusive target) plus NULL-
 * pipeline phone-fallback rows (pre-enrichment) — Бератер / Medical Gov calls
 * are dropped; and (2) the caller's manager roster drops any row whose
 * `manager` name resolves outside `managers`.
 *
 * Same DISTINCT ON (communication_id) Pattern-A dedup as
 * getAnalyticsCallEventsByMaster: one CDR fanned out across N leads collapses
 * to a single row (talk/wait/manager are constant across the fanout).
 *
 * Returned rows are bucketed into Berlin-local days + summed by the caller
 * (/api/tracking?view=dialer), mirroring how call events are day-bucketed.
 */
export async function getDialerCallEventsByMaster(
  managers: Array<{ id: string; name: string }>,
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<DialerCallEvent[]> {
  // Dialer is B2G-only (CloudTalk Power-Dialer campaign «Бух Гос»). No dialer
  // outside B2G → nothing to return.
  if (department !== "b2g") return [];
  // Scope to the Бух Гос funnel ONLY (10935879), not all B2G pipelines: the
  // dialer dials that funnel exclusively, so Бератер / Medical Gov CloudTalk
  // calls are not dialer activity. NULL pipeline is kept (phone-fallback ct:
  // rows before enrichment).
  const pipelineIds = [B2G_PIPELINES.FIRST_LINE];
  const managerIds = managers.map((m) => m.id).sort().join(",");
  const cacheKey = `dialer-events:b2g:${fromTs}:${toTs}:${managerIds}`;
  return cached(cacheKey, ANALYTICS_TTL, () =>
    fetchDialerCallEventsByMaster(managers, pipelineIds, fromTs, toTs),
  );
}

async function fetchDialerCallEventsByMaster(
  managers: Array<{ id: string; name: string }>,
  pipelineIds: number[],
  fromTs: number,
  toTs: number,
): Promise<DialerCallEvent[]> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(
    pipelineIds.map((id) => sql`${id}`),
    sql`, `,
  );

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
    wait_seconds: string | number | null;
    created_at: string;
    phone: string | null;
  }>(sql`
    SELECT DISTINCT ON (communication_id)
      communication_id, communication_type, manager, duration, wait_seconds, phone, created_at
    FROM analytics.communications
    WHERE created_at >= ${fromDate}
      AND created_at <= ${toDate}
      AND communication_id LIKE 'ct:%'
      AND communication_type LIKE 'call%'
      AND (pipeline_id IN (${pipelineList}) OR pipeline_id IS NULL)
      AND manager IS NOT NULL AND manager <> ''
    ORDER BY communication_id, lead_id NULLS LAST
  `);

  const out: DialerCallEvent[] = [];
  for (const row of result.rows) {
    const managerId = nameToMaster.get(row.manager);
    if (!managerId) continue; // ex-manager / other dept / unmapped name → skip
    out.push({
      managerId,
      eventId: `comm:${row.communication_id}`,
      createdAt: new Date(row.created_at),
      direction: row.communication_type === "call_in" ? "incoming" : "outgoing",
      talkSec: Number(row.duration ?? 0),
      waitSec: Number(row.wait_seconds ?? 0),
      phone: row.phone ?? null,
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
  const cacheKey = `team-calls:${dept}:${fromTs}:${toTs}:v2`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchTeamCallMetrics(dept, pipelineIds, fromTs, toTs));
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
  const cacheKey = `team-calls-by-pipeline:${dept}:${fromTs}:${toTs}:v2`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchTeamCallMetricsByPipeline(dept, pipelineIds, fromTs, toTs));
}

async function fetchTeamCallMetricsByPipeline(
  dept: "b2g" | "b2b",
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
      COALESCE(SUM(${durationExpr(dept)}) FILTER (WHERE communication_type LIKE 'call%'), 0)         AS total_duration_s
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

async function fetchTeamCallMetrics(dept: "b2g" | "b2b", pipelineIds: number[], fromTs: number, toTs: number): Promise<UserCallMetrics> {
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
        communication_id, communication_type, duration, wait_seconds, call_status
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
 * Dept-wide average answer-wait (ring seconds before pickup, from CDR
 * wait_seconds) for the B2B «Ожидание (сек)» tile. Averaged over ANSWERED
 * calls only (duration >= 1) since "ожидание ответа" is undefined for calls
 * nobody picked up. Deduped by communication_id so Pattern-A fan-out doesn't
 * skew the mean.
 *
 * Scope: BY AGENT (спека 22 п.3) — как и остальные b2b-плитки. Прежний скоуп
 * «воронки + NULL» подмешивал чужие необогащённые строки (b2g) в среднее.
 * NB: виджеты аналитики самих телефоний считают «ожидание» по своим
 * внутренним событиям очереди, которых нет в CDR API — их значения с этой
 * метрикой сопоставлять нельзя (разные сущности; разбор 2026-07-02).
 */
// ─── B2B: детализация KPI-плиток (спека: клик по Исходящие/Принятых/%дозвона/Ожидание) ───
//
// Скоуп и пороги — 1-в-1 с плитками: ростер по агентам (имена + NAME_ALIASES),
// dedup по communication_id (Pattern-A), исходящие = call_out, принятый =
// duration >= 1, ожидание — по отвеченным call%. Платформа определяется по
// префиксу communication_id, который ставит sync-telephony: 'ct:' = CloudTalk,
// 'cg-leg:' = CallGear; остальное (например 'note:' из Kommo) — «Другое».

export interface B2bTileDetails {
  /** Разбивка исходящих по платформам + суммарное время разговора. */
  platforms: Array<{ platform: string; outgoing: number; connected: number; talkSeconds: number }>;
  /** Менеджер × платформа (наборы/принятые), имена канонические (master). */
  managerPlatforms: Array<{ manager: string; platform: string; outgoing: number; connected: number }>;
  /** Почасовка по Берлину: наборы/принятые за каждый час с активностью. */
  hourly: Array<{ hour: number; outgoing: number; connected: number }>;
  /** Ожидание ответа по платформам (по отвеченным звонкам). */
  waitPlatforms: Array<{ platform: string; avgWaitSec: number; maxWaitSec: number; answered: number }>;
  /** Ожидание по менеджерам (канонические имена). */
  waitManagers: Array<{ manager: string; avgWaitSec: number; answered: number }>;
}

const PLATFORM_EXPR = sql`(CASE
  WHEN communication_id LIKE 'ct:%' THEN 'CloudTalk'
  WHEN communication_id LIKE 'cg-leg:%' THEN 'CallGear'
  ELSE 'Другое'
END)`;

export async function getAnalyticsB2bTileDetails(
  managers: Array<{ id: string; name: string }>,
  fromTs: number,
  toTs: number,
): Promise<B2bTileDetails> {
  const managerIds = managers.map((m) => m.id).sort().join(",");
  const cacheKey = `b2b-tile-details:${fromTs}:${toTs}:${managerIds}`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchB2bTileDetails(managers, fromTs, toTs));
}

async function fetchB2bTileDetails(
  managers: Array<{ id: string; name: string }>,
  fromTs: number,
  toTs: number,
): Promise<B2bTileDetails> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);

  // Имена ростера + алиасы; alias → каноническое имя для склейки в выдаче.
  const names: string[] = [];
  const canonical = new Map<string, string>();
  for (const m of managers) {
    names.push(m.name);
    canonical.set(m.name, m.name);
    for (const alias of NAME_ALIASES[m.name] ?? []) {
      names.push(alias);
      canonical.set(alias, m.name);
    }
  }
  const empty: B2bTileDetails = { platforms: [], managerPlatforms: [], hourly: [], waitPlatforms: [], waitManagers: [] };
  if (names.length === 0) return empty;
  const nameList = sql.join(names.map((n) => sql`${n}`), sql`, `);

  // Общий dedup-подзапрос — тот же, что у плиток (fetchCallMetricsByMaster /
  // fetchAvgWaitSeconds). Один SQL-раунд: агрегируем по (platform, manager,
  // берлинский час), остальные срезы складываем в JS — строк максимум
  // платформы × менеджеры × часы, копейки.
  const exec = analyticsDb as unknown as { execute: <T>(q: unknown) => Promise<{ rows: T[] }> };
  const result = await exec.execute<{
    platform: string; manager: string; hour: number;
    outgoing: string; connected: string; talk_s: string;
    answered: string; avg_wait: string | number | null; max_wait: string | number | null;
  }>(sql`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, manager, duration, wait_seconds, created_at
      FROM analytics.communications
      WHERE created_at >= ${fromDate}
        AND created_at <= ${toDate}
        AND manager IN (${nameList})
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      ${PLATFORM_EXPR} AS platform,
      manager,
      EXTRACT(HOUR FROM (created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::int AS hour,
      COUNT(*) FILTER (WHERE communication_type = 'call_out')                                    AS outgoing,
      COUNT(*) FILTER (WHERE communication_type = 'call_out' AND duration >= 1)                  AS connected,
      COALESCE(SUM(${durationExpr("b2b")}) FILTER (WHERE communication_type = 'call_out' AND duration >= 1), 0) AS talk_s,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1)                  AS answered,
      AVG(wait_seconds) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1)         AS avg_wait,
      MAX(wait_seconds) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1)         AS max_wait
    FROM deduped
    GROUP BY 1, 2, 3
  `);

  // JS-свёртки по срезам.
  const pf = new Map<string, { outgoing: number; connected: number; talkSeconds: number }>();
  const mp = new Map<string, { manager: string; platform: string; outgoing: number; connected: number }>();
  const hr = new Map<number, { outgoing: number; connected: number }>();
  const wpf = new Map<string, { sumWait: number; maxWait: number; answered: number }>();
  const wmg = new Map<string, { sumWait: number; answered: number }>();

  for (const r of result.rows) {
    const platform = r.platform;
    const mgr = canonical.get(r.manager) ?? r.manager;
    const outgoing = Number(r.outgoing);
    const connected = Number(r.connected);
    const talkS = Number(r.talk_s);
    const answered = Number(r.answered);
    const avgWait = r.avg_wait == null ? null : Number(r.avg_wait);
    const maxWait = r.max_wait == null ? null : Number(r.max_wait);

    const p = pf.get(platform) ?? { outgoing: 0, connected: 0, talkSeconds: 0 };
    p.outgoing += outgoing; p.connected += connected; p.talkSeconds += talkS;
    pf.set(platform, p);

    const mpKey = `${mgr}::${platform}`;
    const m2 = mp.get(mpKey) ?? { manager: mgr, platform, outgoing: 0, connected: 0 };
    m2.outgoing += outgoing; m2.connected += connected;
    mp.set(mpKey, m2);

    if (outgoing > 0) {
      const h = hr.get(r.hour) ?? { outgoing: 0, connected: 0 };
      h.outgoing += outgoing; h.connected += connected;
      hr.set(r.hour, h);
    }

    if (answered > 0 && avgWait != null) {
      const wp = wpf.get(platform) ?? { sumWait: 0, maxWait: 0, answered: 0 };
      wp.sumWait += avgWait * answered;
      wp.maxWait = Math.max(wp.maxWait, maxWait ?? 0);
      wp.answered += answered;
      wpf.set(platform, wp);

      const wm = wmg.get(mgr) ?? { sumWait: 0, answered: 0 };
      wm.sumWait += avgWait * answered;
      wm.answered += answered;
      wmg.set(mgr, wm);
    }
  }

  return {
    platforms: [...pf.entries()]
      .map(([platform, v]) => ({ platform, ...v }))
      .sort((a, b) => b.outgoing - a.outgoing),
    managerPlatforms: [...mp.values()].sort((a, b) => b.outgoing - a.outgoing),
    hourly: [...hr.entries()]
      .map(([hour, v]) => ({ hour, ...v }))
      .sort((a, b) => a.hour - b.hour),
    waitPlatforms: [...wpf.entries()]
      .map(([platform, v]) => ({
        platform,
        avgWaitSec: v.answered > 0 ? Math.round(v.sumWait / v.answered) : 0,
        maxWaitSec: Math.round(v.maxWait),
        answered: v.answered,
      }))
      .sort((a, b) => b.answered - a.answered),
    waitManagers: [...wmg.entries()]
      .map(([manager, v]) => ({
        manager,
        avgWaitSec: v.answered > 0 ? Math.round(v.sumWait / v.answered) : 0,
        answered: v.answered,
      }))
      .sort((a, b) => b.avgWaitSec - a.avgWaitSec),
  };
}

export async function getAnalyticsAvgWaitSeconds(
  managers: Array<{ id: string; name: string }>,
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<number> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const managerIds = managers.map((m) => m.id).sort().join(",");
  const cacheKey = `avg-wait:${dept}:${fromTs}:${toTs}:${managerIds}:v2`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchAvgWaitSeconds(managers, fromTs, toTs));
}

async function fetchAvgWaitSeconds(
  managers: Array<{ id: string; name: string }>,
  fromTs: number,
  toTs: number,
): Promise<number> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const names: string[] = [];
  for (const m of managers) {
    names.push(m.name);
    for (const alias of NAME_ALIASES[m.name] ?? []) names.push(alias);
  }
  if (names.length === 0) return 0;
  const nameList = sql.join(names.map((n) => sql`${n}`), sql`, `);

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ avg_wait: string | number | null }>(sql`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, duration, wait_seconds
      FROM analytics.communications
      WHERE created_at >= ${fromDate}
        AND created_at <= ${toDate}
        AND manager IN (${nameList})
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
  return cached(cacheKey, ANALYTICS_TTL, () => fetchSlaFirstCallMinutes(pipelineIds, fromTs, toTs, dept === "b2b"));
}

// useOwn=true (B2B) reads our own Бух-Комм SLA (sla_own_seconds, спека Рузанны);
// B2G keeps the integrator-COALESCE value (Looker parity). The SQL expression
// is chosen here so both the value and the IS NOT NULL filter stay consistent.
function slaSourceSql(useOwn: boolean) {
  return useOwn
    ? sql`sla_own_seconds`
    : sql`COALESCE(sla_first_call_seconds_integrator, sla_first_call_seconds)`;
}

async function fetchSlaFirstCallMinutes(pipelineIds: number[], fromTs: number, toTs: number, useOwn: boolean): Promise<number> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);
  const src = slaSourceSql(useOwn);

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ avg_min: string | number | null }>(sql`
    SELECT AVG(${src})::float / 60.0 AS avg_min
    FROM analytics.sla
    WHERE lead_created_at >= ${fromDate}
      AND lead_created_at <= ${toDate}
      AND pipeline_id IN (${pipelineList})
      AND ${src} IS NOT NULL
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
  return cached(cacheKey, ANALYTICS_TTL, () => fetchSlaFirstCallMinutesByManager(managers, pipelineIds, fromTs, toTs, dept === "b2b"));
}

async function fetchSlaFirstCallMinutesByManager(
  managers: Array<{ id: string; name: string }>,
  pipelineIds: number[],
  fromTs: number,
  toTs: number,
  useOwn: boolean,
): Promise<Map<string, number>> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);
  const src = slaSourceSql(useOwn);

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ manager: string | null; avg_min: string | number | null }>(sql`
    SELECT
      manager,
      AVG(${src})::float / 60.0 AS avg_min
    FROM analytics.sla
    WHERE lead_created_at >= ${fromDate}
      AND lead_created_at <= ${toDate}
      AND pipeline_id IN (${pipelineList})
      AND ${src} IS NOT NULL
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
  managers: Array<{ id: string; name: string }>,
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<number> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const managerIds = managers.map((m) => m.id).sort().join(",");
  const cacheKey = `lost-calls:${dept}:${fromTs}:${toTs}:${managerIds}:v2`;
  return cached(cacheKey, ANALYTICS_TTL, async () => {
    const rows = await fetchLostCallsDetail(managers, fromTs, toTs);
    return rows.length;
  });
}

/** Одна строка детализации «Потерянных» (спека 22 п.6). */
export interface LostCallDetailRow {
  manager: string | null;
  phone: string;
  createdAt: string;          // ISO UTC
  leadId: number | null;      // NULL если звонок не привязан к сделке
  pipelineName: string | null;
  statusName: string | null;
  /** ФИ клиента из зеркала контактов (по сделке или по номеру). */
  clientName: string | null;
}

/** ФИ контактов по нормализованным номерам (последние 10 цифр) из зеркала
 *  analytics.contacts — для строк без привязки к сделке. Один запрос на
 *  пачку номеров. */
async function contactNamesByPnorm(pnorms: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const uniq = [...new Set(pnorms.filter((p) => p && p.length >= 6))];
  if (uniq.length === 0) return map;
  const json = JSON.stringify(uniq.map((p) => ({ pnorm: p })));
  const res = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ pnorm: string; name: string | null }>(sql`
    WITH input AS (
      SELECT i.pnorm FROM jsonb_to_recordset(${json}::jsonb) AS i(pnorm text)
    ),
    contact_phones AS (
      SELECT c.contact_id, c.name,
             right(regexp_replace(p.v, '\D', '', 'g'), 10) AS pnorm
      FROM analytics.contacts c,
           jsonb_array_elements_text(COALESCE(c.phones_all, '[]'::jsonb)) AS p(v)
    )
    SELECT DISTINCT ON (i.pnorm) i.pnorm, cp.name
    FROM input i
    JOIN contact_phones cp ON cp.pnorm = i.pnorm
    ORDER BY i.pnorm, cp.contact_id
  `);
  for (const r of res.rows) {
    if (r.name) map.set(r.pnorm, r.name);
  }
  return map;
}

/**
 * Детализация «Потерянных» для drill-down плитки (спека 22 п.6): строки
 * менеджер/телефон/время/сделка. Счётчик плитки = length этого же списка
 * (getAnalyticsLostCalls) — расхождение невозможно по построению.
 *
 * Скоуп — ПО АГЕНТАМ (ростер + алиасы): прежний «воронки + NULL» тащил в
 * «Потерянные» необогащённые звонки чужого отдела (30.06 половина из 105
 * были звонками b2g-дайлера) и продления. Перезвон-проверка намеренно шире
 * ростера: перезвон на номер ЛЮБЫМ сотрудником снимает «потерянность».
 * LATERAL LIMIT 1 — на случай дублей лида в cohort.
 */
export async function getAnalyticsLostCallsDetail(
  managers: Array<{ id: string; name: string }>,
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<LostCallDetailRow[]> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const managerIds = managers.map((m) => m.id).sort().join(",");
  const cacheKey = `lost-calls-detail:${dept}:${fromTs}:${toTs}:${managerIds}:v2`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchLostCallsDetail(managers, fromTs, toTs));
}

async function fetchLostCallsDetail(
  managers: Array<{ id: string; name: string }>,
  fromTs: number,
  toTs: number,
): Promise<LostCallDetailRow[]> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const names: string[] = [];
  for (const m of managers) {
    names.push(m.name);
    for (const alias of NAME_ALIASES[m.name] ?? []) names.push(alias);
  }
  if (names.length === 0) return [];
  const nameList = sql.join(names.map((n) => sql`${n}`), sql`, `);

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{
    manager: string | null;
    phone: string;
    created_at: string;
    lead_id: string | number | null;
    pipeline_name: string | null;
    status_name: string | null;
  }>(sql`
    WITH outs AS (
      SELECT DISTINCT ON (communication_id)
        communication_id,
        created_at,
        duration,
        manager,
        lead_id,
        phone,
        right(regexp_replace(phone, '\D', '', 'g'), 10) AS pnorm
      FROM analytics.communications
      WHERE created_at >= ${fromDate}
        AND created_at <= ${toDate}
        AND communication_type = 'call_out'
        AND manager IN (${nameList})
        AND phone IS NOT NULL AND phone <> ''
      ORDER BY communication_id, lead_id NULLS LAST
    ),
    candidates AS (
      SELECT communication_id, created_at, pnorm, manager, lead_id, phone
      FROM outs
      WHERE (duration IS NULL OR duration < 1)
        AND pnorm <> ''
        AND EXTRACT(hour FROM (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')) >= 9
        AND EXTRACT(hour FROM (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')) < 19
    )
    SELECT
      c.manager,
      c.phone,
      c.pnorm,
      c.created_at,
      c.lead_id,
      lc.pipeline AS pipeline_name,
      lc.status AS status_name,
      ln.name AS client_name
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT pipeline, status FROM analytics.leads_cohort
      WHERE lead_id = c.lead_id LIMIT 1
    ) lc ON c.lead_id IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT ct.name FROM analytics.lead_contact_links ll
      JOIN analytics.contacts ct ON ct.contact_id = ll.contact_id
      WHERE ll.lead_id = c.lead_id AND ll.is_active
      ORDER BY ll.last_seen_at DESC LIMIT 1
    ) ln ON c.lead_id IS NOT NULL
    WHERE NOT EXISTS (
      SELECT 1
      FROM analytics.communications cb
      WHERE cb.communication_type = 'call_out'
        AND cb.communication_id <> c.communication_id
        AND cb.created_at > c.created_at
        AND cb.created_at <= c.created_at + interval '15 minutes'
        AND right(regexp_replace(cb.phone, '\D', '', 'g'), 10) = c.pnorm
    )
    ORDER BY c.manager NULLS LAST, c.created_at
  `);

  // ФИ для строк без сделки — одним batch-запросом по номерам.
  type Row = (typeof result.rows)[number] & { pnorm?: string; client_name?: string | null };
  const rows = result.rows as Row[];
  const unlinkedPnorms = rows
    .filter((r) => r.lead_id == null && r.pnorm)
    .map((r) => String(r.pnorm));
  const nameByPnorm = await contactNamesByPnorm(unlinkedPnorms);

  return rows.map((r) => {
    // created_at — timestamp WITHOUT time zone (naive = UTC по конвенции
    // проекта). Драйвер отдаёт строку без пояса; new Date(naive) парсил бы
    // её в TZ процесса — прибиваем к UTC явно.
    const raw = String(r.created_at);
    const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
    const hasTz = iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso);
    return {
      manager: r.manager,
      phone: r.phone,
      createdAt: new Date(hasTz ? iso : `${iso}Z`).toISOString(),
      leadId: r.lead_id == null ? null : Number(r.lead_id),
      pipelineName: r.pipeline_name,
      statusName: r.status_name,
      clientName:
        r.client_name ?? (r.pnorm ? nameByPnorm.get(String(r.pnorm)) ?? null : null),
    };
  });
}

/** Одна строка детализации SLA (спека 22 п.5.3). */
export interface SlaLeadDetailRow {
  leadId: number;
  manager: string | null;
  slaMinutes: number;
  /** measured | instant | pending | closed_no_call */
  slaStatus: string | null;
  clientName: string | null;
  phone: string | null;
  pipelineId: number | null;
}

/**
 * Детализация SLA-плитки (drill-down): сделки, из которых состоит среднее.
 * Тот же скоуп, что у плитки (getAnalyticsSlaFirstCallMinutes для b2b:
 * лиды воронок отдела, созданные в окне, sla_own_seconds IS NOT NULL) —
 * среднее по списку всегда равно плитке. ФИ/телефон — из зеркала контактов
 * по активной связи сделки.
 */
export async function getAnalyticsSlaLeadsDetail(
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<SlaLeadDetailRow[]> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const pipelineIds = getPipelineIds(dept);
  if (pipelineIds.length === 0) return [];
  const cacheKey = `sla-leads-detail:${dept}:${fromTs}:${toTs}`;
  return cached(cacheKey, ANALYTICS_TTL, async () => {
    const fromDate = new Date(fromTs * 1000);
    const toDate = new Date(toTs * 1000);
    const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);
    const src = slaSourceSql(dept === "b2b");

    const result = await (analyticsDb as unknown as {
      execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
    }).execute<{
      lead_id: string | number;
      manager: string | null;
      sla_min: string | number;
      sla_status: string | null;
      client_name: string | null;
      client_phone: string | null;
      pipeline_id: string | number | null;
    }>(sql`
      SELECT
        s.lead_id,
        s.manager,
        round(${src}::numeric / 60) AS sla_min,
        s.sla_own_status AS sla_status,
        ct.name AS client_name,
        ct.phone AS client_phone,
        s.pipeline_id
      FROM analytics.sla s
      LEFT JOIN LATERAL (
        SELECT c.name, c.phone
        FROM analytics.lead_contact_links ll
        JOIN analytics.contacts c ON c.contact_id = ll.contact_id
        WHERE ll.lead_id = s.lead_id AND ll.is_active
        ORDER BY ll.last_seen_at DESC LIMIT 1
      ) ct ON TRUE
      WHERE s.lead_created_at >= ${fromDate}
        AND s.lead_created_at <= ${toDate}
        AND s.pipeline_id IN (${pipelineList})
        AND ${src} IS NOT NULL
      ORDER BY s.manager NULLS LAST, sla_min DESC
    `);

    return result.rows.map((r) => ({
      leadId: Number(r.lead_id),
      manager: r.manager,
      slaMinutes: Number(r.sla_min),
      slaStatus: r.sla_status,
      clientName: r.client_name,
      phone: r.client_phone,
      pipelineId: r.pipeline_id == null ? null : Number(r.pipeline_id),
    }));
  });
}

/**
 * Inbound calls attributed to a department BY NUMBER — matching CloudTalk's
 * group report (incoming calls belong to a group by the line dialed, including
 * missed/queue calls nobody answered). Counts call_in rows whose CloudTalk
 * line_name starts with the dept prefix (KOM = Коммерсы, GOS = Госники),
 * deduped by communication_id. B2B inbound is CloudTalk-only, so this is where
 * the missed inbound (no-agent rows) get counted that the per-agent path drops.
 */
const LINE_PREFIX: Record<string, string> = { b2b: "KOM", b2g: "GOS" };

export async function getAnalyticsInboundByLine(
  department: "b2g" | "b2b" | string,
  fromTs: number,
  toTs: number,
): Promise<number> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  const cacheKey = `inbound-by-line:${dept}:${fromTs}:${toTs}`;
  return cached(cacheKey, ANALYTICS_TTL, () => fetchInboundByLine(LINE_PREFIX[dept], fromTs, toTs));
}

async function fetchInboundByLine(prefix: string, fromTs: number, toTs: number): Promise<number> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const like = `${prefix}%`;
  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ n: string | number }>(sql`
    SELECT COUNT(DISTINCT communication_id) AS n
    FROM analytics.communications
    WHERE created_at >= ${fromDate}
      AND created_at <= ${toDate}
      AND communication_type = 'call_in'
      AND line_name LIKE ${like}
  `);
  return Number(result.rows[0]?.n ?? 0);
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
