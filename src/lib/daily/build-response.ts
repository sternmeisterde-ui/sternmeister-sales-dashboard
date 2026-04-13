// Shared logic for building Daily API responses
// Used by both /api/daily and /api/daily/range routes
import { cached } from "@/lib/kommo/cache";
import { getCallNotes, getLeads, getTasks, getStatusChangeCount } from "@/lib/kommo/client";
import {
  aggregateCallMetrics,
  aggregateLeadMetrics,
  aggregateLeadFunnelMetrics,
  aggregateTaskMetrics,
  sumCallMetrics,
  type UserCallMetrics,
} from "@/lib/kommo/metrics";
import { getManagersWithKommo, getPlans, getScheduleForDate, getSnapshot, saveSnapshot } from "@/lib/db/queries-daily";
import { getDailySections, type SectionDef } from "@/lib/daily/metrics-config";
import { getPipelineIds, getActiveStatusIds, B2G_PIPELINES, B2B_PIPELINES, COMMERCIAL_STATUSES, B2B_PREPAYMENT_STATUSES, B2B_QUALIFIED_STATUSES } from "@/lib/kommo/pipeline-config";
import type { LeadFunnelCounts } from "@/lib/kommo/metrics";
import type { KommoLead, KommoTask, KommoCallNote } from "@/lib/kommo/types";

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

function getMaxPages(period: string): { leadsPages: number; closedPages: number; callPages: number } {
  switch (period) {
    case "day":
      return { leadsPages: 10, closedPages: 3, callPages: 10 };
    case "week":
      return { leadsPages: 10, closedPages: 5, callPages: 15 };
    case "month":
      return { leadsPages: 10, closedPages: 10, callPages: 20 };
    case "year":
      return { leadsPages: 10, closedPages: 20, callPages: 30 };
    default:
      return { leadsPages: 10, closedPages: 5, callPages: 10 };
  }
}

