// Shared logic for building Daily API responses
// Used by both /api/daily and /api/daily/range routes
import { cached } from "@/lib/kommo/cache";
import { getTasks } from "@/lib/kommo/client";
import {
  aggregateLeadFunnelMetrics,
  aggregateTaskMetrics,
  sumCallMetrics,
  hasCategoryLetter,
  type UserCallMetrics,
} from "@/lib/kommo/metrics";
import { getAnalyticsCallMetricsByMaster, getAnalyticsTeamCallMetrics, getFrozenLeadsCombined, getOverdueTasksByManager, getManagersWithKommoForPeriod } from "@/lib/daily/analytics-calls";
import { getPlans, getScheduleForDate, getUniqueOnLineManagerCount } from "@/lib/db/queries-daily";
import { getDailySections } from "@/lib/daily/metrics-config";
import {
  getPipelineIds,
  getActiveStatusIds,
  B2B_PIPELINES,
  getFirstLinePipelineIds,
  getBeraterPipelineIds,
  getFirstLineStatusSets,
  getBeraterStatusSets,
  getQualTierStatuses,
  getFunnelStatusMap,
  type Vertical,
} from "@/lib/kommo/pipeline-config";
import { resolveByAlias } from "@/lib/daily/name-aliases";
import { getB2BPipelineStatsSQL, getB2BPerManagerStatsSQL, type B2BPipelineStats as B2BStatsSQL } from "@/lib/daily/analytics-b2b";
import { B2B_FIXED_PLAN_DEFAULTS } from "@/lib/daily/metrics-config-b2b";
import { getAnalyticsLeads, getAnalyticsStatusChangeCount } from "@/lib/daily/analytics-leads";
import { reconstructSnapshotAt, type HistoricalSnapshot } from "@/lib/daily/historical-snapshot";
import { parseDateBoundary } from "@/lib/utils/date";

/** APP_TZ-aware month bounds in epoch seconds. Replaces the hand-rolled
 *  Date.UTC(y, m, 0, 23, 59, 59) pattern that leaked 1–2 Berlin hours into
 *  the next month depending on DST. */
