// Shared logic for building Daily API responses
// Used by both /api/daily and /api/daily/range routes
import { cached } from "@/lib/kommo/cache";
import { getTasks } from "@/lib/kommo/client";
import {
  aggregateLeadMetrics,
  aggregateLeadFunnelMetrics,
  aggregateTaskMetrics,
  sumCallMetrics,
  hasCategoryLetter,
  type UserCallMetrics,
} from "@/lib/kommo/metrics";
import { getAnalyticsCallMetricsByMaster, getAnalyticsTeamCallMetrics } from "@/lib/daily/analytics-calls";
import { getManagersWithKommo, getPlans, getScheduleForDate, getUniqueOnLineManagerCount } from "@/lib/db/queries-daily";
import { getDailySections } from "@/lib/daily/metrics-config";
import {
  getPipelineIds,
  getActiveStatusIds,
  B2G_PIPELINES,
  B2B_PIPELINES,
  A2_STATUSES,
  B1_STATUSES,
  B2_PLUS_STATUSES,
  FUNNEL_STATUS_MAP,
} from "@/lib/kommo/pipeline-config";
import { resolveByAlias } from "@/lib/daily/name-aliases";
import { getB2BPipelineStatsSQL, getB2BPerManagerStatsSQL, type B2BPipelineStats as B2BStatsSQL } from "@/lib/daily/analytics-b2b";
import { getAnalyticsLeads, getAnalyticsStatusChangeCount } from "@/lib/daily/analytics-leads";
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
import { sql as drizzleSql, and, eq, gte, lte, isNotNull } from "drizzle-orm";

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

/** Get average OKK score for a line on a specific date */
async function getOkkAvgScore(department: "b2g" | "b2b", fromTs: number, toTs: number, promptTypes: string[]): Promise<number | null> {
  try {
    const db = getOkkDbForDepartment(department);
    const from = new Date(fromTs * 1000);
    const to = new Date(toTs * 1000);
    const rows = await db
      .select({ avg: drizzleSql<number>`round(avg(${okkEvaluations.totalScore}))::int` })
      .from(okkEvaluations)
      .innerJoin(okkCalls, eq(okkEvaluations.callId, okkCalls.id))
      .where(
        and(
          gte(okkCalls.callCreatedAt, from),
          lte(okkCalls.callCreatedAt, to),
          isNotNull(okkEvaluations.totalScore),
          drizzleSql`${okkEvaluations.promptType} IN (${drizzleSql.join(promptTypes.map(p => drizzleSql`${p}`), drizzleSql`, `)})`,
        )
      );
    return rows[0]?.avg ?? null;
  } catch { return null; }
}

/** Get average roleplay score for a line on a specific date */
async function getRoleplayAvgScore(department: "b2g" | "b2b", fromTs: number, toTs: number, callTypes: string[]): Promise<number | null> {
  try {
    const db = getDbForDepartment(department);
    const callsTable = department === "b2b" ? r1Calls : d1Calls;
    const from = new Date(fromTs * 1000);
    const to = new Date(toTs * 1000);
    const rows = await db
      .select({ avg: drizzleSql<number>`round(avg(${callsTable.score}))::int` })
      .from(callsTable)
      .where(
        and(
          gte(callsTable.startedAt, from),
          lte(callsTable.startedAt, to),
          isNotNull(callsTable.score),
          drizzleSql`${callsTable.callType} IN (${drizzleSql.join(callTypes.map(ct => drizzleSql`${ct}`), drizzleSql`, `)})`,
        )
      );
    return rows[0]?.avg ?? null;
  } catch { return null; }
}

/** Get per-manager OKK avg scores: managerId → score */
async function getOkkPerManagerScores(department: "b2g" | "b2b", fromTs: number, toTs: number, promptTypes: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  try {
    const okkDb = getOkkDbForDepartment(department);
    const from = new Date(fromTs * 1000);
    const to = new Date(toTs * 1000);
    const rows = await okkDb
      .select({
        managerId: okkEvaluations.managerId,
        avg: drizzleSql<number>`round(avg(${okkEvaluations.totalScore}))::int`,
      })
      .from(okkEvaluations)
      .innerJoin(okkCalls, eq(okkEvaluations.callId, okkCalls.id))
      .where(
        and(
          gte(okkCalls.callCreatedAt, from),
          lte(okkCalls.callCreatedAt, to),
          isNotNull(okkEvaluations.totalScore),
          drizzleSql`${okkEvaluations.promptType} IN (${drizzleSql.join(promptTypes.map(p => drizzleSql`${p}`), drizzleSql`, `)})`,
        )
      )
      .groupBy(okkEvaluations.managerId);
    for (const r of rows) {
      if (r.managerId && r.avg !== null) result.set(r.managerId, r.avg);
    }
  } catch { /* ignore */ }
  return result;
}

/** Get per-manager roleplay avg scores: userId → score */
async function getRoleplayPerManagerScores(department: "b2g" | "b2b", fromTs: number, toTs: number, callTypes: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  try {
    const rpDb = getDbForDepartment(department);
    const callsTable = department === "b2b" ? r1Calls : d1Calls;
    const from = new Date(fromTs * 1000);
    const to = new Date(toTs * 1000);
    const rows = await rpDb
      .select({
        userId: callsTable.userId,
        avg: drizzleSql<number>`round(avg(${callsTable.score}))::int`,
      })
      .from(callsTable)
      .where(
        and(
          gte(callsTable.startedAt, from),
          lte(callsTable.startedAt, to),
          isNotNull(callsTable.score),
          drizzleSql`${callsTable.callType} IN (${drizzleSql.join(callTypes.map(ct => drizzleSql`${ct}`), drizzleSql`, `)})`,
        )
      )
      .groupBy(callsTable.userId);
    for (const r of rows) {
      if (r.userId && r.avg !== null) result.set(r.userId, r.avg);
    }
  } catch { /* ignore */ }
  return result;
}