function buildUserFacts(
  callMetrics: UserCallMetrics | undefined,
  taskOverdue: number,
  _section: SectionDef
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
const RESPONSE_CACHE_TTL = 5 * 60 * 1000;

/** Track Kommo API failures for diagnostics */
let _lastKommoError: { message: string; at: string } | null = null;
export function getLastKommoError() { return _lastKommoError; }

export async function buildDailyResponseCached(department: string, period: string, dateStr: string) {
  const today = getBusinessToday();
  const isPast = dateStr < today;

  // Past dates: load stored snapshot from DB (fast, no Kommo calls)
  if (isPast) {
    try {
      const stored = await getSnapshot(dateStr, department, period);
      if (stored) return stored;
    } catch (e) {
      console.warn(`[Daily] Snapshot load failed for ${dateStr}:`, e);
    }
    // No stored snapshot — compute with historical flag (skip non-date-filtered calls)
    const cacheKey = `daily-response:${department}:${period}:${dateStr}:hist`;
    return cached(cacheKey, RESPONSE_CACHE_TTL, () => buildDailyResponse(department, period, dateStr, true));
  }

  // Compute fresh from Kommo (with in-memory TTL cache)
  const cacheKey = `daily-response:${department}:${period}:${dateStr}`;
  const result = await cached(cacheKey, RESPONSE_CACHE_TTL, () => buildDailyResponse(department, period, dateStr, false));

  // Save snapshot for today (accurate point-in-time data for future historical queries)
  saveSnapshot(dateStr, department, period, result).catch((e) => {
    console.error(`[Daily] Snapshot save failed for ${dateStr}:`, e);
  });

  return result;
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
  const { leadsPages, closedPages, callPages } = getMaxPages(period);

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

  const isManagerOnLine = (managerId: string): boolean => {
    if (scheduleMap === null) return true;
    const entry = scheduleMap.get(managerId);
    if (entry === undefined) return true;
    return entry;
  };

  const managers = period === "day"
    ? allManagers.filter((m) => isManagerOnLine(m.id))
    : allManagers;

  const onLineManagerIds = allManagers
    .filter((m) => isManagerOnLine(m.id))
    .map((m) => m.id);

  const kommoUserIds = managers
    .map((m) => m.kommoUserId)
    .filter((id): id is number => id !== null);

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

  const [snapshotActiveLeads, tasks, wonLeads, lostLeads, callNotes, termsWonLeads, newLeadsInPeriod, termAACount, closedAfterDate] = await Promise.all([
    // Snapshot leads: always fetch (cached across all days in range, one Kommo call)
    getLeads(allPipelineIds, allActiveStatusIds, leadsPages).catch(trackError("snapshot leads")),
    isHistorical ? Promise.resolve([] as KommoTask[]) : getTasks(false).catch(trackError("tasks")),
    getLeads(allPipelineIds, [142], closedPages, closedDateFilter).catch(trackError("won leads")),
    getLeads(allPipelineIds, [143], closedPages, closedDateFilter).catch(trackError("lost leads")),
    getCallNotes(from, to, kommoUserIds, callPages).catch(trackError("call notes")),
    getLeads([firstLinePipelineId], [142], closedPages, termsDateFilter).catch(trackError("terms won")),
    getLeads([firstLinePipelineId], undefined, leadsPages, createdDateFilter).catch(trackError("new leads")),
    getStatusChangeCount(from, to, beraterPipelineId, [102183943, 102183947]).catch(trackError("term AA events")),
    // Historical: fetch leads closed AFTER this date (they were active on this date)
    closedAfterDateFilter
      ? getLeads(allPipelineIds, [142, 143], 20, closedAfterDateFilter).catch(trackError("closed after date"))
      : Promise.resolve([] as KommoLead[]),
  ]) as [
    KommoLead[] | undefined, KommoTask[] | undefined, KommoLead[] | undefined,
    KommoLead[] | undefined, KommoCallNote[] | undefined, KommoLead[] | undefined,
    KommoLead[] | undefined, number | undefined, KommoLead[] | undefined
  ];

  // Default to empty on API failure — but now we track it
  const safeSnapshotActiveLeads = snapshotActiveLeads ?? [];
  const safeTasks = tasks ?? [];
  const safeWonLeads = wonLeads ?? [];
  const safeLostLeads = lostLeads ?? [];
  const safeCallNotes = callNotes ?? [];
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
    `[Daily API] ${department}/${period}/${dateStr}: allLeads=${safeSnapshotActiveLeads.length} active=${activeOnly.length} byPipeline=${JSON.stringify(byPipeline)} won=${safeWonLeads.length} lost=${safeLostLeads.length} calls=${safeCallNotes.length} terms=${safeTermsWonLeads.length} managers=${managers.length} line1=${managers.filter((m) => m.line === "1").length}`
  );

  const flowActiveLeads = safeSnapshotActiveLeads.filter(
    (lead) => lead.updated_at >= from && lead.updated_at <= to
  );

  const snapshotLeads = [...safeSnapshotActiveLeads, ...safeWonLeads, ...safeLostLeads];
  const flowLeads = [...flowActiveLeads, ...safeWonLeads, ...safeLostLeads];

  const callMetricsMap = aggregateCallMetrics(safeCallNotes);
  const leadMetricsMap = aggregateLeadMetrics(snapshotLeads, from, to);
  const funnelCounts = aggregateLeadFunnelMetrics(snapshotLeads, flowLeads, from, to, department);
  const taskMetricsMap = aggregateTaskMetrics(safeTasks);

  const planLookup = new Map<string, string>();
  for (const p of plans) {
    const key = `${p.line}:${p.userId || "null"}:${p.metricKey}`;
    planLookup.set(key, p.planValue);
  }

  const getPlan = (line: string, userId: string | null, metricKey: string): string | null => {
    let val: string | undefined;
    if (userId) {
      val = planLookup.get(`${line}:${userId}:${metricKey}`);
    }
    if (val === undefined) {
      val = planLookup.get(`${line}:null:${metricKey}`);
    }
    if (val === undefined) return null;
    if (planDivisor !== 1) {
      const num = Number(val);
      if (!Number.isNaN(num)) {
        return String(Math.round(num / planDivisor));
      }
    }
    return val;
  };

  const managersOnLineCount = managers.length;
  const line1ManagerCount = managers.filter((m) => m.line === "1").length;

  const activeSections = getDailySections(department);

  // B2B-specific: split leads by pipeline for Бух/Мед sections
  const buhPipelineId = B2B_PIPELINES.COMMERCIAL;
  const medPipelineId = B2B_PIPELINES.MEDICAL_COMM;
  const buhWonLeads = department === "b2b" ? safeWonLeads.filter((l) => l.pipeline_id === buhPipelineId) : [];
  const medWonLeads = department === "b2b" ? safeWonLeads.filter((l) => l.pipeline_id === medPipelineId) : [];
  const buhNewLeads = department === "b2b" ? safeNewLeadsInPeriod.filter((l) => l.pipeline_id === buhPipelineId && !l.is_deleted) : [];
  const medNewLeads = department === "b2b" ? safeNewLeadsInPeriod.filter((l) => l.pipeline_id === medPipelineId && !l.is_deleted) : [];
  const buhActiveLeads = department === "b2b" ? safeSnapshotActiveLeads.filter((l) => l.pipeline_id === buhPipelineId && !l.closed_at && !l.is_deleted) : [];
  const medActiveLeads = department === "b2b" ? safeSnapshotActiveLeads.filter((l) => l.pipeline_id === medPipelineId && !l.closed_at && !l.is_deleted) : [];
  const buhPrepayments = department === "b2b" ? buhActiveLeads.filter((l) => B2B_PREPAYMENT_STATUSES.has(l.status_id)) : [];
  const medPrepayments = department === "b2b" ? medActiveLeads.filter((l) => B2B_PREPAYMENT_STATUSES.has(l.status_id)) : [];

  const sections = activeSections.map((section) => {
    const sectionManagers = department === "b2b"
      ? managers // B2B: all managers participate in all sections
      : managers.filter((m) => section.key === "funnel" || m.line === section.dbLine);

    const sectionKommoUserIds = sectionManagers
      .map((m) => m.kommoUserId)
      .filter((id): id is number => id !== null);

    const sectionCallMetrics = sectionKommoUserIds
      .map((id) => callMetricsMap.get(id))
      .filter((m): m is UserCallMetrics => m !== undefined);

    const summaryCallMetrics = sumCallMetrics(sectionCallMetrics);

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

      if (department === "b2b") {
        // Plan-row metrics (key ends with _p): display plan target as the fact value
        if (metric.hasPlan && !metric.hasFact) {
          fact = plan;
        } else {
          fact = getB2BFact(metric.key, section.key, {
            summaryCallMetrics, managersOnLineCount, sectionManagers,
            buhWonLeads, medWonLeads, buhNewLeads, medNewLeads,
            buhActiveLeads, medActiveLeads, buhPrepayments, medPrepayments,
            allNewLeads: safeNewLeadsInPeriod, allWonLeads: safeWonLeads,
            getPlan, sectionDbLine: section.dbLine,
          });
        }
      } else if (section.key === "funnel") {
        fact = getFunnelFact(metric.key, funnelCounts, managersOnLineCount, snapshotLeads, line1ManagerCount, safeTermsWonLeads, from, to, safeNewLeadsInPeriod, safeTermAACount, hasSnapshotData, reconstructedActiveDeals, firstLinePipelineId, beraterPipelineId, dateStr);
      } else {
        // For per-manager sections: overdueTasks is snapshot-only (no date filter)
        if (metric.key === "overdueTasks" && !hasSnapshotData) {
          fact = null;
        } else {
          const facts = buildUserFacts(summaryCallMetrics, totalOverdue, section);
          fact = facts[metric.key] ?? null;
        }
        if (metric.key === "staffCount") {
          fact = String(sectionManagers.length);
        }
        if (metric.key === "avgDialogPerEmployee" && sectionManagers.length > 0) {
          fact = String(Math.round(summaryCallMetrics.totalMinutes / sectionManagers.length));
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

      return { key: metric.key, label: metric.label, plan, fact, percent, isGroupHeader: false, isPlanRow: metric.hasPlan && !metric.hasFact };
    });

    let managerData: Array<{
      id: string;
      name: string;
      kommoUserId: number | null;
      metrics: Array<{ key: string; plan: string | null; fact: string | null; percent: number | null }>;
    }> = [];

    if (department === "b2b" && section.perManager) {
      // B2B per-manager: sales (Бух/Мед) and calls
      managerData = sectionManagers.map((mgr) => {
        const uid = mgr.kommoUserId;
        const mgrCallMetrics = uid ? callMetricsMap.get(uid) : undefined;

        const mgrMetrics = section.metrics
          .filter((m) => !m.isGroupHeader)
          .map((metric) => {
            const plan = getPlan(section.dbLine, mgr.id, metric.key);
            let fact: string | null = null;

            // Plan-row metrics: show plan value as fact
            if (metric.hasPlan && !metric.hasFact) {
              fact = plan;
            } else if (section.key === "b2bCalls") {
              // Call metrics per manager (fact rows)
              if (metric.key === "calls_managersOnLine_f") fact = "1";
              else if (metric.key === "calls_total_f") fact = String(mgrCallMetrics?.callsTotal ?? 0);
              else if (metric.key === "calls_totalMinutes_f") fact = String(mgrCallMetrics?.totalMinutes ?? 0);
              else if (metric.key === "calls_dialPercent_f") fact = String(mgrCallMetrics?.dialPercent ?? 0);
            } else {
              // Sales per manager (Бух or Мед) — fact rows only
              const pipeId = section.key === "salesBuh" ? buhPipelineId : medPipelineId;
              const mgrWon = uid ? safeWonLeads.filter((l) => l.responsible_user_id === uid && l.pipeline_id === pipeId) : [];
              const mgrNew = uid ? safeNewLeadsInPeriod.filter((l) => l.responsible_user_id === uid && l.pipeline_id === pipeId && !l.is_deleted) : [];
              const mgrActive = uid ? safeSnapshotActiveLeads.filter((l) => l.responsible_user_id === uid && l.pipeline_id === pipeId && !l.closed_at && !l.is_deleted) : [];
              const mgrRevenue = mgrWon.reduce((s, l) => s + (l.price || 0), 0);

              const prefix = section.key === "salesBuh" ? "buh" : "med";
              switch (metric.key) {
                case `${prefix}_salesPlusRenewals_f`:
                case `${prefix}_revenue_f`:
                  fact = String(mgrRevenue);
                  break;
                case `${prefix}_komLeads_f`:
                  fact = String(mgrActive.filter((l) => B2B_QUALIFIED_STATUSES.has(l.status_id)).length);
                  break;
                case `${prefix}_totalLeads_f`:
                  fact = String(mgrNew.length);
                  break;
                case `${prefix}_sales_f`:
                  fact = String(mgrWon.length);
                  break;
                case `${prefix}_prepayments`:
                  fact = String(mgrActive.filter((l) => B2B_PREPAYMENT_STATUSES.has(l.status_id)).length);
                  break;
                case `${prefix}_ql2p_f`: {
                  const qualL = mgrActive.filter((l) => B2B_QUALIFIED_STATUSES.has(l.status_id)).length;
                  fact = qualL > 0 ? String(Math.round((mgrWon.length / qualL) * 100)) : "0";
                  break;
                }
                case `${prefix}_l2p_f`:
                case "buh_l2p_f": {
                  fact = mgrNew.length > 0 ? String(Math.round((mgrWon.length / mgrNew.length) * 100)) : "0";
                  break;
                }
                case `${prefix}_avgCheck_f`:
                  fact = mgrWon.length > 0 ? String(Math.round(mgrRevenue / mgrWon.length)) : "0";
                  break;
              }
            }

            let percent: number | null = null;
            if (plan && fact && Number(plan) > 0 && metric.unit !== "%") {
              percent = Math.round((Number(fact) / Number(plan)) * 100);
            }
            return { key: metric.key, plan, fact, percent };
          });

        return { id: mgr.id, name: mgr.name, kommoUserId: mgr.kommoUserId, metrics: mgrMetrics };
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
                  const nqE = new Set([744486, 744876, 747530, 747532, 747534, 747536]);
                  fact = String(mgrNewLeads.filter((l) => {
                    if (l.status_id === 83873487 || l.status_id === 93485479) return false;
                    const cf = (l.custom_fields_values || []).find((f: { field_id: number }) => f.field_id === 879824);
                    if (!cf) return true;
                    return !nqE.has(cf.values?.[0]?.enum_id ?? -1);
                  }).length);
                  break;
                }
                case "qualLeadsPercent": {
                  const nqE2 = new Set([744486, 744876, 747530, 747532, 747534, 747536]);
                  const mgrFiltered = mgrNewLeads.filter((l) => l.status_id !== 83873487 && l.status_id !== 93485479);
                  const mgrQual = mgrFiltered.filter((l) => {
                    const cf = (l.custom_fields_values || []).find((f: { field_id: number }) => f.field_id === 879824);
                    if (!cf) return true;
                    return !nqE2.has(cf.values?.[0]?.enum_id ?? -1);
                  }).length;
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
                  // "New" = created in current month (use dateStr to avoid UTC/TZ drift)
                  const [tY, tM] = dateStr.split("-").map(Number);
                  const mStart = new Date(Date.UTC(tY, tM - 1, 1)).getTime() / 1000;
                  const mEnd = new Date(Date.UTC(tY, tM, 0, 23, 59, 59)).getTime() / 1000;
                  fact = String(mgrTermsWon.filter((l) => l.created_at >= mStart && l.created_at <= mEnd).length);
                  break;
                }
                case "awaitTermTotal":
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && awaitStatuses.has(l.status_id)).length);
                  break;
                case "awaitTermNew": {
                  const [aY, aM] = dateStr.split("-").map(Number);
                  const ms = new Date(Date.UTC(aY, aM - 1, 1)).getTime() / 1000;
                  const me = new Date(Date.UTC(aY, aM, 0, 23, 59, 59)).getTime() / 1000;
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && awaitStatuses.has(l.status_id) && l.created_at >= ms && l.created_at <= me).length);
                  break;
                }
                case "gutscheinsApproved": {
                  const mgrGut = uid ? safeWonLeads.filter((l) => l.responsible_user_id === uid && l.pipeline_id === beraterPipeline).length : 0;
                  fact = String(mgrGut);
                  break;
                }
              }
              return { key: metric.key, plan: null as string | null, fact, percent: null as number | null };
            });

          return { id: mgr.id, name: mgr.name, kommoUserId: mgr.kommoUserId, metrics: mgrMetrics };
        });
      }
    }

    if (section.perManager && department !== "b2b") {
      managerData = sectionManagers.map((mgr) => {
        const kommoId = mgr.kommoUserId;
        const mgrCallMetrics = kommoId ? callMetricsMap.get(kommoId) : undefined;
        const mgrOverdue = kommoId ? (taskMetricsMap.get(kommoId)?.overdueTasks ?? 0) : 0;
        const mgrFacts = buildUserFacts(mgrCallMetrics, mgrOverdue, section);

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

        return { id: mgr.id, name: mgr.name, kommoUserId: mgr.kommoUserId, metrics: mgrMetrics };
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
          .filter((m) => m.line !== null)
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
  };
}

// ==================== B2B FACT RESOLVER ====================

interface B2BFactContext {
  summaryCallMetrics: UserCallMetrics;
  managersOnLineCount: number;
  sectionManagers: Array<{ id: string; kommoUserId: number | null; line: string | null }>;
  buhWonLeads: KommoLead[];
  medWonLeads: KommoLead[];
  buhNewLeads: KommoLead[];
  medNewLeads: KommoLead[];
  buhActiveLeads: KommoLead[];
  medActiveLeads: KommoLead[];
  buhPrepayments: KommoLead[];
  medPrepayments: KommoLead[];
  allNewLeads: KommoLead[];
  allWonLeads: KommoLead[];
  getPlan: (line: string, userId: string | null, metricKey: string) => string | null;
  sectionDbLine: string;
}

function getB2BFact(key: string, sectionKey: string, ctx: B2BFactContext): string | null {
  const { summaryCallMetrics, managersOnLineCount } = ctx;

  // === Продажи ТОТАЛ ===
  if (sectionKey === "salesTotal") {
    const totalRevenue = ctx.buhWonLeads.reduce((s, l) => s + (l.price || 0), 0) +
      ctx.medWonLeads.reduce((s, l) => s + (l.price || 0), 0);
    if (key === "st_salesPlusRenewals_f") return String(totalRevenue);
  }

  // === Продажи Бух ===
  if (sectionKey === "salesBuh") {
    const won = ctx.buhWonLeads;
    const newLeads = ctx.buhNewLeads;
    const active = ctx.buhActiveLeads;
    const revenue = won.reduce((s, l) => s + (l.price || 0), 0);
    const qualLeads = active.filter((l) => B2B_QUALIFIED_STATUSES.has(l.status_id)).length;

    switch (key) {
      case "buh_salesPlusRenewals_f": return String(revenue);
      case "buh_revenue_f": return String(revenue);
      case "buh_komLeads_f": return String(qualLeads);
      case "buh_totalLeads_f": return String(newLeads.length);
      case "buh_sales_f": return String(won.length);
      case "buh_prepayments": return String(ctx.buhPrepayments.length);
      case "buh_ql2p_f": return qualLeads > 0 ? String(Math.round((won.length / qualLeads) * 100)) : "0";
      case "buh_l2p_f": return newLeads.length > 0 ? String(Math.round((won.length / newLeads.length) * 100)) : "0";
      case "buh_avgCheck_f": return won.length > 0 ? String(Math.round(revenue / won.length)) : "0";
      case "buh_planDone": {
        const planVal = ctx.getPlan(ctx.sectionDbLine, null, "buh_revenue_p");
        return planVal && Number(planVal) > 0 ? String(Math.round((revenue / Number(planVal)) * 100)) : "0";
      }
    }
  }

  // === Продажи Мед ===
  if (sectionKey === "salesMed") {
    const won = ctx.medWonLeads;
    const active = ctx.medActiveLeads;
    const revenue = won.reduce((s, l) => s + (l.price || 0), 0);
    const qualLeads = active.filter((l) => B2B_QUALIFIED_STATUSES.has(l.status_id)).length;
    const newLeads = ctx.medNewLeads;

    switch (key) {
      case "med_salesPlusRenewals_f": return String(revenue);
      case "med_revenue_f": return String(revenue);
      case "med_komLeads_f": return String(qualLeads);
      case "med_sales_f": return String(won.length);
      case "med_prepayments": return String(ctx.medPrepayments.length);
      case "med_ql2p_f": return qualLeads > 0 ? String(Math.round((won.length / qualLeads) * 100)) : "0";
      case "med_avgCheck_f": return won.length > 0 ? String(Math.round(revenue / won.length)) : "0";
      case "med_planDone": {
        const planVal = ctx.getPlan(ctx.sectionDbLine, null, "med_revenue_p");
        return planVal && Number(planVal) > 0 ? String(Math.round((revenue / Number(planVal)) * 100)) : "0";
      }
    }
  }

  // === Звонки (fact rows only, _f suffix) ===
  if (sectionKey === "b2bCalls") {
    switch (key) {
      case "calls_managersOnLine_f": return String(managersOnLineCount);
      case "calls_total_f": return String(summaryCallMetrics.callsTotal);
      case "calls_totalMinutes_f": return String(summaryCallMetrics.totalMinutes);
      case "calls_dialPercent_f": return String(summaryCallMetrics.dialPercent);
    }
  }

  // === Total UE (computed from Бух + Мед) ===
  if (sectionKey === "totalUE") {
    const totalRevenue = ctx.buhWonLeads.reduce((s, l) => s + (l.price || 0), 0) +
      ctx.medWonLeads.reduce((s, l) => s + (l.price || 0), 0);
    const totalSales = ctx.buhWonLeads.length + ctx.medWonLeads.length;
    const totalNewLeads = ctx.allNewLeads.filter((l) => !l.is_deleted).length;
    const totalQualLeads = [...ctx.buhActiveLeads, ...ctx.medActiveLeads].filter((l) => B2B_QUALIFIED_STATUSES.has(l.status_id)).length;

    switch (key) {
      case "ue_ltv": return null; // Manual / formula — needs plan input
      case "ue_cac_f": {
        const budget = Number(ctx.getPlan("marketing", null, "mkt_budget_p") ?? 0);
        return totalSales > 0 ? String(Math.round(budget / totalSales)) : "0";
      }
      case "ue_leadsTotal": return String(totalNewLeads);
      case "ue_leadsQual": return String(totalQualLeads);
      case "ue_revenue_f": return String(totalRevenue);
      case "ue_conversion_f": return totalNewLeads > 0 ? String(Math.round((totalSales / totalNewLeads) * 1000) / 10) : "0";
      case "ue_ltv_cac": {
        const cac = ctx.getPlan(ctx.sectionDbLine, null, "ue_cac_p");
        const ltv = ctx.getPlan(ctx.sectionDbLine, null, "ue_ltv");
        if (cac && ltv && Number(cac) > 0) return String(Math.round((Number(ltv) / Number(cac)) * 10) / 10);
        return null;
      }
    }
  }

  // === Marketing (computed formulas) ===
  if (sectionKey === "marketing") {
    const budget = Number(ctx.getPlan(ctx.sectionDbLine, null, "mkt_budget_p") ?? 0);
    const totalNewLeads = ctx.allNewLeads.filter((l) => !l.is_deleted).length;
    const totalSales = ctx.allWonLeads.length;

    switch (key) {
      case "mkt_leads": return String(totalNewLeads);
      case "mkt_cpl": return totalNewLeads > 0 ? String(Math.round(budget / totalNewLeads)) : "0";
      case "mkt_cac": return totalSales > 0 ? String(Math.round(budget / totalSales)) : "0";
      case "mkt_budget_f": return null; // manual input
      case "mkt_nonQualLeads_f": {
        // Non-qualified = total - qualified
        const qualCount = [...ctx.buhActiveLeads, ...ctx.medActiveLeads].filter((l) => B2B_QUALIFIED_STATUSES.has(l.status_id)).length;
        return String(Math.max(0, totalNewLeads - qualCount));
      }
    }
  }

  // === Marketing (computed formulas) ===
  if (sectionKey === "marketing") {
    const budget = Number(ctx.getPlan(ctx.sectionDbLine, null, "mkt_budget") ?? 0);
    const totalNewLeads = ctx.allNewLeads.filter((l) => !l.is_deleted).length;
    const totalSales = ctx.allWonLeads.length;

    switch (key) {
      case "mkt_leads": return String(totalNewLeads);
      case "mkt_cpl": return totalNewLeads > 0 ? String(Math.round(budget / totalNewLeads)) : "0";
      case "mkt_cac": return totalSales > 0 ? String(Math.round(budget / totalSales)) : "0";
    }
  }

  // === ОКК (placeholder — needs R2 DB query, will show plan only for now) ===

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
      // "New" = leads created in current month (use dateStr to avoid UTC/TZ drift)
      const monthStart = new Date(Date.UTC(dsYear, dsMonth - 1, 1)).getTime() / 1000;
      const monthEnd = new Date(Date.UTC(dsYear, dsMonth, 0, 23, 59, 59)).getTime() / 1000;
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
      // Qual = totalLeads minus leads with non-qual "Причина закрытия Госники" (field 879824)
      // Non-qual = field has one of: Неправильный номер, Неквал лид/Доход/Образование/Возраст/Язык
      const nonQualEnums = new Set([744486, 744876, 747530, 747532, 747534, 747536]);
      const excludeS = new Set([83873487, 93485479]);
      const qualCount = (newLeadsInPeriod || []).filter((l) => {
        if (l.is_deleted || excludeS.has(l.status_id)) return false;
        const cf = (l.custom_fields_values || []).find((f: { field_id: number }) => f.field_id === 879824);
        if (!cf) return true; // no field = qual
        return !nonQualEnums.has(cf.values?.[0]?.enum_id ?? -1);
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
      const mStartNew = new Date(Date.UTC(dsYear, dsMonth - 1, 1)).getTime() / 1000;
      const mEndNew = new Date(Date.UTC(dsYear, dsMonth, 0, 23, 59, 59)).getTime() / 1000;
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
      const nonQualE = new Set([744486, 744876, 747530, 747532, 747534, 747536]);
      const exS = new Set([83873487, 93485479]);
      const allNewP = (newLeadsInPeriod || []).filter((l) => !l.is_deleted && !exS.has(l.status_id));
      const qualP = allNewP.filter((l) => {
        const cf = (l.custom_fields_values || []).find((f: { field_id: number }) => f.field_id === 879824);
        if (!cf) return true;
        return !nonQualE.has(cf.values?.[0]?.enum_id ?? -1);
      }).length;
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