function monthBoundsSec(dateStr: string): { start: number; end: number } {
  const [y, m] = dateStr.split("-").map(Number);
  const firstDay = `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDayNum = new Date(y, m, 0).getDate();
  const lastDay = `${y}-${String(m).padStart(2, "0")}-${String(lastDayNum).padStart(2, "0")}`;
  const startD = parseDateBoundary(firstDay, "start");
  const endD = parseDateBoundary(lastDay, "end");
  return {
    start: startD ? Math.floor(startD.getTime() / 1000) : 0,
    end: endD ? Math.floor(endD.getTime() / 1000) : 0,
  };
}
import type { LeadFunnelCounts } from "@/lib/kommo/metrics";
import type { KommoLead, KommoTask } from "@/lib/kommo/types";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkEvaluations, okkCalls } from "@/lib/db/schema-okk";
import { getDbForDepartment } from "@/lib/db";
import { d1Calls, r1Calls } from "@/lib/db/schema-existing";
import { analyticsDb } from "@/lib/db/analytics";
import { sql as drizzleSql } from "drizzle-orm";

// ==================== Timezone helpers ====================

/** Business timezone — all date ranges are computed in this timezone */
const BUSINESS_TZ = "Europe/Berlin";

/**
 * Get UTC offset in milliseconds for a given date in the business timezone.
 * Handles DST automatically (CET = UTC+1, CEST = UTC+2).
 */
function getTzOffsetMs(date: Date): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = date.toLocaleString("en-US", { timeZone: BUSINESS_TZ });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}

/**
 * Convert a business-timezone date string to UTC Unix timestamps for start/end of day.
 * Example: "2026-04-08" in Europe/Berlin (CEST, UTC+2) →
 *   from = April 7 22:00 UTC, to = April 8 21:59:59 UTC
 */
function businessDayToUtc(dateStr: string): { from: number; to: number } {
  const midnightUtc = new Date(`${dateStr}T00:00:00Z`);
  const offsetMs = getTzOffsetMs(midnightUtc);
  const startMs = midnightUtc.getTime() - offsetMs;
  const endMs = startMs + 24 * 60 * 60 * 1000 - 1;
  return {
    from: Math.floor(startMs / 1000),
    to: Math.floor(endMs / 1000),
  };
}

/** Get today's date string in business timezone */
export function getBusinessToday(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

// ==================== OKK / Roleplay avg score helpers ====================

// Cache TTLs. OKK/Roleplay scores are recomputed slowly (human evaluators
// behind them); caching for 5 minutes eats a whole burst of Daily views
// without noticeably stale numbers. SLA/AvgCalls/Refusal facts change
// continuously through the day, so 60 s is safer.
const SCORES_TTL = 5 * 60 * 1000;
const ANALYTICS_FACTS_TTL = 60 * 1000;

/** Combined team + per-manager OKK avg scores in a single round-trip.
 *  Uses GROUPING SETS so team (manager_id IS NULL via GROUPING()) and
 *  per-manager rows come back together — halves round-trips vs. the old
 *  getOkkAvgScore + getOkkPerManagerScores pair. Cached per
 *  (department, from, to, promptTypes) so repeat callers in the same
 *  request share a single DB hit. */
async function getOkkScores(
  department: "b2g" | "b2b",
  fromTs: number,
  toTs: number,
  promptTypes: string[],
): Promise<{ team: number | null; perManager: Map<string, number> }> {
  const empty = { team: null as number | null, perManager: new Map<string, number>() };
  if (promptTypes.length === 0) return empty;
  const key = `okk-scores:${department}:${fromTs}:${toTs}:${[...promptTypes].sort().join(",")}`;
  return cached(key, SCORES_TTL, () => fetchOkkScores(department, fromTs, toTs, promptTypes));
}

async function fetchOkkScores(
  department: "b2g" | "b2b",
  fromTs: number,
  toTs: number,
  promptTypes: string[],
): Promise<{ team: number | null; perManager: Map<string, number> }> {
  const empty = { team: null as number | null, perManager: new Map<string, number>() };
  try {
    const db = getOkkDbForDepartment(department);
    const from = new Date(fromTs * 1000);
    const to = new Date(toTs * 1000);
    const promptList = drizzleSql.join(promptTypes.map(p => drizzleSql`${p}`), drizzleSql`, `);
    const rows = await (db as unknown as {
      execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
    }).execute<{ manager_id: string | null; is_total: number; avg: number | null }>(drizzleSql`
      SELECT
        ${okkEvaluations.managerId}                         AS manager_id,
        GROUPING(${okkEvaluations.managerId})::int          AS is_total,
        ROUND(AVG(${okkEvaluations.totalScore}))::int       AS avg
      FROM ${okkEvaluations}
      INNER JOIN ${okkCalls} ON ${okkEvaluations.callId} = ${okkCalls.id}
      WHERE ${okkCalls.callCreatedAt} >= ${from}
        AND ${okkCalls.callCreatedAt} <= ${to}
        AND ${okkEvaluations.totalScore} IS NOT NULL
        AND ${okkEvaluations.promptType} IN (${promptList})
      GROUP BY GROUPING SETS ((), (${okkEvaluations.managerId}))
    `);
    const perManager = new Map<string, number>();
    let team: number | null = null;
    for (const r of rows.rows) {
      if (r.is_total === 1) {
        team = r.avg != null ? Number(r.avg) : null;
      } else if (r.manager_id && r.avg != null) {
        perManager.set(r.manager_id, Number(r.avg));
      }
    }
    return { team, perManager };
  } catch (e) {
    // Залогируем, чтобы не терять диагностику: если D2/R2 env-var не задан
    // или Neon в ретрае, OKK тихо возвращал null и Daily показывал пусто.
    console.error(`[OKK] getOkkScores(${department}, [${promptTypes.join(",")}]) failed:`, e instanceof Error ? e.message : e);
    return empty;
  }
}

/** Combined team + per-manager roleplay avg scores via GROUPING SETS.
 *  Cached the same way as getOkkScores. */
async function getRoleplayScores(
  department: "b2g" | "b2b",
  fromTs: number,
  toTs: number,
  callTypes: string[],
): Promise<{ team: number | null; perManager: Map<string, number> }> {
  const empty = { team: null as number | null, perManager: new Map<string, number>() };
  if (callTypes.length === 0) return empty;
  const key = `roleplay-scores:${department}:${fromTs}:${toTs}:${[...callTypes].sort().join(",")}`;
  return cached(key, SCORES_TTL, () => fetchRoleplayScores(department, fromTs, toTs, callTypes));
}

async function fetchRoleplayScores(
  department: "b2g" | "b2b",
  fromTs: number,
  toTs: number,
  callTypes: string[],
): Promise<{ team: number | null; perManager: Map<string, number> }> {
  const empty = { team: null as number | null, perManager: new Map<string, number>() };
  try {
    const db = getDbForDepartment(department);
    const callsTable = department === "b2b" ? r1Calls : d1Calls;
    const from = new Date(fromTs * 1000);
    const to = new Date(toTs * 1000);
    const typesList = drizzleSql.join(callTypes.map(t => drizzleSql`${t}`), drizzleSql`, `);
    const rows = await (db as unknown as {
      execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
    }).execute<{ user_id: string | null; is_total: number; avg: number | null }>(drizzleSql`
      SELECT
        ${callsTable.userId}                                  AS user_id,
        GROUPING(${callsTable.userId})::int                   AS is_total,
        ROUND(AVG(${callsTable.score}))::int                  AS avg
      FROM ${callsTable}
      WHERE ${callsTable.startedAt} >= ${from}
        AND ${callsTable.startedAt} <= ${to}
        AND ${callsTable.score} IS NOT NULL
        AND ${callsTable.callType} IN (${typesList})
      GROUP BY GROUPING SETS ((), (${callsTable.userId}))
    `);
    const perManager = new Map<string, number>();
    let team: number | null = null;
    for (const r of rows.rows) {
      if (r.is_total === 1) {
        team = r.avg != null ? Number(r.avg) : null;
      } else if (r.user_id && r.avg != null) {
        perManager.set(r.user_id, Number(r.avg));
      }
    }
    return { team, perManager };
  } catch (e) {
    console.error(`[Roleplay] getRoleplayScores(${department}, [${callTypes.join(",")}]) failed:`, e instanceof Error ? e.message : e);
    return empty;
  }
}

/** Shape returned by the SLA/TLT queries. Seconds at the source, converted
 *  to minutes here to match the existing callers. Naming stays *Minutes for
 *  backwards compatibility even though the UI formatter now prefers raw
 *  seconds for HH:MM:SS display — see note on formatSlaValue in DailyTab. */
interface SlaFacts {
  slaMinutes: number | null;
  slaShiftMinutes: number | null;
  tltMinutes: number | null;
  /** Raw seconds — preserved so the UI can render HH:MM:SS without
   *  losing precision to integer-minute rounding. null when no data. */
  slaSeconds: number | null;
  slaShiftSeconds: number | null;
  tltSeconds: number | null;
}

const EMPTY_SLA: SlaFacts = {
  slaMinutes: null, slaShiftMinutes: null, tltMinutes: null,
  slaSeconds: null, slaShiftSeconds: null, tltSeconds: null,
};

/** Combined team + per-manager SLA/TLT for a pipeline in a single round-trip.
 *  GROUPING SETS ((), (manager)) returns the team aggregate (is_total=1) and
 *  per-manager rows together. Replaces getSlaFacts + getSlaFactsByManager.
 *  Cached per (pipeline, fromTs, toTs, managerIds) — per-manager alias
 *  resolution is the only per-request work, rest comes from DB once. */
async function getSlaFactsCombined(
  managers: Array<{ id: string; name: string }>,
  pipelineId: number | number[],
  fromDate: Date,
  toDate: Date,
): Promise<{ team: SlaFacts; perManager: Map<string, SlaFacts> }> {
  const pipelineIds = Array.isArray(pipelineId) ? pipelineId : [pipelineId];
  const managerIds = managers.map((m) => m.id).sort().join(",");
  const key = `sla-combined:${pipelineIds.join("+")}:${fromDate.getTime()}:${toDate.getTime()}:${managerIds}`;
  return cached(key, ANALYTICS_FACTS_TTL, () => fetchSlaFactsCombined(managers, pipelineIds, fromDate, toDate));
}

async function fetchSlaFactsCombined(
  managers: Array<{ id: string; name: string }>,
  pipelineIds: number[],
  fromDate: Date,
  toDate: Date,
): Promise<{ team: SlaFacts; perManager: Map<string, SlaFacts> }> {
  try {
    const result = await (analyticsDb as { execute: <T>(sql: unknown) => Promise<{ rows: T[] }> }).execute<{
      manager: string | null;
      is_total: number;
      avg_sla_s: number | null;
      avg_sla_shift_s: number | null;
      avg_tlt_s: number | null;
    }>(
      drizzleSql`
        SELECT
          manager                                          AS manager,
          GROUPING(manager)::int                           AS is_total,
          round(avg(sla_first_call_seconds))::int          AS avg_sla_s,
          round(avg(sla_first_call_from_shift_seconds))::int AS avg_sla_shift_s,
          round(avg(business_hours_since_last_contact))::int AS avg_tlt_s
        FROM analytics.sla
        WHERE pipeline_id IN (${drizzleSql.join(pipelineIds.map((p) => drizzleSql`${p}`), drizzleSql`, `)})
          AND lead_created_at >= ${fromDate}
          AND lead_created_at <= ${toDate}
          AND sla_first_call_seconds IS NOT NULL
        GROUP BY GROUPING SETS ((), (manager))
      `,
    );
    let team: SlaFacts = EMPTY_SLA;
    const byName = new Map<string, SlaFacts>();
    for (const row of result.rows) {
      const facts: SlaFacts = {
        slaSeconds: row.avg_sla_s != null ? Number(row.avg_sla_s) : null,
        slaShiftSeconds: row.avg_sla_shift_s != null ? Number(row.avg_sla_shift_s) : null,
        tltSeconds: row.avg_tlt_s != null ? Number(row.avg_tlt_s) : null,
        slaMinutes: row.avg_sla_s != null ? Math.round(Number(row.avg_sla_s) / 60) : null,
        slaShiftMinutes: row.avg_sla_shift_s != null ? Math.round(Number(row.avg_sla_shift_s) / 60) : null,
        tltMinutes: row.avg_tlt_s != null ? Math.round(Number(row.avg_tlt_s) / 60) : null,
      };
      if (row.is_total === 1) {
        team = facts;
      } else if (row.manager) {
        byName.set(row.manager, facts);
      }
    }
    return { team, perManager: resolveByAlias(managers, byName) };
  } catch {
    return { team: EMPTY_SLA, perManager: new Map() };
  }
}

/** Refusal-reason breakdown for closed leads in a pipeline during a date range.
 *  Combines two sources to catch all leads (Kommo users rarely fill system
 *  loss_reason_id — the detailed reason lives in custom field 879824 instead):
 *    1. `leads_cohort.loss_reason` — text from system loss_reason_id lookup.
 *    2. `leads_cohort.non_qual_enum_id` → `refusal_enums.value` — custom-field enum.
 *  Per-lead: if both are set we count the enum-field value (more specific);
 *  if only text is set we fall back to it. */
async function getRefusalReasons(
  pipelineId: number | number[],
  fromDate: Date,
  toDate: Date,
): Promise<Array<{ reason: string; count: number; percent: number }>> {
  const pipelineIds = Array.isArray(pipelineId) ? pipelineId : [pipelineId];
  const key = `refusal-reasons:${pipelineIds.join("+")}:${fromDate.getTime()}:${toDate.getTime()}`;
  return cached(key, ANALYTICS_FACTS_TTL, () => fetchRefusalReasons(pipelineIds, fromDate, toDate));
}

async function fetchRefusalReasons(
  pipelineIds: number[],
  fromDate: Date,
  toDate: Date,
): Promise<Array<{ reason: string; count: number; percent: number }>> {
  try {
    const result = await (analyticsDb as { execute: <T>(sql: unknown) => Promise<{ rows: T[] }> }).execute<{
      reason: string;
      cnt: number | string;
    }>(
      drizzleSql`
        WITH closed AS (
          SELECT
            COALESCE(
              NULLIF(re.value, ''),
              NULLIF(lc.loss_reason, '')
            ) AS reason
          FROM analytics.leads_cohort lc
          LEFT JOIN analytics.refusal_enums re ON re.enum_id = lc.non_qual_enum_id
          WHERE lc.pipeline_id IN (${drizzleSql.join(pipelineIds.map((p) => drizzleSql`${p}`), drizzleSql`, `)})
            AND lc.status_id = 143
            AND lc.closed_at >= ${fromDate}
            AND lc.closed_at <= ${toDate}
        )
        SELECT reason, COUNT(*)::int AS cnt
        FROM closed
        WHERE reason IS NOT NULL AND reason <> ''
        GROUP BY reason
        ORDER BY cnt DESC
      `,
    );
    const rows = result.rows.map((r) => ({ reason: r.reason, count: Number(r.cnt) }));
    const total = rows.reduce((s, r) => s + r.count, 0);
    return rows.map((r) => ({
      reason: r.reason,
      count: r.count,
      percent: total > 0 ? Math.round((r.count / total) * 1000) / 10 : 0,
    }));
  } catch {
    return [];
  }
}

/** Combined team + per-manager avg calls per lead via GROUPING SETS.
 *  Team row (manager IS NULL, is_total=1) and per-manager rows come back
 *  together — replaces the old getAvgCallsPerLead + getAvgCallsPerLeadByManager pair. */
async function getAvgCallsPerLeadCombined(
  managers: Array<{ id: string; name: string }>,
  pipelineId: number | number[],
  fromDate: Date,
  toDate: Date,
): Promise<{ team: number | null; perManager: Map<string, number> }> {
  const pipelineIds = Array.isArray(pipelineId) ? pipelineId : [pipelineId];
  const managerIds = managers.map((m) => m.id).sort().join(",");
  const key = `acpl-combined:${pipelineIds.join("+")}:${fromDate.getTime()}:${toDate.getTime()}:${managerIds}`;
  return cached(key, ANALYTICS_FACTS_TTL, () => fetchAvgCallsPerLeadCombined(managers, pipelineIds, fromDate, toDate));
}

async function fetchAvgCallsPerLeadCombined(
  managers: Array<{ id: string; name: string }>,
  pipelineIds: number[],
  fromDate: Date,
  toDate: Date,
): Promise<{ team: number | null; perManager: Map<string, number> }> {
  try {
    // Post-hard-split (2026-04-28) telephony rows have lead_id=NULL — the
    // CDR call happens before/outside any Kommo lead context. The
    // `lead_id IS NOT NULL` guard below excludes them, so this metric
    // currently only counts the (now-empty) Kommo call-note set and
    // returns zero. Permanent fix: enrich telephony rows with lead_id via
    // phone-match in sync-telephony, OR replace this metric with
    // (calls_with_phone_in_lead_set) / (active_leads). For now: known
    // degradation, returns null and the widget renders "—".
    const result = await (analyticsDb as { execute: <T>(sql: unknown) => Promise<{ rows: T[] }> }).execute<{
      manager: string | null;
      is_total: number;
      total_calls: number | string;
      unique_leads: number | string;
    }>(
      drizzleSql`
        SELECT
          manager                        AS manager,
          GROUPING(manager)::int         AS is_total,
          COUNT(*)::int                  AS total_calls,
          COUNT(DISTINCT lead_id)::int   AS unique_leads
        FROM analytics.communications
        WHERE pipeline_id IN (${drizzleSql.join(pipelineIds.map((p) => drizzleSql`${p}`), drizzleSql`, `)})
          AND created_at >= ${fromDate}
          AND created_at <= ${toDate}
          AND communication_type LIKE 'call%'
          AND lead_id IS NOT NULL
        GROUP BY GROUPING SETS ((), (manager))
      `,
    );
    let team: number | null = null;
    const byName = new Map<string, number>();
    for (const row of result.rows) {
      const t = Number(row.total_calls);
      const u = Number(row.unique_leads);
      if (u <= 0) continue;
      const avg = Math.round((t / u) * 10) / 10;
      if (row.is_total === 1) {
        team = avg;
      } else if (row.manager) {
        byName.set(row.manager, avg);
      }
    }
    return { team, perManager: resolveByAlias(managers, byName) };
  } catch {
    return { team: null, perManager: new Map() };
  }
}

// Line → OKK prompt types mapping.
// Derived from tenant config so new lines in src/lib/config/tenant.ts
// automatically flow through to Daily without touching this file.
import { groupPromptTypes } from "@/lib/config/tenant";

function lineToOkkPrompts(group: string, vertical?: Vertical): string[] {
  // B2G-only in the current setup; if B2B Daily rolls out, call with "b2b".
  // Мед-линии в tenant.ts имеют group='med1'/'med2'/'med3' — зеркало буховых
  // групп '1'/'2'/'3'. В режиме Мед берём мед-промпты, в «Все» — union.
  const buh = groupPromptTypes("b2g", group);
  if (vertical !== "med" && vertical !== "all") return buh; // buh / legacy
  const med = groupPromptTypes("b2g", `med${group}`);
  return vertical === "med" ? med : [...buh, ...med];
}

// Line → roleplay call types mapping
const LINE_TO_ROLEPLAY_TYPES: Record<string, string[]> = {
  "1": ["qualifier"],
  "2": ["berater"],
  "3": ["dovedenie"],
};

// ==================== Period helpers ====================

function getDateRange(
  period: string,
  dateStr: string
): { from: number; to: number; periodType: string; periodDate: string } {
  const [yearNum, monthNum] = dateStr.split("-").map(Number);

  switch (period) {
    case "week": {
      const base = new Date(`${dateStr}T12:00:00Z`);
      const day = base.getUTCDay();
      const diff = day === 0 ? -6 : 1 - day;
      const monday = new Date(base);
      monday.setUTCDate(base.getUTCDate() + diff);
      const mondayStr = monday.toISOString().slice(0, 10);
      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      const sundayStr = sunday.toISOString().slice(0, 10);

      const { from } = businessDayToUtc(mondayStr);
      const { to } = businessDayToUtc(sundayStr);
      const weekNum = getISOWeek(monday);
      return {
        from,
        to,
        periodType: "week",
        periodDate: `${monday.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`,
      };
    }
    case "month": {
      const firstDayStr = `${yearNum}-${String(monthNum).padStart(2, "0")}-01`;
      const lastDayNum = new Date(yearNum, monthNum, 0).getDate();
      const lastDayStr = `${yearNum}-${String(monthNum).padStart(2, "0")}-${String(lastDayNum).padStart(2, "0")}`;

      const { from } = businessDayToUtc(firstDayStr);
      const { to } = businessDayToUtc(lastDayStr);
      return {
        from,
        to,
        periodType: "month",
        periodDate: `${yearNum}-${String(monthNum).padStart(2, "0")}`,
      };
    }
    case "year": {
      const { from } = businessDayToUtc(`${yearNum}-01-01`);
      const { to } = businessDayToUtc(`${yearNum}-12-31`);
      return {
        from,
        to,
        periodType: "year",
        periodDate: String(yearNum),
      };
    }
    default: {
      const { from, to } = businessDayToUtc(dateStr);
      return {
        from,
        to,
        periodType: "day",
        periodDate: dateStr,
      };
    }
  }
}

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

// getMaxPages removed: Kommo pagination cap no longer relevant — all lead
// fetches now go through analytics.leads_cohort SQL (single round-trip).

function buildUserFacts(
  callMetrics: UserCallMetrics | undefined,
  taskOverdue: number,
): Record<string, string> {
  const facts: Record<string, string> = {};
  if (callMetrics) {
    facts.callsTotal = String(callMetrics.callsTotal);
    facts.callsConnected = String(callMetrics.callsConnected);
    facts.dialPercent = String(callMetrics.dialPercent);
    facts.missedIncoming = String(callMetrics.missedIncoming);
    facts.totalMinutes = String(callMetrics.totalMinutes);
    facts.avgDialogMinutes = String(callMetrics.avgDialogMinutes);
  }
  facts.overdueTasks = String(taskOverdue);
  return facts;
}

// ==================== Response cache ====================
// 30s TTL — just enough to absorb burst requests (e.g. 10 users open Daily
// at once = 1 SQL fan-out instead of 10). With analytics.* serving sub-second
// queries there's no benefit to a longer TTL; shorter means fresher data.
const RESPONSE_CACHE_TTL = 30 * 1000;

/** Track Kommo API failures for diagnostics */
let _lastKommoError: { message: string; at: string } | null = null;
export function getLastKommoError() { return _lastKommoError; }

export async function buildDailyResponseCached(department: string, period: string, dateStr: string, vertical?: Vertical) {
  // daily_snapshots removed: analytics.* is now the single source of truth,
  // so every request recomputes from Postgres directly (sub-second). We keep
  // a 5-minute in-memory TTL per department+period+date to absorb bursts.
  //
  // isHistorical: период считается историческим, если его конец в прошлом.
  // Это триггерит реконструкцию activeDeals/awaitTerm (closed+active на дату),
  // иначе snapshot-метрики одинаковы для любой даты (всегда "сейчас"). Для
  // текущего дня/недели/месяца остаётся live snapshot.
  const { to } = getDateRange(period, dateStr);
  const nowSec = Math.floor(Date.now() / 1000);
  const isHistorical = to < nowSec;
  const cacheKey = `daily-response:${department}:${vertical ?? "legacy"}:${period}:${dateStr}`;
  return cached(cacheKey, RESPONSE_CACHE_TTL, () =>
    buildDailyResponse(department, period, dateStr, isHistorical, vertical),
  );
}

// ==================== MAIN BUILD FUNCTION ====================

/**
 * @param isHistorical — true for past dates without stored snapshots.
 *   Skips non-date-filtered Kommo calls (snapshot leads, tasks) that would
 *   return today's data instead of the historical date's data.
 *   Affected metrics get fact=null so the UI shows "—" instead of wrong numbers.
 */
export async function buildDailyResponse(department: string, period: string, dateStr: string, isHistorical = false, vertical?: Vertical) {
  const { from, to, periodType, periodDate } = getDateRange(period, dateStr);
  // getMaxPages was used for Kommo pagination caps; no longer needed now that
  // leads come from analytics.leads_cohort (single SQL query, no pagination).

  // Вертикаль осмысленна только для b2g (spec 21); для b2b сбрасываем.
  // Без vertical → legacy-набор (byte-identical прежнему поведению).
  const v = department === "b2g" ? vertical : undefined;

  // Department-aware pipeline/status IDs (vertical-aware для b2g)
  const allPipelineIds = getPipelineIds(department, v);
  const allActiveStatusIds = getActiveStatusIds(department, v);
  const firstLinePipelineIds = department === "b2b" ? [allPipelineIds[0]] : getFirstLinePipelineIds(v);
  const beraterPipelineIds = department === "b2b" ? [allPipelineIds[0]] : getBeraterPipelineIds(v);
  const flPipes = new Set(firstLinePipelineIds);
  const brPipes = new Set(beraterPipelineIds);
  // Status-сеты по вертикали (одноимённые стадии бух+мед; b2g-only использование)
  const flStatus = getFirstLineStatusSets(v);
  const brStatus = getBeraterStatusSets(v);
  const qualTiers = getQualTierStatuses(v);
  const funnelMapV = getFunnelStatusMap(v);

  const base = new Date(`${dateStr}T00:00:00Z`);
  const monthPeriodDate = `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}`;
  // Off-by-one bug fix (2026-04-24): the old form
  //   `new Date(year, month+1, 0).getUTCDate()`
  // constructs a date in *local* time ("April 30 00:00 local"). On a Berlin
  // (CEST UTC+2) Dokploy host that's "April 29 22:00 UTC", so getUTCDate()
  // returned 29 instead of 30. This scaled monthly plans by 1/29 instead of
  // 1/30 → `Выручка Total план 202764 / 29 = 6992` on the daily view, when
  // the correct split is 202764 / 30 = 6759. Using Date.UTC() forces the
  // constructor into UTC so the result is timezone-independent.
  const daysInMonth = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0),
  ).getUTCDate();

  // Plans come in two tiers:
  //   • "month" records — admin enters once per month; scaled by planDivisor
  //     to day/week/year views (monthly 480 → daily 480/30 = 16).
  //   • day-granular overrides (period_type='day') — when the admin edits a
  //     specific daily cell inline, that value is stored per-day and should
  //     override the monthly cascade for THAT day only. Previously the code
  //     only loaded monthly records, so inline day edits were orphaned and
  //     the UI kept showing the monthly-scaled value instead of the user's
  //     freshly-typed number. This is what caused "Новая выручка факт
  //     откуда взялось" — users entered 1190 on Apr 2 but the UI rendered a
  //     different (computed or monthly-scaled) value because the day record
  //     never reached getPlan.
  const [allManagers, monthlyPlans, dayPlans, scheduleMap] = await Promise.all([
    // Komm: soft-deleted менеджеры не выпадают из статистики за периоды работы.
    getManagersWithKommoForPeriod(department, from, to, v),
    getPlans(department, "month", monthPeriodDate, v),
    periodType === "day" ? getPlans(department, "day", dateStr, v) : Promise.resolve([]),
    period === "day" ? getScheduleForDate(dateStr) : Promise.resolve(null),
  ]);

  let planDivisor = 1;
  if (periodType === "day") {
    planDivisor = daysInMonth;
  } else if (periodType === "week") {
    planDivisor = daysInMonth / 7;
  } else if (periodType === "year") {
    planDivisor = 1 / 12;
  }

  const plans = monthlyPlans;

  // Schedule-driven: when any schedule rows exist for the date, managers WITHOUT
  // a row are treated as off (not on shift). Only when the day is entirely
  // unscheduled (scheduleMap === null) do we fall back to counting everyone.
  // Schedule values "8" (полный) and "4" (неполный) → isOnLine = true; "-" / "о" → false.
  const isManagerOnLine = (managerId: string): boolean => {
    if (scheduleMap === null) return true;
    const entry = scheduleMap.get(managerId);
    if (entry === undefined) return false;
    return entry;
  };

  const managers = period === "day"
    ? allManagers.filter((m) => isManagerOnLine(m.id))
    : allManagers;

  const onLineManagerIds = allManagers
    .filter((m) => isManagerOnLine(m.id))
    .map((m) => m.id);

  const closedDateFilter = { field: "closed_at" as const, from, to };

  // Terms = WON leads from first line closed in THIS period (not previous day)
  const termsDateFilter = { field: "closed_at" as const, from, to };
  const createdDateFilter = { field: "created_at" as const, from, to };
  const trackError = (label: string) => (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Kommo] ${label}: ${msg}`);
    _lastKommoError = { message: `${label}: ${msg}`, at: new Date().toISOString() };
    return undefined;
  };

  // ── Historical reconstruction ──
  // For past dates without DB snapshots, we reconstruct `activeDeals`:
  //   activeDeals(D) = currentActive.filter(created <= D)
  //                  + closedAfterD.filter(created <= D)
  // i.e. leads that are still active + leads that WERE active on D but closed since.
  // Pipeline-specific status metrics (berater stages) can't be reconstructed
  // because we don't know which status a lead was in on day D.

  // For historical dates: also fetch leads closed AFTER this date (to reconstruct activeDeals)
  const todayRange = isHistorical ? businessDayToUtc(getBusinessToday()) : null;
  const closedAfterDateFilter = isHistorical
    ? { field: "closed_at" as const, from: to + 1, to: todayRange!.to }
    : null;

  const trackAnalyticsError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[Analytics] call metrics: ${msg}`);
    return new Map<string, UserCallMetrics>();
  };

  // === Data sources ===
  // All lead fetches now go through analytics.leads_cohort (local DB mirror)
  // instead of Kommo API — Daily renders in <1s instead of ~3min.
  // Tasks remain live Kommo — no analytics mirror yet.
  const [snapshotActiveLeads, tasks, wonLeads, lostLeads, analyticsCallMap, termsWonLeads, newLeadsInPeriod, termAACount, closedAfterDate] = await Promise.all([
    // Snapshot: all active leads (closed_at IS NULL). One SQL query, ~50ms.
    getAnalyticsLeads({ pipelineIds: allPipelineIds, statusIds: allActiveStatusIds, activeOnly: true }).catch(trackError("snapshot leads")),
    // Filter tasks server-side by responsible_user_id so we pull only our
    // managers' open tasks (vs the entire account). Cuts Daily's main-thread
    // wait by ~10× on busy accounts.
    isHistorical
      ? Promise.resolve([] as KommoTask[])
      : getTasks(
          false,
          allManagers.map((m) => m.kommoUserId).filter((id): id is number => id != null),
        ).catch(trackError("tasks")),
    getAnalyticsLeads({ pipelineIds: allPipelineIds, statusIds: [142], dateFilter: closedDateFilter }).catch(trackError("won leads")),
    getAnalyticsLeads({ pipelineIds: allPipelineIds, statusIds: [143], dateFilter: closedDateFilter }).catch(trackError("lost leads")),
    // Call metrics come from the analytics DB (integrator mirror). Keyed by master_managers.id.
    getAnalyticsCallMetricsByMaster(allManagers, department, from, to, v).catch(trackAnalyticsError),
    getAnalyticsLeads({ pipelineIds: firstLinePipelineIds, statusIds: [142], dateFilter: termsDateFilter }).catch(trackError("terms won")),
    getAnalyticsLeads({ pipelineIds: firstLinePipelineIds, dateFilter: createdDateFilter }).catch(trackError("new leads")),
    getAnalyticsStatusChangeCount(from, to, beraterPipelineIds, [...brStatus.consultBeforeAA, ...brStatus.consultBeforeAADone]).catch(trackError("term AA events")),
    // Historical: fetch leads closed AFTER this date (they were active on this date)
    closedAfterDateFilter
      ? getAnalyticsLeads({ pipelineIds: allPipelineIds, statusIds: [142, 143], dateFilter: closedAfterDateFilter }).catch(trackError("closed after date"))
      : Promise.resolve([] as KommoLead[]),
  ]) as [
    KommoLead[] | undefined, KommoTask[] | undefined, KommoLead[] | undefined,
    KommoLead[] | undefined, Map<string, UserCallMetrics>, KommoLead[] | undefined,
    KommoLead[] | undefined, number | undefined, KommoLead[] | undefined
  ];

  // Default to empty on API failure — but now we track it
  const safeSnapshotActiveLeads = snapshotActiveLeads ?? [];
  const safeTasks = tasks ?? [];
  const safeWonLeads = wonLeads ?? [];
  const safeLostLeads = lostLeads ?? [];
  const safeTermsWonLeads = termsWonLeads ?? [];
  const safeNewLeadsInPeriod = newLeadsInPeriod ?? [];
  const safeTermAACount = termAACount ?? 0;
  const safeClosedAfterDate = closedAfterDate ?? [];

  // Historical snapshot reconstruction — fixes the "A2/B1/Бератер воронка
  // пустые на прошлые дни" bug. For today's date the live leads_cohort
  // snapshot is correct; for past dates we reconstruct from
  // analytics.lead_status_changes (see historical-snapshot.ts).
  let historicalSnapshot: HistoricalSnapshot | null = null;
  if (isHistorical) {
    try {
      historicalSnapshot = await reconstructSnapshotAt(to, allPipelineIds);
    } catch (e) {
      console.error("[Daily] historical snapshot reconstruction failed:", e instanceof Error ? e.message : e);
    }
  }
  // Once we have a reconstructed snapshot, SNAPSHOT_ONLY_METRICS can be
  // computed for historical dates too. Without it we stay in the old
  // "return null" behaviour (no data loss, just empty cells).
  const hasSnapshotData = !isHistorical || (historicalSnapshot != null && historicalSnapshot.leads.length > 0);

  // ── Reconstruct historical activeDeals ──
  // When historicalSnapshot is available we already have the accurate count
  // from its leads array. The old closed_after fallback stays as a belt-and
  // -braces path in case lead_status_changes misses some entries.
  let reconstructedActiveDeals: number | null = null;
  let reconstructedActiveDealsPerUser: Map<number, number> | null = null;
  if (isHistorical && historicalSnapshot) {
    reconstructedActiveDeals = historicalSnapshot.leads.length;
    reconstructedActiveDealsPerUser = historicalSnapshot.perUser;
  } else if (isHistorical && safeSnapshotActiveLeads.length > 0) {
    const endOfDay = to; // end of this day in unix seconds

    // Current active leads that existed on this date
    const activeOnDate = safeSnapshotActiveLeads.filter(
      (l) => !l.is_deleted && !l.closed_at && l.created_at <= endOfDay
    );
    // Leads closed AFTER this date that existed on this date (they were active then)
    const closedButWasActive = safeClosedAfterDate.filter(
      (l) => !l.is_deleted && l.created_at <= endOfDay
    );

    reconstructedActiveDeals = activeOnDate.length + closedButWasActive.length;

    // Per-user breakdown for funnel manager data
    reconstructedActiveDealsPerUser = new Map();
    for (const lead of [...activeOnDate, ...closedButWasActive]) {
      const uid = lead.responsible_user_id;
      reconstructedActiveDealsPerUser.set(uid, (reconstructedActiveDealsPerUser.get(uid) ?? 0) + 1);
    }
  }

  const activeOnly = safeSnapshotActiveLeads.filter((l) => !l.closed_at);
  const byPipeline: Record<number, number> = {};
  for (const l of safeSnapshotActiveLeads) {
    byPipeline[l.pipeline_id] = (byPipeline[l.pipeline_id] || 0) + 1;
  }
  console.log(
    `[Daily API] ${department}/${period}/${dateStr}: allLeads=${safeSnapshotActiveLeads.length} active=${activeOnly.length} byPipeline=${JSON.stringify(byPipeline)} won=${safeWonLeads.length} lost=${safeLostLeads.length} callMetrics=${analyticsCallMap.size} terms=${safeTermsWonLeads.length} managers=${managers.length} line1=${managers.filter((m) => m.line === "1").length}`
  );

  // For historical dates with a reconstructed snapshot we swap the live
  // active-leads feed for the historical one. The snapshot-keyed funnel
  // filters (pipeline_id, status_id, non_qual_enum_id, etc.) then work
  // unchanged because each lead carries its HISTORICAL status. Won/lost
  // are appended from analytics.leads_cohort with closed_at in period —
  // same source as today's view, no reconstruction needed there.
  const effectiveActiveLeads = (isHistorical && historicalSnapshot)
    ? historicalSnapshot.leads
    : safeSnapshotActiveLeads;
  // Flow-metric filter: leads that were touched in the period. `updated_at`
  // is unavailable in the analytics mirror (falls back to created_at in
  // getAnalyticsLeads), so this effectively counts leads created in the
  // period — sufficient for termsNew/tasksNew/consultNew approximations.
  // Historical dates feed the filter from the reconstructed snapshot too
  // so the "new" flow metrics reflect the state at asOf, not live data.
  const flowActiveLeads = effectiveActiveLeads.filter(
    (lead) => lead.updated_at >= from && lead.updated_at <= to
  );
  const snapshotLeads = [...effectiveActiveLeads, ...safeWonLeads, ...safeLostLeads];
  const flowLeads = [...flowActiveLeads, ...safeWonLeads, ...safeLostLeads];

  // Analytics-backed per-master-id call map. Falls back to empty map on failure
  // (already handled upstream in trackAnalyticsError → new Map()).
  const callMetricsMap = analyticsCallMap;
  const funnelCounts = aggregateLeadFunnelMetrics(snapshotLeads, flowLeads, from, to, department, v);
  const taskMetricsMap = aggregateTaskMetrics(safeTasks);

  // Frozen-lead counts (team + per-manager in one round-trip via GROUPING SETS)
  // plus overdue tasks. Frozen = sla_status='frozen' in analytics.sla — the
  // single highest-value diagnostic for "which manager is sitting on new
  // leads without calling?" (recommended by sales-ops agent, 2026-04-24).
  const [frozenLeads, overdueTasksAnalytics] = await Promise.all([
    getFrozenLeadsCombined(allManagers, department, from, to, v).catch(() => ({ team: 0, perManager: new Map<string, number>() })),
    // Overdue tasks from analytics.tasks (authoritative mirror). Falls back
    // to the Kommo taskMetricsMap below if empty.
    getOverdueTasksByManager(allManagers, to).catch(() => new Map<string, number>()),
  ]);
  const frozenLeadsMap = frozenLeads.perManager;
  const frozenLeadsTotal = frozenLeads.team;

  // Non-cumulative planов НЕ делятся по дням: они — константы (процент,
  // среднее, время, количество-на-линии). Без этого, напр., SLA план 25 мин
  // для дня = Math.round(25/30) = 1 мин → UI показывает 1 что ошибочно.
  // Суммируемые (лиды, продажи, выручка, минуты звонков, количество звонков) —
  // делятся как раньше. (Также НЕ суммируются между вертикалями в режиме «Все».)
  const NON_CUMULATIVE_PLAN_KEYS = new Set<string>([
    // Проценты / средние — не суммируются
    "buh_avgCheck_p", "med_avgCheck_p", "total_avgCheck_p",
    "buh_ql2p_p", "med_ql2p_p", "total_ql2p_p",
    "buh_l2p_p", "med_l2p_p",
    // Звонки — константы (calls_managersOnLine_p / calls_avgWait_p /
    // calls_sla_p убраны 2026-07-22: больше не планы, а константы 30/25)
    "calls_managersOnLine_f",   // Excel вводится руками как "5" — не сумма
    "calls_avgWait_f",           // ручной ввод в минутах
    "calls_dialPercent_p",
    // ОКК — проценты
    "okk_buh1_p", "okk_buh2_p", "okk_med1_p", "okk_avg_p",
    // B2G roleplay / окк константы
    "sla_p", "okk_p", "roleplay_p", "avgWait_p", "regulationPercent",
  ]);

  // Планы → lookup по ключу line:userId:metricKey. В режиме «Все» (v='all')
  // getPlans вернул строки ОБЕИХ вертикалей: числовые значения суммируем
  // (план Бух + план Мед), несуммируемые (проценты/средние) — берёт бух
  // (строки отсортированы buh-first). Редактирование планов в «Все»
  // заблокировано на API/UI, так что коллизий записи нет.
  const buildPlanLookup = (
    rows: Array<{ vertical: string; line: string; userId: string | null; metricKey: string; planValue: string }>,
  ): Map<string, string> => {
    const sorted = v === "all"
      ? [...rows].sort((a, b) => (a.vertical === b.vertical ? 0 : a.vertical === "buh" ? -1 : 1))
      : rows;
    const map = new Map<string, string>();
    for (const p of sorted) {
      const key = `${p.line}:${p.userId || "null"}:${p.metricKey}`;
      const prev = map.get(key);
      if (prev === undefined) {
        map.set(key, p.planValue);
        continue;
      }
      // Вторая вертикаль по тому же ключу (только при v='all')
      if (NON_CUMULATIVE_PLAN_KEYS.has(p.metricKey)) continue; // бух побеждает
      const a = Number(prev);
      const b = Number(p.planValue);
      if (!Number.isNaN(a) && !Number.isNaN(b)) map.set(key, String(a + b));
    }
    return map;
  };

  const planLookup = buildPlanLookup(plans);
  // Day-granular overrides (period_type='day'). Kept in a SEPARATE map so
  // the getPlan fetcher can distinguish "admin typed a specific day value,
  // use as-is" from "admin typed a monthly value, scale by planDivisor".
  const dayPlanLookup = buildPlanLookup(dayPlans);

  const getPlan = (line: string, userId: string | null, metricKey: string): string | null => {
    // Day-level override wins for day views — admin edited THIS specific
    // cell inline, return the exact value they typed, never scale it.
    if (periodType === "day") {
      let dayVal: string | undefined;
      if (userId) dayVal = dayPlanLookup.get(`${line}:${userId}:${metricKey}`);
      if (dayVal === undefined) dayVal = dayPlanLookup.get(`${line}:null:${metricKey}`);
      if (dayVal !== undefined) return dayVal;
    }

    // Monthly-stored plan — the admin's "once per month" entry. Scaled
    // down by planDivisor for day/week views (and multiplied for year).
    let val: string | undefined;
    if (userId) {
      val = planLookup.get(`${line}:${userId}:${metricKey}`);
    }
    if (val === undefined) {
      val = planLookup.get(`${line}:null:${metricKey}`);
    }
    // Fall back to B2B fixed defaults when no admin-stored value exists.
    // Defaults are stored at MONTHLY scale (matches how admins enter plans),
    // so they flow through the same planDivisor scaling below — one code
    // path instead of duplicating the scaling in every default-aware caller.
    if (val === undefined && department === "b2b") {
      const def = B2B_FIXED_PLAN_DEFAULTS[metricKey];
      if (def != null) val = String(def);
    }
    if (val === undefined) return null;
    // Skip division for non-cumulative metrics.
    if (NON_CUMULATIVE_PLAN_KEYS.has(metricKey)) return val;
    if (planDivisor !== 1) {
      const num = Number(val);
      if (!Number.isNaN(num)) {
        return String(Math.round(num / planDivisor));
      }
    }
    return val;
  };

  // "Менеджеров на линии факт": для month/week — unique managers from schedule
  // (not just active master_managers). Для day — используется schedule filter
  // в `managers` фильтр выше; здесь fallback на managers.length.
  let managersOnLineCount: number;
  if (period === "day") {
    managersOnLineCount = managers.length;
  } else {
    const fromDayStr = new Date(from * 1000).toISOString().slice(0, 10);
    const toDayStr = new Date(to * 1000).toISOString().slice(0, 10);
    try {
      managersOnLineCount = await getUniqueOnLineManagerCount(fromDayStr, toDayStr, department);
    } catch {
      managersOnLineCount = managers.length;
    }
  }
  const line1ManagerCount = managers.filter((m) => m.line === "1").length;

  // Fetch OKK and Roleplay avg scores per line (B2G only, parallel)
  const okkScores = new Map<string, number>();
  const roleplayScores = new Map<string, number>();
  // Per-manager OKK/roleplay scores: line → Map<managerId, score>
  const okkPerManager = new Map<string, Map<string, number>>();
  const roleplayPerManager = new Map<string, Map<string, number>>();
  const slaFacts = new Map<string, SlaFacts>();
  // Per-manager SLA/TLT: line → Map<managerId, SlaFacts>
  const slaPerManager = new Map<string, Map<string, SlaFacts>>();
  // Refusal reasons: pipeline key ('firstLine' | 'berater') → sorted rows
  const refusalReasons = new Map<string, Array<{ reason: string; count: number; percent: number }>>();
  // Avg calls per lead: line → team avg + per-manager map
  const avgCallsPerLead = new Map<string, number | null>();
  const avgCallsPerLeadPerManager = new Map<string, Map<string, number>>();
  if (department === "b2g") {
    const fromDate = new Date(from * 1000);
    const toDate = new Date(to * 1000);

    // OKK: one combined team+per-manager query per line-group (prompts vary).
    // Vertical-aware: в режиме Мед — только d2_med_* промпты (решение 2026-07-06).
    const okkPromises = Object.keys(LINE_TO_ROLEPLAY_TYPES).map(async (group) => {
      const prompts = lineToOkkPrompts(group, v);
      if (prompts.length === 0) return;
      const { team, perManager } = await getOkkScores("b2g", from, to, prompts);
      if (team !== null) okkScores.set(group, team);
      okkPerManager.set(group, perManager);
    });

    // Roleplay: one combined query per line.
    const rpPromises = Object.entries(LINE_TO_ROLEPLAY_TYPES).map(async ([line, types]) => {
      const { team, perManager } = await getRoleplayScores("b2g", from, to, types);
      if (team !== null) roleplayScores.set(line, team);
      roleplayPerManager.set(line, perManager);
    });

    // SLA / TLT — одним round-trip'ом команда + per-manager через GROUPING SETS.
    // Lines 2 + 3 both live in the BERATER pipeline — Excel splits the
    // roster visually (2 = Бератер верх воронки, 3 = Доведение) but the
    // calls / SLA telemetry is one feed. Without line 2 here, the
    // per-manager secondLine section showed blank sla_f / sla_shift_f /
    // tlt_f cells on every date (audit finding 2026-04-25). The cached()
    // wrapper on getSlaFactsCombined dedups the duplicate BERATER fetch
    // so line 2 and 3 share a single DB round-trip.
    const B2G_LINE_PIPELINES: Record<string, number[]> = {
      "1": firstLinePipelineIds,
      "2": beraterPipelineIds,
      "3": beraterPipelineIds,
    };
    const slaPromises = Object.entries(B2G_LINE_PIPELINES).map(async ([line, pipelineIds]) => {
      const { team, perManager } = await getSlaFactsCombined(allManagers, pipelineIds, fromDate, toDate);
      slaFacts.set(line, team);
      slaPerManager.set(line, perManager);
    });

    // Refusal reasons per pipeline — aggregated, two cards in UI
    // (первая линия = квалификатор, бератер = бератер+доведение); в режиме
    // Мед/Все — соответствующие мед-воронки включены.
    const refusalPromises = [
      ["firstLine", firstLinePipelineIds] as const,
      ["berater", beraterPipelineIds] as const,
    ].map(async ([key, pipelineIds]) => {
      const rows = await getRefusalReasons(pipelineIds, fromDate, toDate);
      refusalReasons.set(key, rows);
    });

    // Avg calls per lead per line. Line 2 and 3 share the BERATER pipeline(s),
    // so the SQL is fired once per unique pipeline set and reused across lines.
    const acplByPipeline = new Map<string, Promise<{ team: number | null; perManager: Map<string, number> }>>();
    const acplPromises = Object.entries(B2G_LINE_PIPELINES).map(async ([line, pipelineIds]) => {
      const pipeKey = pipelineIds.join("+");
      let promise = acplByPipeline.get(pipeKey);
      if (!promise) {
        promise = getAvgCallsPerLeadCombined(allManagers, pipelineIds, fromDate, toDate);
        acplByPipeline.set(pipeKey, promise);
      }
      const { team, perManager } = await promise;
      avgCallsPerLead.set(line, team);
      avgCallsPerLeadPerManager.set(line, perManager);
    });

    await Promise.all([...okkPromises, ...rpPromises, ...slaPromises, ...refusalPromises, ...acplPromises]);
  }

  const activeSections = getDailySections(department);

  // =========================================================================
  // B2B-specific data assembly
  // =========================================================================
  // Pipeline stats are driven by Kommo custom fields per ТЗ:
  //   - revenue  = sum(Сумма 1-го платежа where Факт. Дата 1-го платежа ∈ period)
  //              + sum(Сумма предоплаты where Дата предоплаты ∈ period)
  //   - salesCount        = leads where Факт. Дата 1-го платежа ∈ period
  //   - prepaymentCount   = leads where Дата предоплаты ∈ period
  //   - totalLeads        = leads created in period (not deleted)
  //   - qualLeads         = totalLeads  minus (Incoming for Бух)  minus (lost w/
  //                         loss_reason Неквал/Спам)
  // OKK/SLA/avgWait are pulled from the R2 OKK DB + analytics DB similarly to
  // how the B2G branch handles its per-line аналоги.
  const buhPipelineId = B2B_PIPELINES.COMMERCIAL;
  const medPipelineId = B2B_PIPELINES.MEDICAL_COMM;

  // B2B stats are now computed in a single SQL round-trip to analytics.leads_cohort
  // (see src/lib/daily/analytics-b2b.ts). No Kommo API calls on the rendering path.
  let buhStats: B2BStatsSQL = { revenue: 0, salesCount: 0, prepaymentCount: 0, totalLeads: 0, qualLeads: 0 };
  let medStats: B2BStatsSQL = { revenue: 0, salesCount: 0, prepaymentCount: 0, totalLeads: 0, qualLeads: 0 };
  // Per-manager stats: responsible_user_id → stats
  let buhPerManager = new Map<number, B2BStatsSQL>();
  let medPerManager = new Map<number, B2BStatsSQL>();

  // B2B-specific async metrics (OKK, SLA, avgWait). Fetched in parallel.
  let okkBuh1: number | null = null;
  let okkBuh2: number | null = null;
  let okkMed: number | null = null;
  let slaShiftSecondsB2B: number | null = null;
  let avgWaitSecondsB2B: number | null = null;
  // Team-level call metrics for B2B — counts ALL managers in analytics.communications
  // (including ex-managers no longer in master_managers), so totals match Looker/Excel.
  let teamCallMetricsB2B: UserCallMetrics | null = null;
  // Per-manager OKK scores for B2B: managerId → score (combined across prompts)
  const okkPerManagerB2B = new Map<string, number>();

  if (department === "b2b") {
    const fromDate = new Date(from * 1000);
    const toDate = new Date(to * 1000);

    // All pipeline stats via SQL — one round-trip per pipeline+granularity.
    [buhStats, medStats, buhPerManager, medPerManager] = await Promise.all([
      getB2BPipelineStatsSQL(buhPipelineId, fromDate, toDate),
      getB2BPipelineStatsSQL(medPipelineId, fromDate, toDate),
      getB2BPerManagerStatsSQL(buhPipelineId, fromDate, toDate),
      getB2BPerManagerStatsSQL(medPipelineId, fromDate, toDate),
    ]);

    // OKK for B2B: prompt types are defined in src/lib/config/tenant.ts (LINES.b2b).
    // Each line has its own prompt_type in `okk_evaluations.prompt_type`:
    //   buh1 → r2_commercial, buh2 → r2_decisions, med1 → r2_med_commercial
    // Per-line team averages come from 3 separate queries (different prompt sets
    // → different WHERE clauses, can't collapse into one query); per-manager map
    // is the combined of all three, pulled once alongside the "all prompts" team
    // aggregate for efficiency.
    const [buh1Res, buh2Res, medRes, allPromptsRes] = await Promise.all([
      getOkkScores("b2b", from, to, ["r2_commercial"]),
      getOkkScores("b2b", from, to, ["r2_decisions"]),
      getOkkScores("b2b", from, to, ["r2_med_commercial"]),
      getOkkScores("b2b", from, to, ["r2_commercial", "r2_decisions", "r2_med_commercial"]),
    ]);
    okkBuh1 = buh1Res.team;
    okkBuh2 = buh2Res.team;
    okkMed = medRes.team;
    for (const [mgrId, v] of allPromptsRes.perManager) okkPerManagerB2B.set(mgrId, v);

    // SLA & avg wait — одна воронка в телефонии, используем Бух Комм.
    // Team-level call metrics across ALL managers (fix for undercount where
    // ex-managers get excluded when keyed by master_managers).
    teamCallMetricsB2B = await getAnalyticsTeamCallMetrics("b2b", from, to).catch(() => null);

    const slaFactsB2B = (await getSlaFactsCombined(allManagers, buhPipelineId, fromDate, toDate)).team;
    // Use business-hours SLA (from-shift) per Excel comparison: Excel R76 shows
    // 52.59 мин which matches sla_first_call_from_shift_seconds, not raw
    // sla_first_call_seconds (which includes evenings/nights, gives ~600 min).
    // Emitted as SECONDS — the UI renders HH:MM:SS via DURATION_SEC_KEYS.
    slaShiftSecondsB2B = slaFactsB2B.slaShiftSeconds ?? slaFactsB2B.slaSeconds;
    // avgWait факт (Excel R72 "Ср. время ожидания ответа (сек)" = ring-to-answer
    // из Callgear/Cloudtalk). У нас только sla_first_call_from_shift_seconds
    // (часы до первого звонка на лиде) — это совсем другой SLA. Пока source не
    // подключён, оставляем null → UI показывает "—", пользователь видит что
    // метрика не реализована, вместо того чтобы рисовать нерелевантные часы.
    avgWaitSecondsB2B = null;
  }

  const sections = activeSections.map((section) => {
    const sectionManagers = department === "b2b"
      ? managers // B2B: all managers participate in all sections
      : managers.filter((m) => section.key === "funnel" || m.line === section.dbLine);

    // Calls: keyed by master_managers.id (from analytics DB).
    const sectionCallMetrics = sectionManagers
      .map((m) => callMetricsMap.get(m.id))
      .filter((m): m is UserCallMetrics => m !== undefined);

    // For B2B team-level rollup use direct analytics sum (includes ex-managers);
    // for B2G and per-manager views keep the master_managers-keyed aggregation.
    const summaryCallMetrics = department === "b2b" && teamCallMetricsB2B
      ? teamCallMetricsB2B
      : sumCallMetrics(sectionCallMetrics);

    // Overdue tasks: prefer analytics.tasks (continuously-refreshed mirror)
    // over Kommo API. The analytics map is keyed by master_managers.id; the
    // taskMetricsMap fallback is keyed by kommoUserId.
    let totalOverdue = 0;
    for (const mgr of sectionManagers) {
      const fromAnalytics = overdueTasksAnalytics.get(mgr.id);
      if (fromAnalytics != null && fromAnalytics > 0) {
        totalOverdue += fromAnalytics;
      } else if (mgr.kommoUserId != null) {
        totalOverdue += taskMetricsMap.get(mgr.kommoUserId)?.overdueTasks ?? 0;
      }
    }

    const summaryMetrics = section.metrics.map((metric) => {
      if (metric.isGroupHeader) {
        return { key: metric.key, label: metric.label, plan: null, fact: null, percent: null, isGroupHeader: true };
      }

      let plan = getPlan(section.dbLine, null, metric.key);
      let fact: string | null = null;

      if (metric.key === "qualLeadsPercent") {
        const planTotal = getPlan(section.dbLine, null, "totalLeads");
        const planQual = getPlan(section.dbLine, null, "qualLeads");
        if (planTotal && planQual && Number(planTotal) > 0) {
          plan = String(Math.round((Number(planQual) / Number(planTotal)) * 100));
        }
      }

      // Plan-row metrics: user override > stored default > computed fallback.
      // Для B2B plan-rows с пустым daily_plans:
      //   1) подставляем ТЗ-дефолт (SLA 25, ОКК 85, avgWait 35, ...);
      //   2) если и дефолта нет — вычисляем через getB2BFact (для derived _p
      //      типа buh_newRevenue_p = sales × avgCheck).
      // Overridable facts (hasPlan && hasFact — выручка): если есть запись в
      // daily_plans, она побеждает SQL-computed значение.
      if (metric.hasPlan && !metric.hasFact) {
        // `plan` already contains the fixed-default fallback (getPlan handles
        // B2B_FIXED_PLAN_DEFAULTS with the same scaling as stored plans).
        if (!plan && department === "b2b") {
          // Derived plan (e.g., buh_newRevenue_p = sales × avgCheck) — compute.
          fact = getB2BFact(metric.key, section.key, {
            summaryCallMetrics,
            managersOnLineCount,
            sectionManagers,
            buh: buhStats,
            med: medStats,
            getPlan,
            sectionDbLine: section.dbLine,
            okkBuh1, okkBuh2, okkMed,
            slaShiftSeconds: slaShiftSecondsB2B,
            avgWaitSeconds: avgWaitSecondsB2B,
          });
        } else {
          fact = plan;
        }
      } else if (department === "b2b" && metric.hasPlan && metric.hasFact && plan != null && plan !== "") {
        // Editable fact (revenue _f paired with _p): manual entry always wins.
        fact = plan;
      } else if (department === "b2b") {
        // Pure-fact metrics (komLeads_f, sales_f, calls_*, SLA, ...) always
        // come from analytics.* — analytics.leads_cohort / .communications /
        // .sla have full Jan 2026 → today coverage.
        fact = getB2BFact(metric.key, section.key, {
          summaryCallMetrics,
          managersOnLineCount,
          sectionManagers,
          buh: buhStats,
          med: medStats,
          getPlan,
          sectionDbLine: section.dbLine,
          okkBuh1,
          okkBuh2,
          okkMed,
          slaShiftSeconds: slaShiftSecondsB2B,
          avgWaitSeconds: avgWaitSecondsB2B,
        });
      } else if (section.key === "funnel") {
        fact = getFunnelFact(metric.key, funnelCounts, managersOnLineCount, snapshotLeads, line1ManagerCount, safeTermsWonLeads, from, to, safeNewLeadsInPeriod, safeTermAACount, hasSnapshotData, reconstructedActiveDeals, flPipes, brPipes, dateStr, flStatus, brStatus);
      } else {
        // For per-manager sections: overdueTasks is snapshot-only (no date filter)
        if (metric.key === "overdueTasks" && !hasSnapshotData) {
          fact = null;
        } else {
          const facts = buildUserFacts(summaryCallMetrics, totalOverdue);
          fact = facts[metric.key] ?? null;
        }
        if (metric.key === "staffCount") {
          fact = String(sectionManagers.length);
        }
        // Computed plans: staffCount × per-manager coefficient (Excel reference:
        // 160 calls/day, 240 min/day per employee, same per-manager block below).
        if (metric.key === "callsTotal_p") {
          fact = String(sectionManagers.length * 160);
        }
        if (metric.key === "totalMinutes_p") {
          fact = String(sectionManagers.length * 240);
        }
        // Fixed constants from Excel
        if (metric.key === "sla_p") {
          // SLA: квалификатор=25, доведение=10, бератер=нет данных
          const slaByLine: Record<string, number> = { "1": 25, "3": 10 };
          const slaVal = slaByLine[section.dbLine];
          fact = slaVal ? String(slaVal) : null;
        }
        if (metric.key === "okk_p") fact = "85";
        if (metric.key === "okk_f") {
          const v = okkScores.get(section.dbLine);
          // OKK DB started 2026-03-04 — для ранних дат fallback на Excel.
          fact = v !== undefined ? String(v) : (plan != null && plan !== "" ? plan : null);
        }
        if (metric.key === "roleplay_p") fact = "85";
        if (metric.key === "roleplay_f") {
          const v = roleplayScores.get(section.dbLine);
          // Аналогично: ролевка недавняя, для ранних дат fallback на Excel.
          fact = v !== undefined ? String(v) : (plan != null && plan !== "" ? plan : null);
        }
        if (metric.key === "avgWait_p") fact = "30";
        // SLA/TLT facts are emitted in SECONDS so the UI can render
        // HH:MM:SS with true precision — if we emit rounded minutes here the
        // 30-секундный SLA превращается в "01:00" after *60. See DailyTab's
        // DURATION_SEC_KEYS (sla_f/sla_shift_f/tlt_f/calls_sla_f live there).
        if (metric.key === "sla_f") {
          const sf = slaFacts.get(section.dbLine);
          fact = sf?.slaSeconds != null ? String(sf.slaSeconds) : null;
        }
        if (metric.key === "sla_shift_f") {
          const sf = slaFacts.get(section.dbLine);
          fact = sf?.slaShiftSeconds != null ? String(sf.slaShiftSeconds) : null;
        }
        if (metric.key === "tlt_f") {
          const sf = slaFacts.get(section.dbLine);
          fact = sf?.tltSeconds != null ? String(sf.tltSeconds) : null;
        }
        if (metric.key === "frozenLeads") {
          fact = String(frozenLeadsTotal);
        }
        if (metric.key === "avgDialogPerEmployee" && sectionManagers.length > 0) {
          fact = String(Math.round(summaryCallMetrics.totalMinutes / sectionManagers.length));
        }
        if (metric.key === "avgCallsPerLead") {
          const v = avgCallsPerLead.get(section.dbLine);
          fact = v != null ? String(v) : null;
        }
      }

      const percent = computePercent(metric.key, metric.unit, fact, plan);

      // Computed metrics that need access to other metrics in the same section
      if (metric.key === "gutscheinPlanDone") {
        const gutPlan = getPlan(section.dbLine, null, "gutscheinsApproved_p");
        const gutFactStr = getFunnelFact("gutscheinsApproved", funnelCounts, managersOnLineCount, snapshotLeads, line1ManagerCount, safeTermsWonLeads, from, to, safeNewLeadsInPeriod, safeTermAACount, hasSnapshotData, reconstructedActiveDeals, flPipes, brPipes, dateStr, flStatus, brStatus);
        const gutFact = Number(gutFactStr ?? 0);
        fact = gutPlan && Number(gutPlan) > 0 ? String(Math.round((gutFact / Number(gutPlan)) * 100)) : "0";
      }

      // Hide plan column for pure-fact metrics so percent doesn't render as 100%
      // when the stored daily_plans value is used only as fact backfill.
      const planOut = metric.hasPlan ? plan : null;
      const percentOut = metric.hasPlan ? percent : null;
      return {
        key: metric.key,
        label: metric.label,
        plan: planOut,
        fact,
        percent: percentOut,
        isGroupHeader: false,
        // Pure plan rows (hasPlan && !hasFact) render as blue-styled "plan"
        // cells — this flag controls that visual treatment.
        isPlanRow: metric.hasPlan && !metric.hasFact,
        // isEditable is broader than isPlanRow: any row with hasPlan is
        // admin-overridable, including revenue _f cells (hasPlan && hasFact)
        // where typing a value overrides the SQL-computed fact. Used by the
        // UI to gate the pencil icon + inline-edit click.
        isEditable: metric.hasPlan,
      };
    });

    let managerData: Array<{
      id: string;
      name: string;
      line: string | null;
      kommoUserId: number | null;
      metrics: Array<{ key: string; plan: string | null; fact: string | null; percent: number | null }>;
    }> = [];

    if (department === "b2b" && section.perManager) {
      // B2B per-manager: sales (Бух / Мед) + calls.
      // salesBuh/salesMed реализованы через те же commercial-facts formulas,
      // что и team-level расчёт, — чтобы строки "Кол-во продаж Бух факт" и
      // "Выручка Бух факт" рассчитывались по custom-полям, а не по lead.price.
      const pipeId = section.key === "salesBuh"
        ? buhPipelineId
        : section.key === "salesMed"
          ? medPipelineId
          : null;
      const prefix = section.key === "salesBuh" ? "buh" : section.key === "salesMed" ? "med" : null;

      managerData = sectionManagers.map((mgr) => {
        const uid = mgr.kommoUserId;
        const mgrCallMetrics = callMetricsMap.get(mgr.id);

        const mgrMetrics = section.metrics
          .filter((m) => !m.isGroupHeader)
          .map((metric) => {
            const plan = getPlan(section.dbLine, mgr.id, metric.key);
            let fact: string | null = null;

            if (metric.hasPlan && !metric.hasFact) {
              fact = plan;
            } else if (metric.hasPlan && metric.hasFact && plan != null && plan !== "") {
              // Editable revenue per-manager — manual override always wins.
              fact = plan;
            } else if (section.key === "calls") {
              if (metric.key === "calls_managersOnLine_f") fact = "1";
              else if (metric.key === "calls_total_p") fact = "80";
              else if (metric.key === "calls_total_f") fact = String(mgrCallMetrics?.callsTotal ?? 0);
              else if (metric.key === "calls_totalMinutes_p") fact = "160";
              else if (metric.key === "calls_totalMinutes_f") fact = String(mgrCallMetrics?.totalMinutes ?? 0);
              else if (metric.key === "calls_dialPercent_p") fact = "65";
              else if (metric.key === "calls_dialPercent_f") fact = String(mgrCallMetrics?.dialPercent ?? 0);
              else if (metric.key === "calls_avgWait_p") fact = "30";
              // Ожидание/SLA — в МИНУТАХ (ТЗ 2026-07-22); источники держат секунды.
              else if (metric.key === "calls_avgWait_f") fact = avgWaitSecondsB2B != null ? String(Math.round(avgWaitSecondsB2B / 60 * 10) / 10) : null;
              else if (metric.key === "calls_sla_p") fact = "25";
              else if (metric.key === "calls_sla_f") fact = slaShiftSecondsB2B != null ? String(Math.round(slaShiftSecondsB2B / 60 * 10) / 10) : null;
              // ОКК per-manager — берём из общей окк-выборки (ETL пишет manager_id)
              else if (metric.key === "okk_avg_f") {
                const v = okkPerManagerB2B.get(mgr.id);
                fact = v != null ? String(v) : null;
              }
            } else if (pipeId !== null && prefix !== null) {
              // Per-manager stats from SQL pre-aggregation (analytics.leads_cohort).
              const perMgrMap = section.key === "salesBuh" ? buhPerManager : medPerManager;
              const stats: B2BStatsSQL = (uid ? perMgrMap.get(uid) : undefined)
                ?? { revenue: 0, salesCount: 0, prepaymentCount: 0, totalLeads: 0, qualLeads: 0 };
              const mgrAvgCheckPlan = Number(getPlan(section.dbLine, mgr.id, `${prefix}_avgCheck_p`) ?? 0);
              const mgrKomLeadsPlan = Number(getPlan(section.dbLine, mgr.id, `${prefix}_komLeads_p`) ?? 0);
              const mgrQl2pPlan = prefix === "buh"
                ? 8
                : Number(getPlan(section.dbLine, mgr.id, `${prefix}_ql2p_p`) ?? 0);
              const mgrSalesPlan = Math.round(mgrKomLeadsPlan * mgrQl2pPlan / 100);
              const mgrRevenuePlan = mgrSalesPlan * mgrAvgCheckPlan;

              switch (metric.key) {
                case `${prefix}_salesPlusRenewals_p`: fact = String(mgrRevenuePlan); break;
                case `${prefix}_salesPlusRenewals_f`: fact = String(stats.revenue); break;
                case `${prefix}_newRevenue_p`: fact = String(mgrRevenuePlan); break;
                case `${prefix}_newRevenue_f`: fact = String(stats.revenue); break;
                case `${prefix}_komLeads_f`: fact = String(stats.qualLeads); break;
                case `${prefix}_sales_p`: fact = String(mgrSalesPlan); break;
                case `${prefix}_sales_f`: fact = String(stats.salesCount); break;
                case `${prefix}_prepayments`: fact = String(stats.prepaymentCount); break;
                case `${prefix}_ql2p_p`: if (prefix === "buh") fact = "8"; break;
                case `${prefix}_ql2p_f`: fact = String(pct(stats.salesCount, stats.qualLeads)); break;
                case `${prefix}_avgCheck_f`: fact = String(avgCheck(stats.revenue, stats.salesCount)); break;
                case `${prefix}_planDoneTotal`: fact = planDone(stats.revenue, String(mgrRevenuePlan)); break;
                case `${prefix}_planDoneNew`: fact = planDone(stats.revenue, String(mgrRevenuePlan)); break;
              }
            }

            const percent = computePercent(metric.key, metric.unit, fact, plan);
            const planOut = metric.hasPlan ? plan : null;
            const percentOut = metric.hasPlan ? percent : null;
            return { key: metric.key, plan: planOut, fact, percent: percentOut };
          });

        return { id: mgr.id, name: mgr.name, line: mgr.line, kommoUserId: mgr.kommoUserId, metrics: mgrMetrics };
      });
    } else if (section.key === "funnel") {
      const funnelManagers = managers.filter((m) => m.line === "1" || m.line === "2" || m.line === "3");
      if (funnelManagers.length > 0) {
        // Portfolio excludes won/lost + База + Отложенный старт — leads in
        // these statuses shouldn't weight a manager's active portfolio.
        // (142/143 общие для всех воронок; База/Отложенный — vertical-aware.)
        const excludePortfolio = new Set<number>([
          142,
          143,
          ...flStatus.base,
          ...flStatus.delayedStart,
        ]);
        // Berater statuses where the lead is awaiting a term appointment.
        const awaitStatuses = new Set<number>([
          ...brStatus.receivedFromFirst,
          ...brStatus.dovedenie,
          ...brStatus.consultBeforeDC,
          ...brStatus.consultBeforeDCDone,
        ]);
        // «Термин АА на этапе» = кластер Консультация перед АА (+проведена):
        // отдельной стадии «Термин АА» в воронке больше нет (убрана ~2026-03),
        // per-manager зеркалит team-логику getFunnelFact.termAACount.
        const aaOnStage = new Set<number>([
          ...brStatus.consultBeforeAA,
          ...brStatus.consultBeforeAADone,
        ]);

        managerData = funnelManagers.map((mgr) => {
          const uid = mgr.kommoUserId;
          const mgrLeads = uid ? snapshotLeads.filter((l) => l.responsible_user_id === uid) : [];
          const mgrActiveLeads = mgrLeads.filter((l) => !l.is_deleted && !l.closed_at);
          const mgrTermsWon = uid ? safeTermsWonLeads.filter((l) => l.responsible_user_id === uid) : [];
          const mgrNewLeads = uid ? safeNewLeadsInPeriod.filter((l) => l.responsible_user_id === uid && !l.is_deleted) : [];

          const mgrMetrics = section.metrics
            .filter((m) => !m.isGroupHeader)
            .map((metric) => {
              // Skip snapshot-only metrics for historical dates without stored snapshots
              if (!hasSnapshotData && SNAPSHOT_ONLY_METRICS.has(metric.key)) {
                return { key: metric.key, plan: null as string | null, fact: null as string | null, percent: null as number | null };
              }
              let fact: string | null = null;
              switch (metric.key) {
                case "activeDeals":
                  // Use reconstructed per-user count for historical dates
                  if (!hasSnapshotData && reconstructedActiveDealsPerUser && uid) {
                    fact = String(reconstructedActiveDealsPerUser.get(uid) ?? 0);
                  } else {
                    fact = String(mgrActiveLeads.length);
                  }
                  break;
                case "managersOnLine":
                  fact = "1";
                  break;
                case "totalLeads": {
                  // Exclude Неразобранное and База (бух+мед по вертикали)
                  fact = String(mgrNewLeads.filter((l) => !flStatus.unsorted.has(l.status_id) && !flStatus.base.has(l.status_id)).length);
                  break;
                }
                case "qualLeads": {
                  // Квал = есть буква в Category (CFV 866934). Per user spec 2026-04-24.
                  fact = String(mgrNewLeads.filter((l) => {
                    if (flStatus.unsorted.has(l.status_id) || flStatus.base.has(l.status_id)) return false;
                    return hasCategoryLetter(l);
                  }).length);
                  break;
                }
                case "qualLeadsPercent": {
                  const mgrFiltered = mgrNewLeads.filter((l) => !flStatus.unsorted.has(l.status_id) && !flStatus.base.has(l.status_id));
                  const mgrQual = mgrFiltered.filter(hasCategoryLetter).length;
                  fact = mgrFiltered.length > 0 ? String(Math.round((mgrQual / mgrFiltered.length) * 100)) : "0";
                  break;
                }
                case "avgPortfolio":
                  fact = String(mgrActiveLeads.filter((l) => flPipes.has(l.pipeline_id) && !excludePortfolio.has(l.status_id)).length);
                  break;
                case "termsTotal":
                  fact = String(mgrTermsWon.length);
                  break;
                case "termsNew": {
                  // "New" = created in current month, APP_TZ-aware bounds.
                  const { start: mStart, end: mEnd } = monthBoundsSec(dateStr);
                  fact = String(mgrTermsWon.filter((l) => l.created_at >= mStart && l.created_at <= mEnd).length);
                  break;
                }
                case "awaitTermTotal":
                  fact = String(mgrActiveLeads.filter((l) => brPipes.has(l.pipeline_id) && awaitStatuses.has(l.status_id)).length);
                  break;
                case "awaitTermNew": {
                  const { start: ms, end: me } = monthBoundsSec(dateStr);
                  fact = String(mgrActiveLeads.filter((l) => brPipes.has(l.pipeline_id) && awaitStatuses.has(l.status_id) && l.created_at >= ms && l.created_at <= me).length);
                  break;
                }
                case "gutscheinsApproved": {
                  const mgrGut = uid ? safeWonLeads.filter((l) => l.responsible_user_id === uid && brPipes.has(l.pipeline_id)).length : 0;
                  fact = String(mgrGut);
                  break;
                }
                case "a2": {
                  fact = String(mgrActiveLeads.filter((l) => flPipes.has(l.pipeline_id) && qualTiers.a2.has(l.status_id)).length);
                  break;
                }
                case "b1": {
                  fact = String(mgrActiveLeads.filter((l) => flPipes.has(l.pipeline_id) && qualTiers.b1.has(l.status_id)).length);
                  break;
                }
                case "b2plus": {
                  fact = String(mgrActiveLeads.filter((l) => flPipes.has(l.pipeline_id) && qualTiers.b2plus.has(l.status_id)).length);
                  break;
                }
                case "tasksTotal": {
                  const map = funnelMapV.tasksTotal;
                  fact = String(mgrActiveLeads.filter((l) => map && (map.pipelineIds?.includes(l.pipeline_id) ?? flPipes.has(l.pipeline_id)) && map.statusIds.has(l.status_id)).length);
                  break;
                }
                case "tasksNew": {
                  const map = funnelMapV.tasksTotal;
                  const { start: ms, end: me } = monthBoundsSec(dateStr);
                  fact = String(mgrActiveLeads.filter((l) =>
                    map && (map.pipelineIds?.includes(l.pipeline_id) ?? flPipes.has(l.pipeline_id)) && map.statusIds.has(l.status_id)
                      && l.created_at >= ms && l.created_at <= me,
                  ).length);
                  break;
                }
                case "consultTotal": {
                  const map = funnelMapV.consultTotal;
                  fact = String(mgrActiveLeads.filter((l) => map && (map.pipelineIds?.includes(l.pipeline_id) ?? flPipes.has(l.pipeline_id)) && map.statusIds.has(l.status_id)).length);
                  break;
                }
                case "consultNew": {
                  const map = funnelMapV.consultTotal;
                  const { start: ms, end: me } = monthBoundsSec(dateStr);
                  fact = String(mgrActiveLeads.filter((l) =>
                    map && (map.pipelineIds?.includes(l.pipeline_id) ?? flPipes.has(l.pipeline_id)) && map.statusIds.has(l.status_id)
                      && l.created_at >= ms && l.created_at <= me,
                  ).length);
                  break;
                }
                case "convQualTask": {
                  // tasksTotal / qualLeads × 100. Qual = has category letter.
                  const mgrQual = mgrNewLeads.filter((l) => {
                    if (flStatus.unsorted.has(l.status_id) || flStatus.base.has(l.status_id)) return false;
                    return hasCategoryLetter(l);
                  }).length;
                  const mgrTasks = mgrActiveLeads.filter((l) => flPipes.has(l.pipeline_id) && funnelMapV.tasksTotal?.statusIds.has(l.status_id)).length;
                  fact = mgrQual > 0 ? String(Math.round((mgrTasks / mgrQual) * 100)) : "0";
                  break;
                }
                case "convTaskConsult": {
                  const mgrTasks = mgrActiveLeads.filter((l) => flPipes.has(l.pipeline_id) && funnelMapV.tasksTotal?.statusIds.has(l.status_id)).length;
                  const mgrConsult = mgrActiveLeads.filter((l) => flPipes.has(l.pipeline_id) && funnelMapV.consultTotal?.statusIds.has(l.status_id)).length;
                  fact = mgrTasks > 0 ? String(Math.round((mgrConsult / mgrTasks) * 100)) : "0";
                  break;
                }
                case "convConsultTerm": {
                  const mgrConsult = mgrActiveLeads.filter((l) => flPipes.has(l.pipeline_id) && funnelMapV.consultTotal?.statusIds.has(l.status_id)).length;
                  fact = mgrConsult > 0 ? String(Math.round((mgrTermsWon.length / mgrConsult) * 100)) : "0";
                  break;
                }
                case "beraterReject": {
                  const mgrRej = uid ? safeLostLeads.filter((l) => l.responsible_user_id === uid && brPipes.has(l.pipeline_id)).length : 0;
                  fact = String(mgrRej);
                  break;
                }
                case "appealsSubmitted": {
                  fact = String(mgrActiveLeads.filter((l) => brPipes.has(l.pipeline_id) && brStatus.appeal.has(l.status_id)).length);
                  break;
                }
                case "revenue": {
                  const mgrRev = mgrTermsWon.reduce((s, l) => s + (l.price || 0), 0);
                  fact = String(mgrRev);
                  break;
                }
                case "termDCCancelled": {
                  fact = String(mgrActiveLeads.filter((l) => brPipes.has(l.pipeline_id) && brStatus.termDCCancelled.has(l.status_id)).length);
                  break;
                }
                case "termDCDone": {
                  fact = String(mgrActiveLeads.filter((l) => brPipes.has(l.pipeline_id) && brStatus.termDCDone.has(l.status_id)).length);
                  break;
                }
                case "termAATransferred": {
                  // Team-level uses getStatusChangeCount (events API, period-
                  // bound). There's no per-manager variant of that call yet,
                  // and counting current snapshot status would report a
                  // different number with the same label. Return null rather
                  // than mislead; team total still shows in the summary row.
                  fact = null;
                  break;
                }
                case "termAACancelled": {
                  fact = String(mgrActiveLeads.filter((l) => brPipes.has(l.pipeline_id) && brStatus.termAACancelled.has(l.status_id)).length);
                  break;
                }
                case "termAACount": {
                  // Кластер «Консультация перед АА (+проведена)» — стадии
                  // «Термин АА» в воронке больше нет (убрана ~2026-03).
                  fact = String(mgrActiveLeads.filter((l) => brPipes.has(l.pipeline_id) && aaOnStage.has(l.status_id)).length);
                  break;
                }
                case "beraterReview": {
                  fact = String(mgrActiveLeads.filter((l) => brPipes.has(l.pipeline_id) && brStatus.beraterReview.has(l.status_id)).length);
                  break;
                }
                case "delayedStart": {
                  // Matches team-level funnel map delayedStart which covers
                  // BOTH pipelines' "Отложенный старт" statuses.
                  fact = String(mgrActiveLeads.filter((l) =>
                    (brPipes.has(l.pipeline_id) && brStatus.delayedStart.has(l.status_id))
                    || (flPipes.has(l.pipeline_id) && flStatus.delayedStart.has(l.status_id)),
                  ).length);
                  break;
                }
                case "appeal": {
                  fact = String(mgrActiveLeads.filter((l) => brPipes.has(l.pipeline_id) && brStatus.appeal.has(l.status_id)).length);
                  break;
                }
              }
              return { key: metric.key, plan: null as string | null, fact, percent: null as number | null };
            });

          return { id: mgr.id, name: mgr.name, line: mgr.line, kommoUserId: mgr.kommoUserId, metrics: mgrMetrics };
        });
      }
    }

    if (section.perManager && department !== "b2b") {
      managerData = sectionManagers.map((mgr) => {
        const kommoId = mgr.kommoUserId;
        const mgrCallMetrics = callMetricsMap.get(mgr.id);
        // Prefer analytics.tasks; fall back to Kommo taskMetricsMap if empty.
        const mgrOverdueAnalytics = overdueTasksAnalytics.get(mgr.id) ?? 0;
        const mgrOverdue = mgrOverdueAnalytics > 0
          ? mgrOverdueAnalytics
          : (kommoId ? (taskMetricsMap.get(kommoId)?.overdueTasks ?? 0) : 0);
        const mgrFacts = buildUserFacts(mgrCallMetrics, mgrOverdue);

        const mgrMetrics = section.metrics
          .filter((m) => !m.isGroupHeader)
          .map((metric) => {
            const plan = getPlan(section.dbLine, mgr.id, metric.key);
            let fact: string | null = null;
            // overdueTasks is not date-filtered — skip for historical
            if (metric.key === "overdueTasks" && !hasSnapshotData) {
              fact = null;
            } else {
              fact = mgrFacts[metric.key] ?? null;
            }
            if (metric.key === "staffCount") fact = "1";
            if (metric.key === "avgDialogPerEmployee" && mgrCallMetrics) {
              fact = String(mgrCallMetrics.totalMinutes);
            }
            // Per-manager OKK and roleplay scores
            if (metric.key === "okk_f") {
              // OKK managers use different IDs — match by master_managers kommoUserId
              // For now, per-manager OKK uses the OKK managerId which maps to d1_users.id
              const okkMgrScores = okkPerManager.get(section.dbLine);
              const v = okkMgrScores?.get(mgr.id);
              fact = v !== undefined ? String(v) : null;
            }
            if (metric.key === "okk_p") fact = "85";
            if (metric.key === "roleplay_f") {
              const rpMgrScores = roleplayPerManager.get(section.dbLine);
              const v = rpMgrScores?.get(mgr.id);
              fact = v !== undefined ? String(v) : null;
            }
            if (metric.key === "roleplay_p") fact = "85";
            if (metric.key === "sla_p") {
              const slaByLine: Record<string, number> = { "1": 25, "3": 10 };
              const slaVal = slaByLine[section.dbLine];
              fact = slaVal ? String(slaVal) : null;
            }
            if (metric.key === "avgWait_p") fact = "30";
            // Per-manager plan overrides — match Excel reference values
            // (Госники Daily Weekly Monthly): qualifier/Доведение/2я линия
            // expect 160 calls and 240 min per-manager per day.
            if (metric.key === "callsTotal_p") fact = "160";
            if (metric.key === "totalMinutes_p") fact = "240";
            // Per-manager SLA / SLA-from-shift / TLT from analytics.sla
            if (metric.key === "sla_f" || metric.key === "sla_shift_f" || metric.key === "tlt_f") {
              const perMgr = slaPerManager.get(section.dbLine)?.get(mgr.id);
              if (perMgr) {
                // SECONDS, not minutes — see note at the team-level sla_f branch.
                if (metric.key === "sla_f") fact = perMgr.slaSeconds != null ? String(perMgr.slaSeconds) : null;
                else if (metric.key === "sla_shift_f") fact = perMgr.slaShiftSeconds != null ? String(perMgr.slaShiftSeconds) : null;
                else if (metric.key === "tlt_f") fact = perMgr.tltSeconds != null ? String(perMgr.tltSeconds) : null;
              }
            }
            // Per-manager avg calls per lead
            if (metric.key === "avgCallsPerLead") {
              const v = avgCallsPerLeadPerManager.get(section.dbLine)?.get(mgr.id);
              fact = v != null ? String(v) : null;
            }
            // Per-manager frozen leads count (SLA status 'frozen' in
            // analytics.sla — leads the manager was assigned but hasn't
            // called within the expected window).
            if (metric.key === "frozenLeads") {
              fact = String(frozenLeadsMap.get(mgr.id) ?? 0);
            }
            const percent = computePercent(metric.key, metric.unit, fact, plan);
            return { key: metric.key, plan, fact, percent };
          });

        return { id: mgr.id, name: mgr.name, line: mgr.line, kommoUserId: mgr.kommoUserId, metrics: mgrMetrics };
      });
    }

    return {
      key: section.key,
      title: section.title,
      icon: section.icon,
      dbLine: section.dbLine,
      perManager: section.perManager,
      metrics: summaryMetrics,
      managers: managerData,
    };
  });

  const scheduleInfo = period === "day"
    ? {
        allManagers: allManagers
          .map((m) => ({
            id: m.id,
            name: m.name,
            line: m.line,
            isOnLine: onLineManagerIds.includes(m.id),
          })),
        hasSchedule: scheduleMap !== null,
      }
    : undefined;

  return {
    date: dateStr,
    period,
    periodType,
    periodDate,
    sections,
    schedule: scheduleInfo,
    refusals: department === "b2g"
      ? {
          firstLine: refusalReasons.get("firstLine") ?? [],
          berater: refusalReasons.get("berater") ?? [],
        }
      : null,
  };
}

// ==================== B2B FACT RESOLVER ====================

interface B2BFactContext {
  summaryCallMetrics: UserCallMetrics;
  managersOnLineCount: number;
  sectionManagers: Array<{ id: string; kommoUserId: number | null; line: string | null }>;
  buh: B2BStatsSQL;
  med: B2BStatsSQL;
  getPlan: (line: string, userId: string | null, metricKey: string) => string | null;
  sectionDbLine: string;
  okkBuh1: number | null;
  okkBuh2: number | null;
  okkMed: number | null;
  /** SLA "from-shift" в СЕКУНДАХ — источник хранит секунды; в минуты
   *  конвертируется на выдаче calls_sla_f (ТЗ 2026-07-22: факт в минутах). */
  slaShiftSeconds: number | null;
  avgWaitSeconds: number | null;
}

/** Safe integer percent = Math.round(num/den * 100); 0 when den is 0. */
function pct(num: number, den: number): number {
  if (!den || den <= 0) return 0;
  return Math.round((num / den) * 100);
}

// ── Unit-aware percent (DRY) ─────────────────────────────────────────────
// Plan/fact in Daily mix three units: integer counts, "%" (skip percent
// entirely — fact already IS a percent), and durations.
//
// SLA / TLT facts are emitted in SECONDS so the UI can render HH:MM:SS, but
// admin-entered plans (sla_p / calls_sla_p) are in MINUTES. Without this
// normalisation the % column showed e.g. 600 sec ÷ 25 min = 2400 %, while
// the traffic-light cell on the same row was correctly green (it does the
// same conversion in DailyTab.getTrafficLightClass). Now both agree.
//
// Keep this set in sync with DailyTab DURATION_SEC_KEYS / DURATION_MIN_KEYS.
// NB: b2b-ключей (calls_sla_f/calls_sla_p) здесь больше нет — с 2026-07-22
// их план и факт оба в минутах, конвертация не нужна. Секунды остались
// только у Гос (sla_f/sla_shift_f/tlt_f ↔ sla_p).
const FACT_KEYS_IN_SECONDS = new Set<string>([
  "sla_f", "sla_shift_f", "tlt_f",
]);
const PLAN_KEYS_IN_MINUTES = new Set<string>([
  "sla_p",
]);

/**
 * Plan/fact ratio expressed as %. Returns null when missing inputs or unit
 * mismatch can't be reconciled. Unit "%" rows return null because their
 * fact already IS a percent and the % column would be redundant.
 */
function computePercent(
  metricKey: string,
  unit: "" | "%" | "мин" | "шт" | "сек",
  fact: string | null,
  plan: string | null,
): number | null {
  if (unit === "%") return null;
  if (!plan || !fact) return null;
  const factNum = Number(fact);
  let planNum = Number(plan);
  if (!Number.isFinite(factNum) || !Number.isFinite(planNum) || planNum <= 0) return null;
  // Plan minutes → seconds when the fact is emitted in seconds. Mirrors the
  // same lookup table the UI uses for HH:MM:SS rendering.
  if (FACT_KEYS_IN_SECONDS.has(metricKey) && PLAN_KEYS_IN_MINUTES.has(`${metricKey.slice(0, -2)}_p`)) {
    planNum *= 60;
  }
  return Math.round((factNum / planNum) * 100);
}

function avgCheck(revenue: number, sales: number): number {
  if (!sales || sales <= 0) return 0;
  return Math.round(revenue / sales);
}

function planDone(fact: number, planStr: string | null): string | null {
  const plan = Number(planStr ?? 0);
  if (!plan || plan <= 0) return "0";
  return String(Math.round((fact / plan) * 100));
}

function getB2BFact(key: string, sectionKey: string, ctx: B2BFactContext): string | null {
  const { summaryCallMetrics, managersOnLineCount, buh, med } = ctx;
  const totalSales = buh.salesCount + med.salesCount;
  const totalQualLeads = buh.qualLeads + med.qualLeads;

  // ===== Manual plan inputs (Monthly, scaled by getPlan) =====
  // getPlan now falls back to B2B_FIXED_PLAN_DEFAULTS and applies the same
  // planDivisor scaling as for admin-stored values, so every "?? 0" here
  // trips only when the metric has no fixed default (currently none).
  const buhKomLeadsPlan = Number(ctx.getPlan("salesBuh", null, "buh_komLeads_p") ?? 0);
  const medKomLeadsPlan = Number(ctx.getPlan("salesMed", null, "med_komLeads_p") ?? 0);
  const buhAvgCheckPlan = Number(ctx.getPlan("salesBuh", null, "buh_avgCheck_p") ?? 0);
  const medAvgCheckPlan = Number(ctx.getPlan("salesMed", null, "med_avgCheck_p") ?? 0);
  const buhQl2pPlan = Number(ctx.getPlan("salesBuh", null, "buh_ql2p_p") ?? 0);
  const medQl2pPlan = Number(ctx.getPlan("salesMed", null, "med_ql2p_p") ?? 0);
  const TOTAL_QL2P_DEFAULT = Number(B2B_FIXED_PLAN_DEFAULTS.total_ql2p_p);

  // Derived plans
  const buhSalesPlan = Math.round(buhKomLeadsPlan * buhQl2pPlan / 100);
  const medSalesPlan = medQl2pPlan > 0 ? Math.round(medKomLeadsPlan * medQl2pPlan / 100) : 0;
  const buhRevenuePlan = buhSalesPlan * buhAvgCheckPlan;
  const medRevenuePlan = medSalesPlan * medAvgCheckPlan;

  // Renewals — Excel row126/127 "Общая выручка план/факт" inside the
  // "Продления" block. The dashboard stores Бух/Мед separately as editable
  // cells so the split is visible per-stream; defaults to 0 until the user
  // enters a value.
  const buhRenewalsPlan = Number(ctx.getPlan("salesBuh", null, "buh_renewalsRevenue_p") ?? 0);
  const buhRenewalsFact = Number(ctx.getPlan("salesBuh", null, "buh_renewalsRevenue_f") ?? 0);
  const medRenewalsPlan = Number(ctx.getPlan("salesMed", null, "med_renewalsRevenue_p") ?? 0);
  const medRenewalsFact = Number(ctx.getPlan("salesMed", null, "med_renewalsRevenue_f") ?? 0);

  // User-override helper: пустая строка / null означает "не задано".
  const overrideNum = (line: string, metricKey: string, fallback: number): number => {
    const v = ctx.getPlan(line, null, metricKey);
    if (v == null || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  // Каскад факт-значений (Excel: B50=B66+B86, B48=B50+B141, B22=B24+B141):
  //   если пользователь перекрыл buh_newRevenue_f / med_newRevenue_f вручную,
  //   агрегаты (total_newRevenue_f, total_revenueTotal_f, *_salesPlusRenewals_f)
  //   должны учитывать именно этот ввод — иначе на экране получится три
  //   одинаковые цифры из SQL вместо реально разных значений.
  const buhRevenueFact = overrideNum("salesBuh", "buh_newRevenue_f", buh.revenue);
  const medRevenueFact = overrideNum("salesMed", "med_newRevenue_f", med.revenue);
  const newRevenuePlan = overrideNum("salesTotal", "total_newRevenue_p", buhRevenuePlan + medRevenuePlan);
  const newRevenueFactComputed = buhRevenueFact + medRevenueFact;
  const newRevenueFact = overrideNum("salesTotal", "total_newRevenue_f", newRevenueFactComputed);
  const totalRenewalsPlan = buhRenewalsPlan + medRenewalsPlan;
  const totalRenewalsFact = buhRenewalsFact + medRenewalsFact;
  const revenueTotalPlan = overrideNum("salesTotal", "total_revenueTotal_p", newRevenuePlan + totalRenewalsPlan);
  const revenueTotalFactComputed = newRevenueFact + totalRenewalsFact;
  const revenueTotalFact = overrideNum("salesTotal", "total_revenueTotal_f", revenueTotalFactComputed);
  const buhSalesPlusRenewalsPlan = overrideNum("salesBuh", "buh_salesPlusRenewals_p", buhRevenuePlan + buhRenewalsPlan);
  const buhSalesPlusRenewalsFactComputed = buhRevenueFact + buhRenewalsFact;
  const buhSalesPlusRenewalsFact = overrideNum("salesBuh", "buh_salesPlusRenewals_f", buhSalesPlusRenewalsFactComputed);
  const medSalesPlusRenewalsPlan = overrideNum("salesMed", "med_salesPlusRenewals_p", medRevenuePlan + medRenewalsPlan);
  const medSalesPlusRenewalsFactComputed = medRevenueFact + medRenewalsFact;
  const medSalesPlusRenewalsFact = overrideNum("salesMed", "med_salesPlusRenewals_f", medSalesPlusRenewalsFactComputed);

  // ========== 1. ПРОДАЖИ ТОТАЛ (R5-R19) ==========
  if (sectionKey === "salesTotal") {
    switch (key) {
      case "total_revenueTotal_p": return String(revenueTotalPlan);           // R5
      case "total_revenueTotal_f": return String(revenueTotalFact);           // R6
      case "total_newRevenue_p":   return String(newRevenuePlan);             // R7
      case "total_newRevenue_f":   return String(newRevenueFact);             // R8
      case "total_komLeads_p":     return String(buhKomLeadsPlan + medKomLeadsPlan); // R9
      case "total_komLeads_f":     return String(totalQualLeads);             // R10
      case "total_sales_p":        return String(buhSalesPlan + medSalesPlan);// R11
      case "total_sales_f":        return String(totalSales);                 // R12
      case "total_prepayments":    return String(buh.prepaymentCount + med.prepaymentCount); // R13
      case "total_ql2p_p":         return String(TOTAL_QL2P_DEFAULT);         // R14 — жёстко 8
      case "total_ql2p_f": {                                                  // R15
        const buhFact = pct(buh.salesCount, buh.qualLeads);
        const medFact = pct(med.salesCount, med.qualLeads);
        const vals = [buhFact, medFact].filter((v) => v > 0);
        return vals.length ? String(Math.round(vals.reduce((s, v) => s + v, 0) / vals.length)) : "0";
      }
      case "total_avgCheck_p": {                                              // R16
        const vals = [buhAvgCheckPlan, medAvgCheckPlan].filter((v) => v > 0);
        return vals.length ? String(Math.round(vals.reduce((s, v) => s + v, 0) / vals.length)) : "0";
      }
      case "total_avgCheck_f": {                                              // R17
        const buhAC = avgCheck(buhRevenueFact, buh.salesCount);
        const medAC = avgCheck(medRevenueFact, med.salesCount);
        const vals = [buhAC, medAC].filter((v) => v > 0);
        return vals.length ? String(Math.round(vals.reduce((s, v) => s + v, 0) / vals.length)) : "0";
      }
      case "total_planDoneTotal": return planDone(revenueTotalFact, String(revenueTotalPlan)); // R18
      case "total_planDoneNew":   return planDone(newRevenueFact, String(newRevenuePlan));     // R19
    }
  }

  // ========== 2. ПРОДАЖИ БУХ (R21-R35) ==========
  if (sectionKey === "salesBuh") {
    switch (key) {
      case "buh_salesPlusRenewals_p": return String(buhSalesPlusRenewalsPlan); // R21
      case "buh_salesPlusRenewals_f": return String(buhSalesPlusRenewalsFact); // R22
      case "buh_newRevenue_p": return String(buhRevenuePlan);                  // R23
      case "buh_newRevenue_f": return String(buhRevenueFact);                  // R24
      case "buh_renewalsRevenue_p": return String(buhRenewalsPlan);            // Excel row126 (Бух portion)
      case "buh_renewalsRevenue_f": return String(buhRenewalsFact);            // Excel row127 (Бух portion)
      case "buh_komLeads_f":   return String(buh.qualLeads);                   // R26
      case "buh_sales_p":      return String(buhSalesPlan);                    // R27
      case "buh_sales_f":      return String(buh.salesCount);                  // R28
      case "buh_prepayments":  return String(buh.prepaymentCount);             // R29
      case "buh_ql2p_p":       return String(buhQl2pPlan);                    // R30 (default 7.5%)
      case "buh_ql2p_f":       return String(pct(buh.salesCount, buh.qualLeads)); // R31
      // L2P Бух — Excel rows 63/64 "L2P Total". Ratio of sales to total
      // leads (not qualified). Plan value comes through the regular
      // hasPlan-true path; _f is computed here from analytics totals.
      case "buh_l2p_f":        return String(pct(buh.salesCount, buh.totalLeads));
      case "buh_avgCheck_f":   return String(avgCheck(buhRevenueFact, buh.salesCount)); // R33
      case "buh_planDoneTotal": return planDone(buhSalesPlusRenewalsFact, String(buhSalesPlusRenewalsPlan)); // R34
      case "buh_planDoneNew":   return planDone(buhRevenueFact, String(buhRevenuePlan));                     // R35
    }
  }

  // ========== 3. ПРОДАЖИ МЕД (R37-R51) ==========
  if (sectionKey === "salesMed") {
    switch (key) {
      case "med_salesPlusRenewals_p": return String(medSalesPlusRenewalsPlan); // R37
      case "med_salesPlusRenewals_f": return String(medSalesPlusRenewalsFact); // R38
      case "med_newRevenue_p": return String(medRevenuePlan);                  // R39
      case "med_newRevenue_f": return String(medRevenueFact);                  // R40
      case "med_renewalsRevenue_p": return String(medRenewalsPlan);            // Excel row126 (Мед portion)
      case "med_renewalsRevenue_f": return String(medRenewalsFact);            // Excel row127 (Мед portion)
      case "med_komLeads_f":   return String(med.qualLeads);                   // R42
      case "med_sales_p":      return String(medSalesPlan);                    // R43
      case "med_sales_f":      return String(med.salesCount);                  // R44
      case "med_prepayments":  return String(med.prepaymentCount);             // R45
      case "med_ql2p_f":       return String(pct(med.salesCount, med.qualLeads)); // R47
      // L2P Мед — симметрично Бух (sales / total leads).
      case "med_l2p_f":        return String(pct(med.salesCount, med.totalLeads));
      case "med_avgCheck_f":   return String(avgCheck(medRevenueFact, med.salesCount)); // R49
      case "med_planDoneTotal": return planDone(medSalesPlusRenewalsFact, String(medSalesPlusRenewalsPlan)); // R50
      case "med_planDoneNew":   return planDone(medRevenueFact, String(medRevenuePlan));                     // R51
    }
  }

  // ========== 4. ЗВОНКИ + ОКК (R53-R72) ==========
  if (sectionKey === "calls") {
    switch (key) {
      case "calls_managersOnLine_f": return String(managersOnLineCount);      // R54 — из Графика (manager_schedule)
      case "calls_total_p":          return String(managersOnLineCount * 80); // R55
      case "calls_total_f":          return String(summaryCallMetrics.callsTotal); // R56
      case "calls_totalMinutes_p":   return String(managersOnLineCount * 160);// R57
      case "calls_totalMinutes_f":   return String(summaryCallMetrics.totalMinutes); // R58
      // Оставшиеся plan rows (звонки/дозвон/ОКК): hasPlan:true → plan lookup
      // in the outer render loop. Константы ожидания/SLA — здесь (ТЗ 2026-07-22).
      case "calls_avgWait_p":        return "30";
      // Ожидание/SLA факты — в МИНУТАХ (1 знак), источники держат секунды.
      case "calls_avgWait_f":        return ctx.avgWaitSeconds != null ? String(Math.round(ctx.avgWaitSeconds / 60 * 10) / 10) : null; // R60
      case "calls_dialPercent_f":    return String(summaryCallMetrics.dialPercent); // R62
      case "calls_sla_p":            return "25";
      case "calls_sla_f":            return ctx.slaShiftSeconds != null ? String(Math.round(ctx.slaShiftSeconds / 60 * 10) / 10) : null; // R64
      // OKK facts: prefer OKK DB; fall back to stored daily_plans for dates
      // before OKK launch (≈ 2026-03-04) where Excel has the only record.
      case "okk_buh1_f":             return ctx.okkBuh1 != null ? String(ctx.okkBuh1) : (ctx.getPlan("calls", null, "okk_buh1_f") ?? null);
      case "okk_buh2_f":             return ctx.okkBuh2 != null ? String(ctx.okkBuh2) : (ctx.getPlan("calls", null, "okk_buh2_f") ?? null);
      case "okk_med1_f":             return ctx.okkMed  != null ? String(ctx.okkMed)  : (ctx.getPlan("calls", null, "okk_med1_f") ?? null);
      case "okk_avg_p": {                                                     // R71 = AVG(plans)
        const p1 = Number(ctx.getPlan("calls", null, "okk_buh1_p") ?? 85);
        const p2 = Number(ctx.getPlan("calls", null, "okk_buh2_p") ?? 85);
        const p3 = Number(ctx.getPlan("calls", null, "okk_med1_p") ?? 85);
        return String(Math.round((p1 + p2 + p3) / 3));
      }
      case "okk_avg_f": {                                                     // R72
        const vals = [ctx.okkBuh1, ctx.okkBuh2, ctx.okkMed].filter((v): v is number => v != null);
        if (vals.length) return String(Math.round(vals.reduce((s, v) => s + v, 0) / vals.length));
        // Все три OKK DB-значения null → fallback на Excel-значение okk_avg_f.
        return ctx.getPlan("calls", null, "okk_avg_f") ?? null;
      }
    }
  }

  return null;
}

// ==================== FUNNEL FACT RESOLVER ====================

/** Metrics that depend on non-date-filtered snapshot data (current Kommo state).
 *  `activeDeals` is reconstructable for historical dates, so it's NOT in this set. */
const SNAPSHOT_ONLY_METRICS = new Set([
  "avgPortfolio",
  "awaitTermTotal", "awaitTermNew",
  "termDCCancelled", "termDCDone", "termAACount",
  "beraterReview", "delayedStart", "appeal",
  "a2", "b1", "b2plus",
  // tasks/consult per-manager filter mgrActiveLeads (live snapshot) — for
  // historical dates without a stored snapshot the numbers would leak today's
  // state. Gate them the same way as the other snapshot-derived metrics.
  "tasksTotal", "tasksNew",
  "consultTotal", "consultNew",
  "appealsSubmitted",
]);

function getFunnelFact(
  key: string,
  fc: LeadFunnelCounts,
  managersOnLine: number,
  snapshotLeads?: KommoLead[],
  line1ManagerCount?: number,
  termsWonLeads?: KommoLead[],
  from?: number,
  _to?: number,
  newLeadsInPeriod?: KommoLead[],
  termAATransferredCount?: number,
  hasSnapshotData = true,
  reconstructedActiveDeals?: number | null,
  firstLinePipes?: Set<number>,
  beraterPipes?: Set<number>,
  dateStr?: string,
  fl?: ReturnType<typeof getFirstLineStatusSets>,
  br?: ReturnType<typeof getBeraterStatusSets>,
): string | null {
  // Vertical-aware наборы; дефолты = буховые (legacy).
  const flPipes = firstLinePipes ?? new Set([10935879]);
  const brPipes = beraterPipes ?? new Set([12154099]);
  const flS = fl ?? getFirstLineStatusSets();
  const brS = br ?? getBeraterStatusSets();
  // For historical dates without stored snapshots, snapshot-only metrics are unavailable
  if (!hasSnapshotData && SNAPSHOT_ONLY_METRICS.has(key)) {
    return null;
  }

  switch (key) {
    case "activeDeals": {
      // Use reconstructed count for historical dates
      if (!hasSnapshotData && reconstructedActiveDeals != null) {
        return String(reconstructedActiveDeals);
      }
      const adCount = (snapshotLeads || []).filter((l) => !l.is_deleted && !l.closed_at).length;
      return String(adCount);
    }
    case "termsTotal":
      return String(termsWonLeads?.length ?? 0);
    case "termsNew": {
      // "New" = leads created in current month, APP_TZ-aware bounds.
      const { start: monthStart, end: monthEnd } = monthBoundsSec(dateStr ?? "2026-01-01");
      return String((termsWonLeads || []).filter((l) => l.created_at >= monthStart && l.created_at <= monthEnd).length);
    }
    case "managersOnLine":
      return String(managersOnLine);
    case "totalLeads": {
      // All leads from first line created in period, excluding Неразобранное
      // and База — those are mailbox/staging stages, not real leads.
      const excludeFromTotal = new Set<number>([...flS.unsorted, ...flS.base]);
      const allNew = (newLeadsInPeriod || []).filter((l) => !l.is_deleted && !excludeFromTotal.has(l.status_id));
      return String(allNew.length);
    }
    case "qualLeads": {
      // Квал = есть буква в Category (CFV 866934). Per user spec 2026-04-24.
      // Не-квал = category NULL/empty — лид закрыт как "Неквал лид" или не оценен.
      const excludeS = new Set<number>([...flS.unsorted, ...flS.base]);
      const qualCount = (newLeadsInPeriod || []).filter((l) => {
        if (l.is_deleted || excludeS.has(l.status_id)) return false;
        return hasCategoryLetter(l);
      }).length;
      return String(qualCount);
    }
    case "a2":
      return String(fc.a2);
    case "b1":
      return String(fc.b1);
    case "b2plus":
      return String(fc.b2plus);
    case "avgPortfolio": {
      // Portfolio excludes won/lost + База + Отложенный старт (staging).
      const excludeStatuses = new Set<number>([
        142,
        143,
        ...flS.base,
        ...flS.delayedStart,
      ]);
      const portfolioLeads = (snapshotLeads || []).filter(
        (l) => flPipes.has(l.pipeline_id) && !l.is_deleted && !excludeStatuses.has(l.status_id)
      );
      const divisor = line1ManagerCount || managersOnLine || 1;
      return String(Math.round(portfolioLeads.length / divisor));
    }
    case "awaitTermTotal": {
      const awaitStatuses = new Set<number>([
        ...brS.receivedFromFirst,
        ...brS.dovedenie,
        ...brS.consultBeforeDC,
        ...brS.consultBeforeDCDone,
      ]);
      const awaiting = (snapshotLeads || []).filter(
        (l) => brPipes.has(l.pipeline_id) && !l.is_deleted && !l.closed_at && awaitStatuses.has(l.status_id)
      );
      return String(awaiting.length);
    }
    case "awaitTermNew": {
      // Awaiting term + created in current month
      const awaitStatusesNew = new Set<number>([
        ...brS.receivedFromFirst,
        ...brS.dovedenie,
        ...brS.consultBeforeDC,
        ...brS.consultBeforeDCDone,
      ]);
      const { start: mStartNew, end: mEndNew } = monthBoundsSec(dateStr ?? "2026-01-01");
      const awaitingNew = (snapshotLeads || []).filter(
        (l) =>
          brPipes.has(l.pipeline_id) &&
          !l.is_deleted &&
          !l.closed_at &&
          awaitStatusesNew.has(l.status_id) &&
          l.created_at >= mStartNew &&
          l.created_at <= mEndNew
      );
      return String(awaitingNew.length);
    }
    case "qualLeadsPercent": {
      const exS = new Set<number>([...flS.unsorted, ...flS.base]);
      const allNewP = (newLeadsInPeriod || []).filter((l) => !l.is_deleted && !exS.has(l.status_id));
      const qualP = allNewP.filter(hasCategoryLetter).length;
      return allNewP.length > 0 ? String(Math.round((qualP / allNewP.length) * 100)) : "0";
    }
    // ─── Berater pipeline snapshot metrics ───
    case "termDCCancelled": {
      return String((snapshotLeads || []).filter(
        (l) => brPipes.has(l.pipeline_id) && !l.is_deleted && !l.closed_at && brS.termDCCancelled.has(l.status_id)
      ).length);
    }
    case "termDCDone": {
      return String((snapshotLeads || []).filter(
        (l) => brPipes.has(l.pipeline_id) && !l.is_deleted && !l.closed_at && brS.termDCDone.has(l.status_id)
      ).length);
    }
    case "termAATransferred": {
      // Переведены на термин АА: counted via Events API (status changes).
      return String(termAATransferredCount ?? 0);
    }
    case "termAACancelled": {
      return String((snapshotLeads || []).filter(
        (l) => brPipes.has(l.pipeline_id) && !l.is_deleted && !l.closed_at && brS.termAACancelled.has(l.status_id)
      ).length);
    }
    case "termAACount": {
      // Both CONSULT_BEFORE_AA stages count as "Термин АА (на этапе)".
      const aaStatuses = new Set<number>([...brS.consultBeforeAA, ...brS.consultBeforeAADone]);
      return String((snapshotLeads || []).filter(
        (l) => brPipes.has(l.pipeline_id) && !l.is_deleted && !l.closed_at && aaStatuses.has(l.status_id)
      ).length);
    }
    case "beraterReview": {
      return String((snapshotLeads || []).filter(
        (l) => brPipes.has(l.pipeline_id) && !l.is_deleted && !l.closed_at && brS.beraterReview.has(l.status_id)
      ).length);
    }
    case "delayedStart": {
      // Обе воронки — как в per-manager ветке и FUNNEL_STATUS_MAP (code-review
      // 2026-07-06: раньше team-счёт брал только Бератер и был меньше суммы
      // по менеджерам).
      return String((snapshotLeads || []).filter(
        (l) =>
          !l.is_deleted && !l.closed_at &&
          ((brPipes.has(l.pipeline_id) && brS.delayedStart.has(l.status_id))
            || (flPipes.has(l.pipeline_id) && flS.delayedStart.has(l.status_id)))
      ).length);
    }
    case "appeal": {
      return String((snapshotLeads || []).filter(
        (l) => brPipes.has(l.pipeline_id) && !l.is_deleted && !l.closed_at && brS.appeal.has(l.status_id)
      ).length);
    }
    case "gutscheinPlanDone":
      // Computed in summaryMetrics loop after plan is resolved — handled there
      return null;
    case "revenue": {
      // Sum of prices on WON leads in the berater pipeline for this period.
      // (termsWonLeads is already scoped to the berater won-in-range dataset.)
      const rev = (termsWonLeads || []).reduce((s, l) => s + (l.price || 0), 0);
      return String(rev);
    }
    case "convQualTask":
      return fc.qualLeadsFlow > 0
        ? String(Math.round(((fc.byMetric.tasksTotal ?? 0) / fc.qualLeadsFlow) * 100))
        : "0";
    case "convTaskConsult":
      return (fc.byMetric.tasksTotal ?? 0) > 0
        ? String(Math.round(((fc.byMetric.consultTotal ?? 0) / (fc.byMetric.tasksTotal ?? 1)) * 100))
        : "0";
    case "convConsultTerm":
      return (fc.byMetric.consultTotal ?? 0) > 0
        ? String(Math.round(((fc.byMetric.termsTotal ?? 0) / (fc.byMetric.consultTotal ?? 1)) * 100))
        : "0";
    default: {
      if (key in fc.byMetric) return String(fc.byMetric[key]);
      if (key in fc.byMetricNew) return String(fc.byMetricNew[key]);
      return null;
    }
  }
}