/** Get average SLA and TLT (minutes) for a pipeline from analytics.sla */
async function getSlaFacts(
  pipelineId: number,
  fromDate: Date,
  toDate: Date,
): Promise<{ slaMinutes: number | null; slaShiftMinutes: number | null; tltMinutes: number | null }> {
  try {
    const result = await (analyticsDb as { execute: <T>(sql: unknown) => Promise<{ rows: T[] }> }).execute<{
      avg_sla: number | null;
      avg_sla_shift: number | null;
      avg_tlt: number | null;
    }>(
      drizzleSql`
        SELECT
          round(avg(sla_first_call_seconds) / 60.0)::int            AS avg_sla,
          round(avg(sla_first_call_from_shift_seconds) / 60.0)::int AS avg_sla_shift,
          round(avg(sla_first_contact_seconds) / 60.0)::int         AS avg_tlt
        FROM analytics.sla
        WHERE pipeline_id = ${pipelineId}
          AND lead_created_at >= ${fromDate}
          AND lead_created_at <= ${toDate}
          AND sla_first_call_seconds IS NOT NULL
      `,
    );
    const row = result.rows[0];
    return {
      slaMinutes: row?.avg_sla != null ? Number(row.avg_sla) : null,
      slaShiftMinutes: row?.avg_sla_shift != null ? Number(row.avg_sla_shift) : null,
      tltMinutes: row?.avg_tlt != null ? Number(row.avg_tlt) : null,
    };
  } catch {
    return { slaMinutes: null, slaShiftMinutes: null, tltMinutes: null };
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
  pipelineId: number,
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
          WHERE lc.pipeline_id = ${pipelineId}
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

/** Avg calls per lead for a pipeline: total calls ÷ distinct lead_ids that
 *  received at least one call in range. Team-level. */
async function getAvgCallsPerLead(
  pipelineId: number,
  fromDate: Date,
  toDate: Date,
): Promise<number | null> {
  try {
    const result = await (analyticsDb as { execute: <T>(sql: unknown) => Promise<{ rows: T[] }> }).execute<{
      total_calls: number | string;
      unique_leads: number | string;
    }>(
      drizzleSql`
        SELECT
          COUNT(*)::int                  AS total_calls,
          COUNT(DISTINCT lead_id)::int   AS unique_leads
        FROM analytics.communications
        WHERE pipeline_id = ${pipelineId}
          AND created_at >= ${fromDate}
          AND created_at <= ${toDate}
          AND communication_type LIKE 'call%'
          AND lead_id IS NOT NULL
      `,
    );
    const row = result.rows[0];
    if (!row) return null;
    const totalCalls = Number(row.total_calls);
    const uniqueLeads = Number(row.unique_leads);
    if (uniqueLeads <= 0) return null;
    return Math.round((totalCalls / uniqueLeads) * 10) / 10;
  } catch {
    return null;
  }
}

/** Per-manager avg calls per lead — same metric grouped by `manager`. */
async function getAvgCallsPerLeadByManager(
  managers: Array<{ id: string; name: string }>,
  pipelineId: number,
  fromDate: Date,
  toDate: Date,
): Promise<Map<string, number>> {
  try {
    const result = await (analyticsDb as { execute: <T>(sql: unknown) => Promise<{ rows: T[] }> }).execute<{
      manager: string;
      total_calls: number | string;
      unique_leads: number | string;
    }>(
      drizzleSql`
        SELECT
          manager,
          COUNT(*)::int                  AS total_calls,
          COUNT(DISTINCT lead_id)::int   AS unique_leads
        FROM analytics.communications
        WHERE pipeline_id = ${pipelineId}
          AND created_at >= ${fromDate}
          AND created_at <= ${toDate}
          AND communication_type LIKE 'call%'
          AND lead_id IS NOT NULL
          AND manager IS NOT NULL AND manager <> ''
        GROUP BY manager
      `,
    );
    const byName = new Map<string, number>();
    for (const row of result.rows) {
      const t = Number(row.total_calls);
      const u = Number(row.unique_leads);
      if (u > 0) byName.set(row.manager, Math.round((t / u) * 10) / 10);
    }
    return resolveByAlias(managers, byName);
  } catch {
    return new Map();
  }
}

/** Per-manager SLA/TLT for a pipeline. Keyed by master_managers.id via the
 *  same name-alias map analytics-calls uses. */
async function getSlaFactsByManager(
  managers: Array<{ id: string; name: string }>,
  pipelineId: number,
  fromDate: Date,
  toDate: Date,
): Promise<Map<string, { slaMinutes: number | null; slaShiftMinutes: number | null; tltMinutes: number | null }>> {
  try {
    const result = await (analyticsDb as { execute: <T>(sql: unknown) => Promise<{ rows: T[] }> }).execute<{
      manager: string;
      avg_sla: number | null;
      avg_sla_shift: number | null;
      avg_tlt: number | null;
    }>(
      drizzleSql`
        SELECT
          manager,
          round(avg(sla_first_call_seconds) / 60.0)::int            AS avg_sla,
          round(avg(sla_first_call_from_shift_seconds) / 60.0)::int AS avg_sla_shift,
          round(avg(sla_first_contact_seconds) / 60.0)::int         AS avg_tlt
        FROM analytics.sla
        WHERE pipeline_id = ${pipelineId}
          AND lead_created_at >= ${fromDate}
          AND lead_created_at <= ${toDate}
          AND sla_first_call_seconds IS NOT NULL
          AND manager IS NOT NULL AND manager <> ''
        GROUP BY manager
      `,
    );
    const byName = new Map<string, { slaMinutes: number | null; slaShiftMinutes: number | null; tltMinutes: number | null }>();
    for (const row of result.rows) {
      byName.set(row.manager, {
        slaMinutes: row.avg_sla != null ? Number(row.avg_sla) : null,
        slaShiftMinutes: row.avg_sla_shift != null ? Number(row.avg_sla_shift) : null,
        tltMinutes: row.avg_tlt != null ? Number(row.avg_tlt) : null,
      });
    }
    return resolveByAlias(managers, byName);
  } catch {
    return new Map();
  }
}

// Line → OKK prompt types mapping.
// Derived from tenant config so new lines in src/lib/config/tenant.ts
// automatically flow through to Daily without touching this file.
import { groupPromptTypes } from "@/lib/config/tenant";

function lineToOkkPrompts(group: string): string[] {
  // B2G-only in the current setup; if B2B Daily rolls out, call with "b2b".
  return groupPromptTypes("b2g", group);
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

export async function buildDailyResponseCached(department: string, period: string, dateStr: string) {
  // daily_snapshots removed: analytics.* is now the single source of truth,
  // so every request recomputes from Postgres directly (sub-second). We keep
  // a 5-minute in-memory TTL per department+period+date to absorb bursts.
  const cacheKey = `daily-response:${department}:${period}:${dateStr}`;
  return cached(cacheKey, RESPONSE_CACHE_TTL, () =>
    buildDailyResponse(department, period, dateStr, false),
  );
}

// ==================== MAIN BUILD FUNCTION ====================

/**
 * @param isHistorical — true for past dates without stored snapshots.
 *   Skips non-date-filtered Kommo calls (snapshot leads, tasks) that would
 *   return today's data instead of the historical date's data.
 *   Affected metrics get fact=null so the UI shows "—" instead of wrong numbers.
 */
export async function buildDailyResponse(department: string, period: string, dateStr: string, isHistorical = false) {
  const { from, to, periodType, periodDate } = getDateRange(period, dateStr);
  // getMaxPages was used for Kommo pagination caps; no longer needed now that
  // leads come from analytics.leads_cohort (single SQL query, no pagination).

  // Department-aware pipeline/status IDs
  const allPipelineIds = getPipelineIds(department);
  const allActiveStatusIds = getActiveStatusIds(department);
  const firstLinePipelineId = department === "b2b" ? allPipelineIds[0] : B2G_PIPELINES.FIRST_LINE;
  const beraterPipelineId = department === "b2b" ? allPipelineIds[0] : B2G_PIPELINES.BERATER;

  const base = new Date(`${dateStr}T00:00:00Z`);
  const monthPeriodDate = `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}`;
  const daysInMonth = new Date(base.getUTCFullYear(), base.getUTCMonth() + 1, 0).getUTCDate();

  const [allManagers, monthlyPlans, scheduleMap] = await Promise.all([
    getManagersWithKommo(department),
    getPlans(department, "month", monthPeriodDate),
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
    isHistorical ? Promise.resolve([] as KommoTask[]) : getTasks(false).catch(trackError("tasks")),
    getAnalyticsLeads({ pipelineIds: allPipelineIds, statusIds: [142], dateFilter: closedDateFilter }).catch(trackError("won leads")),
    getAnalyticsLeads({ pipelineIds: allPipelineIds, statusIds: [143], dateFilter: closedDateFilter }).catch(trackError("lost leads")),
    // Call metrics come from the analytics DB (integrator mirror). Keyed by master_managers.id.
    getAnalyticsCallMetricsByMaster(allManagers, department, from, to).catch(trackAnalyticsError),
    getAnalyticsLeads({ pipelineIds: [firstLinePipelineId], statusIds: [142], dateFilter: termsDateFilter }).catch(trackError("terms won")),
    getAnalyticsLeads({ pipelineIds: [firstLinePipelineId], dateFilter: createdDateFilter }).catch(trackError("new leads")),
    getAnalyticsStatusChangeCount(from, to, beraterPipelineId, [102183943, 102183947]).catch(trackError("term AA events")),
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

  // Flag: snapshot metrics unavailable for historical dates without stored snapshots
  const hasSnapshotData = !isHistorical;

  // ── Reconstruct historical activeDeals ──
  // For past dates: combine current active leads (created before date) +
  // leads closed after date (they were alive on this date but got closed since)
  let reconstructedActiveDeals: number | null = null;
  let reconstructedActiveDealsPerUser: Map<number, number> | null = null;
  if (isHistorical && safeSnapshotActiveLeads.length > 0) {
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

  // NOTE: since getAnalyticsLeads() maps updated_at to created_at (analytics.*
  // doesn't mirror updated_at), this filter now equates to "created in period"
  // rather than "touched in period". For funnel flow metrics (a2/b1/b2plus)
  // this under-reports reassignments/status-changes on older leads. When the
  // analytics ETL grows an updated_at column, swap getAnalyticsLeads to expose
  // it and this approximation goes away.
  const flowActiveLeads = safeSnapshotActiveLeads.filter(
    (lead) => lead.updated_at >= from && lead.updated_at <= to
  );

  const snapshotLeads = [...safeSnapshotActiveLeads, ...safeWonLeads, ...safeLostLeads];
  const flowLeads = [...flowActiveLeads, ...safeWonLeads, ...safeLostLeads];

  // Analytics-backed per-master-id call map. Falls back to empty map on failure
  // (already handled upstream in trackAnalyticsError → new Map()).
  const callMetricsMap = analyticsCallMap;
  const leadMetricsMap = aggregateLeadMetrics(snapshotLeads, from, to);
  const funnelCounts = aggregateLeadFunnelMetrics(snapshotLeads, flowLeads, from, to, department);
  const taskMetricsMap = aggregateTaskMetrics(safeTasks);

  const planLookup = new Map<string, string>();
  for (const p of plans) {
    const key = `${p.line}:${p.userId || "null"}:${p.metricKey}`;
    planLookup.set(key, p.planValue);
  }

  // Non-cumulative planов НЕ делятся по дням: они — константы (процент,
  // среднее, время, количество-на-линии). Без этого, напр., SLA план 25 мин
  // для дня = Math.round(25/30) = 1 мин → UI показывает 1 что ошибочно.
  // Суммируемые (лиды, продажи, выручка, минуты звонков, количество звонков) —
  // делятся как раньше.
  const NON_CUMULATIVE_PLAN_KEYS = new Set<string>([
    // Проценты / средние — не суммируются
    "buh_avgCheck_p", "med_avgCheck_p", "total_avgCheck_p",
    "buh_ql2p_p", "med_ql2p_p", "total_ql2p_p",
    "buh_l2p_p", "med_l2p_p",
    // Звонки — константы
    "calls_managersOnLine_p",
    "calls_managersOnLine_f",   // Excel вводится руками как "5" — не сумма
    "calls_avgWait_p",
    "calls_avgWait_f",           // ручной ввод из Callgear
    "calls_dialPercent_p",
    "calls_sla_p",
    // ОКК — проценты
    "okk_buh1_p", "okk_buh2_p", "okk_med1_p", "okk_avg_p",
    // B2G roleplay / окк константы
    "sla_p", "okk_p", "roleplay_p", "avgWait_p", "regulationPercent",
  ]);

  const getPlan = (line: string, userId: string | null, metricKey: string): string | null => {
    let val: string | undefined;
    if (userId) {
      val = planLookup.get(`${line}:${userId}:${metricKey}`);
    }
    if (val === undefined) {
      val = planLookup.get(`${line}:null:${metricKey}`);
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
  const slaFacts = new Map<string, { slaMinutes: number | null; slaShiftMinutes: number | null; tltMinutes: number | null }>();
  // Per-manager SLA/TLT: line → Map<managerId, {slaMinutes, slaShiftMinutes, tltMinutes}>
  const slaPerManager = new Map<string, Map<string, { slaMinutes: number | null; slaShiftMinutes: number | null; tltMinutes: number | null }>>();
  // Refusal reasons: pipeline key ('firstLine' | 'berater') → sorted rows
  const refusalReasons = new Map<string, Array<{ reason: string; count: number; percent: number }>>();
  // Avg calls per lead: line → team avg + per-manager map
  const avgCallsPerLead = new Map<string, number | null>();
  const avgCallsPerLeadPerManager = new Map<string, Map<string, number>>();
  if (department === "b2g") {
    // Iterate over the same groups as LINE_TO_ROLEPLAY_TYPES so the two maps
    // stay index-compatible downstream.
    const okkPromises = Object.keys(LINE_TO_ROLEPLAY_TYPES).map(async (group) => {
      const prompts = lineToOkkPrompts(group);
      if (prompts.length === 0) return;
      const [avg, perMgr] = await Promise.all([
        getOkkAvgScore("b2g", from, to, prompts),
        getOkkPerManagerScores("b2g", from, to, prompts),
      ]);
      if (avg !== null) okkScores.set(group, avg);
      okkPerManager.set(group, perMgr);
    });
    const rpPromises = Object.entries(LINE_TO_ROLEPLAY_TYPES).map(async ([line, types]) => {
      const [avg, perMgr] = await Promise.all([
        getRoleplayAvgScore("b2g", from, to, types),
        getRoleplayPerManagerScores("b2g", from, to, types),
      ]);
      if (avg !== null) roleplayScores.set(line, avg);
      roleplayPerManager.set(line, perMgr);
    });
    // SLA / TLT facts from analytics DB (line 1 = first-line pipeline, line 3 = berater pipeline)
    const B2G_LINE_PIPELINES: Record<string, number> = {
      "1": B2G_PIPELINES.FIRST_LINE,
      "3": B2G_PIPELINES.BERATER,
    };
    const fromDate = new Date(from * 1000);
    const toDate = new Date(to * 1000);
    const slaPromises = Object.entries(B2G_LINE_PIPELINES).map(async ([line, pipelineId]) => {
      const [facts, perMgr] = await Promise.all([
        getSlaFacts(pipelineId, fromDate, toDate),
        getSlaFactsByManager(allManagers, pipelineId, fromDate, toDate),
      ]);
      slaFacts.set(line, facts);
      slaPerManager.set(line, perMgr);
    });

    // Refusal reasons per pipeline — aggregated, two cards in UI
    // (FIRST_LINE = квалификатор, BERATER = бератер+доведение).
    const refusalPromises = [
      ["firstLine", B2G_PIPELINES.FIRST_LINE] as const,
      ["berater", B2G_PIPELINES.BERATER] as const,
    ].map(async ([key, pipelineId]) => {
      const rows = await getRefusalReasons(pipelineId, fromDate, toDate);
      refusalReasons.set(key, rows);
    });

    // Avg calls per lead — per line (uses same pipelines as SLA; line 2
    // and 3 share BERATER so they'll report the same team number).
    const B2G_LINE_PIPELINES_FOR_CALLS: Record<string, number> = {
      "1": B2G_PIPELINES.FIRST_LINE,
      "2": B2G_PIPELINES.BERATER,
      "3": B2G_PIPELINES.BERATER,
    };
    const acplPromises = Object.entries(B2G_LINE_PIPELINES_FOR_CALLS).map(async ([line, pipelineId]) => {
      const [team, perMgr] = await Promise.all([
        getAvgCallsPerLead(pipelineId, fromDate, toDate),
        getAvgCallsPerLeadByManager(allManagers, pipelineId, fromDate, toDate),
      ]);
      avgCallsPerLead.set(line, team);
      avgCallsPerLeadPerManager.set(line, perMgr);
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
  let slaMinutesB2B: number | null = null;
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
    const [avgBuh1, avgBuh2, avgMed, okkPerMgr] = await Promise.all([
      getOkkAvgScore("b2b", from, to, ["r2_commercial"]),
      getOkkAvgScore("b2b", from, to, ["r2_decisions"]),
      getOkkAvgScore("b2b", from, to, ["r2_med_commercial"]),
      getOkkPerManagerScores("b2b", from, to, ["r2_commercial", "r2_decisions", "r2_med_commercial"]),
    ]);
    okkBuh1 = avgBuh1;
    okkBuh2 = avgBuh2;
    okkMed = avgMed;
    for (const [mgrId, v] of okkPerMgr) okkPerManagerB2B.set(mgrId, v);

    // SLA & avg wait — одна воронка в телефонии, используем Бух Комм.
    // Team-level call metrics across ALL managers (fix for undercount where
    // ex-managers get excluded when keyed by master_managers).
    teamCallMetricsB2B = await getAnalyticsTeamCallMetrics("b2b", from, to).catch(() => null);

    const slaFactsB2B = await getSlaFacts(buhPipelineId, fromDate, toDate);
    // Use business-hours SLA (from-shift) per Excel comparison: Excel R76 shows
    // 52.59 мин which matches sla_first_call_from_shift_seconds, not raw
    // sla_first_call_seconds (which includes evenings/nights, gives ~600 min).
    slaMinutesB2B = slaFactsB2B.slaShiftMinutes ?? slaFactsB2B.slaMinutes;
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

    // Tasks still come from Kommo and are keyed by kommo user id.
    const sectionKommoUserIds = sectionManagers
      .map((m) => m.kommoUserId)
      .filter((id): id is number => id !== null);
    let totalOverdue = 0;
    for (const uid of sectionKommoUserIds) {
      totalOverdue += taskMetricsMap.get(uid)?.overdueTasks ?? 0;
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
        if (!plan && department === "b2b") {
          const B2B_PLAN_DEFAULTS: Record<string, string> = {
            calls_sla_p: "25",
            calls_avgWait_p: "35",
            calls_dialPercent_p: "65",
            okk_buh1_p: "85",
            okk_buh2_p: "85",
            okk_med1_p: "85",
          };
          plan = B2B_PLAN_DEFAULTS[metric.key] ?? plan;
        }
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
            slaMinutes: slaMinutesB2B,
            avgWaitSeconds: avgWaitSecondsB2B,
          });
        } else {
          fact = plan;
        }
      } else if (department === "b2b" && metric.hasPlan && metric.hasFact && plan != null && plan !== "") {
        // Overridable: user's manual value wins over computed SQL fact.
        fact = plan;
      } else if (department === "b2b") {
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
          slaMinutes: slaMinutesB2B,
          avgWaitSeconds: avgWaitSecondsB2B,
        });
      } else if (section.key === "funnel") {
        fact = getFunnelFact(metric.key, funnelCounts, managersOnLineCount, snapshotLeads, line1ManagerCount, safeTermsWonLeads, from, to, safeNewLeadsInPeriod, safeTermAACount, hasSnapshotData, reconstructedActiveDeals, firstLinePipelineId, beraterPipelineId, dateStr);
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
          fact = v !== undefined ? String(v) : null;
        }
        if (metric.key === "roleplay_p") fact = "85";
        if (metric.key === "roleplay_f") {
          const v = roleplayScores.get(section.dbLine);
          fact = v !== undefined ? String(v) : null;
        }
        if (metric.key === "avgWait_p") fact = "30";
        if (metric.key === "sla_f") {
          const sf = slaFacts.get(section.dbLine);
          fact = sf?.slaMinutes != null ? String(sf.slaMinutes) : null;
        }
        if (metric.key === "sla_shift_f") {
          const sf = slaFacts.get(section.dbLine);
          fact = sf?.slaShiftMinutes != null ? String(sf.slaShiftMinutes) : null;
        }
        if (metric.key === "tlt_f") {
          const sf = slaFacts.get(section.dbLine);
          fact = sf?.tltMinutes != null ? String(sf.tltMinutes) : null;
        }
        if (metric.key === "avgDialogPerEmployee" && sectionManagers.length > 0) {
          fact = String(Math.round(summaryCallMetrics.totalMinutes / sectionManagers.length));
        }
        if (metric.key === "avgCallsPerLead") {
          const v = avgCallsPerLead.get(section.dbLine);
          fact = v != null ? String(v) : null;
        }
      }

      let percent: number | null = null;
      if (plan && fact && Number(plan) > 0) {
        if (metric.unit === "%") {
          percent = null;
        } else {
          percent = Math.round((Number(fact) / Number(plan)) * 100);
        }
      }

      // Computed metrics that need access to other metrics in the same section
      if (metric.key === "gutscheinPlanDone") {
        const gutPlan = getPlan(section.dbLine, null, "gutscheinsApproved_p");
        const gutFactStr = getFunnelFact("gutscheinsApproved", funnelCounts, managersOnLineCount, snapshotLeads, line1ManagerCount, safeTermsWonLeads, from, to, safeNewLeadsInPeriod, safeTermAACount, hasSnapshotData, reconstructedActiveDeals, firstLinePipelineId, beraterPipelineId, dateStr);
        const gutFact = Number(gutFactStr ?? 0);
        fact = gutPlan && Number(gutPlan) > 0 ? String(Math.round((gutFact / Number(gutPlan)) * 100)) : "0";
      }

      return { key: metric.key, label: metric.label, plan, fact, percent, isGroupHeader: false, isPlanRow: metric.hasPlan && !metric.hasFact };
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
              // User override wins over SQL-computed fact (revenue rows etc.)
              fact = plan;
            } else if (section.key === "calls") {
              if (metric.key === "calls_managersOnLine_f") fact = "1";
              else if (metric.key === "calls_total_p") fact = "80";
              else if (metric.key === "calls_total_f") fact = String(mgrCallMetrics?.callsTotal ?? 0);
              else if (metric.key === "calls_totalMinutes_p") fact = "160";
              else if (metric.key === "calls_totalMinutes_f") fact = String(mgrCallMetrics?.totalMinutes ?? 0);
              else if (metric.key === "calls_dialPercent_p") fact = "65";
              else if (metric.key === "calls_dialPercent_f") fact = String(mgrCallMetrics?.dialPercent ?? 0);
              else if (metric.key === "calls_avgWait_p") fact = "35";
              else if (metric.key === "calls_avgWait_f") fact = avgWaitSecondsB2B != null ? String(avgWaitSecondsB2B) : null;
              else if (metric.key === "calls_sla_p") fact = "25";
              else if (metric.key === "calls_sla_f") fact = slaMinutesB2B != null ? String(slaMinutesB2B) : null;
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

            let percent: number | null = null;
            if (plan && fact && Number(plan) > 0 && metric.unit !== "%") {
              percent = Math.round((Number(fact) / Number(plan)) * 100);
            }
            return { key: metric.key, plan, fact, percent };
          });

        return { id: mgr.id, name: mgr.name, line: mgr.line, kommoUserId: mgr.kommoUserId, metrics: mgrMetrics };
      });
    } else if (section.key === "funnel") {
      const funnelManagers = managers.filter((m) => m.line === "1" || m.line === "2" || m.line === "3");
      if (funnelManagers.length > 0) {
        const excludePortfolio = new Set([142, 143, 93485479, 95514987]);
        const awaitStatuses = new Set([93860331, 102183931, 102183935, 102183939]);
        const beraterPipeline = beraterPipelineId;
        const firstLinePipeline = firstLinePipelineId;

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
                  // Exclude Неразобранное(83873487) and База(93485479)
                  fact = String(mgrNewLeads.filter((l) => l.status_id !== 83873487 && l.status_id !== 93485479).length);
                  break;
                }
                case "qualLeads": {
                  // Квал = есть буква в Category (CFV 866934). Per user spec 2026-04-24.
                  fact = String(mgrNewLeads.filter((l) => {
                    if (l.status_id === 83873487 || l.status_id === 93485479) return false;
                    return hasCategoryLetter(l);
                  }).length);
                  break;
                }
                case "qualLeadsPercent": {
                  const mgrFiltered = mgrNewLeads.filter((l) => l.status_id !== 83873487 && l.status_id !== 93485479);
                  const mgrQual = mgrFiltered.filter(hasCategoryLetter).length;
                  fact = mgrFiltered.length > 0 ? String(Math.round((mgrQual / mgrFiltered.length) * 100)) : "0";
                  break;
                }
                case "avgPortfolio":
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === firstLinePipeline && !excludePortfolio.has(l.status_id)).length);
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
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && awaitStatuses.has(l.status_id)).length);
                  break;
                case "awaitTermNew": {
                  const { start: ms, end: me } = monthBoundsSec(dateStr);
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && awaitStatuses.has(l.status_id) && l.created_at >= ms && l.created_at <= me).length);
                  break;
                }
                case "gutscheinsApproved": {
                  const mgrGut = uid ? safeWonLeads.filter((l) => l.responsible_user_id === uid && l.pipeline_id === beraterPipeline).length : 0;
                  fact = String(mgrGut);
                  break;
                }
                case "a2": {
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === firstLinePipeline && A2_STATUSES.has(l.status_id)).length);
                  break;
                }
                case "b1": {
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === firstLinePipeline && B1_STATUSES.has(l.status_id)).length);
                  break;
                }
                case "b2plus": {
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === firstLinePipeline && B2_PLUS_STATUSES.has(l.status_id)).length);
                  break;
                }
                case "tasksTotal": {
                  const map = FUNNEL_STATUS_MAP.tasksTotal;
                  const pipe = map?.pipelineIds?.[0] ?? firstLinePipeline;
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === pipe && map && map.statusIds.has(l.status_id)).length);
                  break;
                }
                case "tasksNew": {
                  const map = FUNNEL_STATUS_MAP.tasksTotal;
                  const pipe = map?.pipelineIds?.[0] ?? firstLinePipeline;
                  const { start: ms, end: me } = monthBoundsSec(dateStr);
                  fact = String(mgrActiveLeads.filter((l) =>
                    l.pipeline_id === pipe && map && map.statusIds.has(l.status_id)
                      && l.created_at >= ms && l.created_at <= me,
                  ).length);
                  break;
                }
                case "consultTotal": {
                  const map = FUNNEL_STATUS_MAP.consultTotal;
                  const pipe = map?.pipelineIds?.[0] ?? firstLinePipeline;
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === pipe && map && map.statusIds.has(l.status_id)).length);
                  break;
                }
                case "consultNew": {
                  const map = FUNNEL_STATUS_MAP.consultTotal;
                  const pipe = map?.pipelineIds?.[0] ?? firstLinePipeline;
                  const { start: ms, end: me } = monthBoundsSec(dateStr);
                  fact = String(mgrActiveLeads.filter((l) =>
                    l.pipeline_id === pipe && map && map.statusIds.has(l.status_id)
                      && l.created_at >= ms && l.created_at <= me,
                  ).length);
                  break;
                }
                case "convQualTask": {
                  // tasksTotal / qualLeads × 100. Qual = has category letter.
                  const mgrQual = mgrNewLeads.filter((l) => {
                    if (l.status_id === 83873487 || l.status_id === 93485479) return false;
                    return hasCategoryLetter(l);
                  }).length;
                  const mgrTasks = mgrActiveLeads.filter((l) => l.pipeline_id === firstLinePipeline && FUNNEL_STATUS_MAP.tasksTotal?.statusIds.has(l.status_id)).length;
                  fact = mgrQual > 0 ? String(Math.round((mgrTasks / mgrQual) * 100)) : "0";
                  break;
                }
                case "convTaskConsult": {
                  const mgrTasks = mgrActiveLeads.filter((l) => l.pipeline_id === firstLinePipeline && FUNNEL_STATUS_MAP.tasksTotal?.statusIds.has(l.status_id)).length;
                  const mgrConsult = mgrActiveLeads.filter((l) => l.pipeline_id === firstLinePipeline && FUNNEL_STATUS_MAP.consultTotal?.statusIds.has(l.status_id)).length;
                  fact = mgrTasks > 0 ? String(Math.round((mgrConsult / mgrTasks) * 100)) : "0";
                  break;
                }
                case "convConsultTerm": {
                  const mgrConsult = mgrActiveLeads.filter((l) => l.pipeline_id === firstLinePipeline && FUNNEL_STATUS_MAP.consultTotal?.statusIds.has(l.status_id)).length;
                  fact = mgrConsult > 0 ? String(Math.round((mgrTermsWon.length / mgrConsult) * 100)) : "0";
                  break;
                }
                case "beraterReject": {
                  const mgrRej = uid ? safeLostLeads.filter((l) => l.responsible_user_id === uid && l.pipeline_id === beraterPipeline).length : 0;
                  fact = String(mgrRej);
                  break;
                }
                case "appealsSubmitted": {
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && l.status_id === 93860891).length);
                  break;
                }
                case "revenue": {
                  const mgrRev = mgrTermsWon.reduce((s, l) => s + (l.price || 0), 0);
                  fact = String(mgrRev);
                  break;
                }
                case "termDCCancelled": {
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && l.status_id === 93860875).length);
                  break;
                }
                case "termDCDone": {
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && l.status_id === 93886075).length);
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
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && l.status_id === 93860883).length);
                  break;
                }
                case "termAACount": {
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && l.status_id === 93860879).length);
                  break;
                }
                case "beraterReview": {
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && l.status_id === 93860887).length);
                  break;
                }
                case "delayedStart": {
                  // Matches team-level FUNNEL_STATUS_MAP.delayedStart which
                  // covers BOTH pipelines' "Отложенный старт" statuses.
                  fact = String(mgrActiveLeads.filter((l) =>
                    (l.pipeline_id === beraterPipeline && l.status_id === 95515895)
                    || (l.pipeline_id === firstLinePipeline && l.status_id === 95514987),
                  ).length);
                  break;
                }
                case "appeal": {
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && l.status_id === 93860891).length);
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
        const mgrOverdue = kommoId ? (taskMetricsMap.get(kommoId)?.overdueTasks ?? 0) : 0;
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
                if (metric.key === "sla_f") fact = perMgr.slaMinutes != null ? String(perMgr.slaMinutes) : null;
                else if (metric.key === "sla_shift_f") fact = perMgr.slaShiftMinutes != null ? String(perMgr.slaShiftMinutes) : null;
                else if (metric.key === "tlt_f") fact = perMgr.tltMinutes != null ? String(perMgr.tltMinutes) : null;
              }
            }
            // Per-manager avg calls per lead
            if (metric.key === "avgCallsPerLead") {
              const v = avgCallsPerLeadPerManager.get(section.dbLine)?.get(mgr.id);
              fact = v != null ? String(v) : null;
            }
            let percent: number | null = null;
            if (plan && fact && Number(plan) > 0) {
              if (metric.unit === "%") {
                percent = null;
              } else {
                percent = Math.round((Number(fact) / Number(plan)) * 100);
              }
            }
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
  slaMinutes: number | null;
  avgWaitSeconds: number | null;
}

/** Safe integer percent = Math.round(num/den * 100); 0 when den is 0. */
function pct(num: number, den: number): number {
  if (!den || den <= 0) return 0;
  return Math.round((num / den) * 100);
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

  // ===== Manual plan inputs (Monthly) propagated to Daily/Weekly =====
  const buhKomLeadsPlan = Number(ctx.getPlan("salesBuh", null, "buh_komLeads_p") ?? 0);
  const medKomLeadsPlan = Number(ctx.getPlan("salesMed", null, "med_komLeads_p") ?? 0);
  const buhAvgCheckPlan = Number(ctx.getPlan("salesBuh", null, "buh_avgCheck_p") ?? 0);
  const medAvgCheckPlan = Number(ctx.getPlan("salesMed", null, "med_avgCheck_p") ?? 0);
  // QL2P: жёстко 8% для total и buh (R14/R30); med — редактируемый (R46)
  const BUH_QL2P_DEFAULT = 8;
  // Пользовательский план buh_ql2p_p (если сохранён в daily_plans) имеет
  // приоритет над hardcoded 8%. Позволяет настраивать план без кода.
  const buhQl2pPlan = Number(ctx.getPlan("salesBuh", null, "buh_ql2p_p") ?? BUH_QL2P_DEFAULT);
  const TOTAL_QL2P_DEFAULT = 8;
  const medQl2pPlan = Number(ctx.getPlan("salesMed", null, "med_ql2p_p") ?? 0);

  // Derived plans
  const buhSalesPlan = Math.round(buhKomLeadsPlan * buhQl2pPlan / 100);
  const medSalesPlan = medQl2pPlan > 0 ? Math.round(medKomLeadsPlan * medQl2pPlan / 100) : 0;
  const buhRevenuePlan = buhSalesPlan * buhAvgCheckPlan;
  const medRevenuePlan = medSalesPlan * medAvgCheckPlan;

  // Renewals (отдельная вкладка позже): пока всегда 0. Оставляем хук на будущее.
  const buhRenewalsPlan = 0;
  const buhRenewalsFact = 0;
  const medRenewalsPlan = 0;
  const medRenewalsFact = 0;

  const newRevenuePlan = buhRevenuePlan + medRevenuePlan;
  const newRevenueFact = buh.revenue + med.revenue;
  const revenueTotalPlan = newRevenuePlan + buhRenewalsPlan;
  const revenueTotalFact = newRevenueFact + buhRenewalsFact;
  const buhSalesPlusRenewalsPlan = buhRevenuePlan + buhRenewalsPlan;
  const buhSalesPlusRenewalsFact = buh.revenue + buhRenewalsFact;
  const medSalesPlusRenewalsPlan = medRevenuePlan + medRenewalsPlan;
  const medSalesPlusRenewalsFact = med.revenue + medRenewalsFact;

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
        const buhAC = avgCheck(buh.revenue, buh.salesCount);
        const medAC = avgCheck(med.revenue, med.salesCount);
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
      case "buh_newRevenue_f": return String(buh.revenue);                     // R24
      case "buh_komLeads_f":   return String(buh.qualLeads);                   // R26
      case "buh_sales_p":      return String(buhSalesPlan);                    // R27
      case "buh_sales_f":      return String(buh.salesCount);                  // R28
      case "buh_prepayments":  return String(buh.prepaymentCount);             // R29
      case "buh_ql2p_p":       return String(buhQl2pPlan);                    // R30 (default 8%)
      case "buh_ql2p_f":       return String(pct(buh.salesCount, buh.qualLeads)); // R31
      case "buh_avgCheck_f":   return String(avgCheck(buh.revenue, buh.salesCount)); // R33
      case "buh_planDoneTotal": return planDone(buhSalesPlusRenewalsFact, String(buhSalesPlusRenewalsPlan)); // R34
      case "buh_planDoneNew":   return planDone(buh.revenue, String(buhRevenuePlan));                        // R35
    }
  }

  // ========== 3. ПРОДАЖИ МЕД (R37-R51) ==========
  if (sectionKey === "salesMed") {
    switch (key) {
      case "med_salesPlusRenewals_p": return String(medSalesPlusRenewalsPlan); // R37
      case "med_salesPlusRenewals_f": return String(medSalesPlusRenewalsFact); // R38
      case "med_newRevenue_p": return String(medRevenuePlan);                  // R39
      case "med_newRevenue_f": return String(med.revenue);                     // R40
      case "med_komLeads_f":   return String(med.qualLeads);                   // R42
      case "med_sales_p":      return String(medSalesPlan);                    // R43
      case "med_sales_f":      return String(med.salesCount);                  // R44
      case "med_prepayments":  return String(med.prepaymentCount);             // R45
      case "med_ql2p_f":       return String(pct(med.salesCount, med.qualLeads)); // R47
      case "med_avgCheck_f":   return String(avgCheck(med.revenue, med.salesCount)); // R49
      case "med_planDoneTotal": return planDone(medSalesPlusRenewalsFact, String(medSalesPlusRenewalsPlan)); // R50
      case "med_planDoneNew":   return planDone(med.revenue, String(medRevenuePlan));                        // R51
    }
  }

  // ========== 4. ЗВОНКИ + ОКК (R53-R72) ==========
  if (sectionKey === "calls") {
    switch (key) {
      case "calls_managersOnLine_f": return String(managersOnLineCount);      // R54
      case "calls_total_p":          return String(managersOnLineCount * 80); // R55
      case "calls_total_f":          return String(summaryCallMetrics.callsTotal); // R56
      case "calls_totalMinutes_p":   return String(managersOnLineCount * 160);// R57
      case "calls_totalMinutes_f":   return String(summaryCallMetrics.totalMinutes); // R58
      // R59/R61/R63/R65/R67/R69 plan rows: hasPlan:true → picked up via plan
      // lookup in the outer render loop (see build-response.ts fact = plan path).
      // Defaults (ТЗ): 35 sec wait, 65 % dial, 25 min SLA, 85 % OKK.
      case "calls_avgWait_f":        return ctx.avgWaitSeconds != null ? String(ctx.avgWaitSeconds) : null; // R60
      case "calls_dialPercent_f":    return String(summaryCallMetrics.dialPercent); // R62
      case "calls_sla_f":            return ctx.slaMinutes != null ? String(ctx.slaMinutes) : null; // R64
      case "okk_buh1_f":             return ctx.okkBuh1 != null ? String(ctx.okkBuh1) : null; // R66
      case "okk_buh2_f":             return ctx.okkBuh2 != null ? String(ctx.okkBuh2) : null; // R68
      case "okk_med1_f":             return ctx.okkMed != null ? String(ctx.okkMed) : null; // R70
      case "okk_avg_p": {                                                     // R71 = AVG(plans)
        const p1 = Number(ctx.getPlan("calls", null, "okk_buh1_p") ?? 85);
        const p2 = Number(ctx.getPlan("calls", null, "okk_buh2_p") ?? 85);
        const p3 = Number(ctx.getPlan("calls", null, "okk_med1_p") ?? 85);
        return String(Math.round((p1 + p2 + p3) / 3));
      }
      case "okk_avg_f": {                                                     // R72
        const vals = [ctx.okkBuh1, ctx.okkBuh2, ctx.okkMed].filter((v): v is number => v != null);
        if (!vals.length) return null;
        return String(Math.round(vals.reduce((s, v) => s + v, 0) / vals.length));
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
  firstLinePipeline?: number,
  beraterPipeline?: number,
  dateStr?: string,
): string | null {
  const flPipeline = firstLinePipeline ?? 10935879;
  const brPipeline = beraterPipeline ?? 12154099;
  // Parse month from dateStr for month-boundary calculations (avoids UTC/TZ drift)
  const [dsYear, dsMonth] = (dateStr ?? "2026-01-01").split("-").map(Number);
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
      // All leads from first line created in period, excluding Неразобранное(83873487) and База(93485479)
      const excludeFromTotal = new Set([83873487, 93485479]);
      const allNew = (newLeadsInPeriod || []).filter((l) => !l.is_deleted && !excludeFromTotal.has(l.status_id));
      return String(allNew.length);
    }
    case "qualLeads": {
      // Квал = есть буква в Category (CFV 866934). Per user spec 2026-04-24.
      // Не-квал = category NULL/empty — лид закрыт как "Неквал лид" или не оценен.
      const excludeS = new Set([83873487, 93485479]);
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
      const excludeStatuses = new Set([142, 143, 93485479, 95514987]);
      const pipelineId = flPipeline;
      const portfolioLeads = (snapshotLeads || []).filter(
        (l) => l.pipeline_id === pipelineId && !l.is_deleted && !excludeStatuses.has(l.status_id)
      );
      const divisor = line1ManagerCount || managersOnLine || 1;
      return String(Math.round(portfolioLeads.length / divisor));
    }
    case "awaitTermTotal": {
      const awaitStatuses = new Set([93860331, 102183931, 102183935, 102183939]);
      const beraterPipeline = brPipeline;
      const awaiting = (snapshotLeads || []).filter(
        (l) => l.pipeline_id === beraterPipeline && !l.is_deleted && !l.closed_at && awaitStatuses.has(l.status_id)
      );
      return String(awaiting.length);
    }
    case "awaitTermNew": {
      // Awaiting term + created in current month
      const awaitStatusesNew = new Set([93860331, 102183931, 102183935, 102183939]);
      const beraterPipelineNew = brPipeline;
      const { start: mStartNew, end: mEndNew } = monthBoundsSec(dateStr ?? "2026-01-01");
      const awaitingNew = (snapshotLeads || []).filter(
        (l) =>
          l.pipeline_id === beraterPipelineNew &&
          !l.is_deleted &&
          !l.closed_at &&
          awaitStatusesNew.has(l.status_id) &&
          l.created_at >= mStartNew &&
          l.created_at <= mEndNew
      );
      return String(awaitingNew.length);
    }
    case "qualLeadsPercent": {
      const exS = new Set([83873487, 93485479]);
      const allNewP = (newLeadsInPeriod || []).filter((l) => !l.is_deleted && !exS.has(l.status_id));
      const qualP = allNewP.filter(hasCategoryLetter).length;
      return allNewP.length > 0 ? String(Math.round((qualP / allNewP.length) * 100)) : "0";
    }
    // ─── Berater pipeline snapshot metrics ───
    case "termDCCancelled": {
      // Термин ДЦ отменен/перенесен: status 93860875 in berater pipeline 12154099
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === brPipeline && !l.is_deleted && !l.closed_at && l.status_id === 93860875
      ).length);
    }
    case "termDCDone": {
      // Термин ДЦ состоялся: status 93886075 in berater pipeline
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === brPipeline && !l.is_deleted && !l.closed_at && l.status_id === 93886075
      ).length);
    }
    case "termAATransferred": {
      // Переведены на термин АА: counted via Events API (status changes)
      return String(termAATransferredCount ?? 0);
    }
    case "termAACancelled": {
      // Термин АА отменен/перенесен: status 93860883 in berater pipeline
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === brPipeline && !l.is_deleted && !l.closed_at && l.status_id === 93860883
      ).length);
    }
    case "termAACount": {
      // Термин АА (на этапе): statuses 102183943 + 102183947 in berater pipeline
      const aaStatuses = new Set([102183943, 102183947]);
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === brPipeline && !l.is_deleted && !l.closed_at && aaStatuses.has(l.status_id)
      ).length);
    }
    case "beraterReview": {
      // На рассмотрении бератера: status 93860887
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === brPipeline && !l.is_deleted && !l.closed_at && l.status_id === 93860887
      ).length);
    }
    case "delayedStart": {
      // Отложенный старт: status 95515895 in berater pipeline
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === brPipeline && !l.is_deleted && !l.closed_at && l.status_id === 95515895
      ).length);
    }
    case "appeal": {
      // Апелляция: status 93860891
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === brPipeline && !l.is_deleted && !l.closed_at && l.status_id === 93860891
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
