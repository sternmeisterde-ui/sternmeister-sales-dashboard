// GET /api/dashboard?department=b2g
// Returns aggregated Kommo CRM metrics for the Dashboard tab:
//   - todayMetrics: summary KPI cards
//   - perManager: per-manager breakdown
//   - trend: last 7 days call/lead trend
//   - funnel: pipeline funnel counts
//   - missedBreakdown: detailed missed calls info
//   - pipelineBreakdown: per-pipeline lead distribution (for B2G: Бух Гос + Бух Бератер)

import { NextRequest, NextResponse } from "next/server";
import { getTasks } from "@/lib/kommo/client";
import { getAnalyticsLeads } from "@/lib/daily/analytics-leads";
import {
  aggregateLeadFunnelMetrics,
  aggregateTaskMetrics,
  sumCallMetrics,
  type UserCallMetrics,
} from "@/lib/kommo/metrics";
import { getManagersWithKommo } from "@/lib/db/queries-daily";
import {
  getPipelineIds,
  getActiveStatusIds,
  B2G_PIPELINES,
  B2B_PIPELINES,
  COMMERCIAL_STATUSES,
} from "@/lib/kommo/pipeline-config";
import type { KommoLead } from "@/lib/kommo/types";
import {
  getAnalyticsCallMetricsByMaster,
  getAnalyticsDailyTrend,
} from "@/lib/daily/analytics-calls";

import { cached } from "@/lib/kommo/cache";

// ==================== Helpers ====================

function getDateRange(period: string, dateStr: string): { from: number; to: number } {
  const base = new Date(dateStr + "T00:00:00Z");

  switch (period) {
    case "week": {
      const day = base.getUTCDay();
      const diff = day === 0 ? -6 : 1 - day;
      const monday = new Date(base);
      monday.setUTCDate(base.getUTCDate() + diff);
      monday.setUTCHours(0, 0, 0, 0);
      const sunday = new Date(monday);
      sunday.setUTCDate(monday.getUTCDate() + 6);
      sunday.setUTCHours(23, 59, 59, 999);
      return { from: Math.floor(monday.getTime() / 1000), to: Math.floor(sunday.getTime() / 1000) };
    }
    case "month": {
      const firstDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
      const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0, 23, 59, 59, 999));
      return { from: Math.floor(firstDay.getTime() / 1000), to: Math.floor(lastDay.getTime() / 1000) };
    }
    case "year": {
      const yearStart = new Date(Date.UTC(base.getUTCFullYear(), 0, 1));
      const yearEnd = new Date(Date.UTC(base.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
      return { from: Math.floor(yearStart.getTime() / 1000), to: Math.floor(yearEnd.getTime() / 1000) };
    }
    default: {
      const dayStart = new Date(base);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(base);
      dayEnd.setUTCHours(23, 59, 59, 999);
      return { from: Math.floor(dayStart.getTime() / 1000), to: Math.floor(dayEnd.getTime() / 1000) };
    }
  }
}

function getTrendRange(period: string, from: number, to: number): { trendFrom: number; trendTo: number; trendDays: number } {
  if (period === "day") {
    // Last 7 days ending on selected date
    const end = new Date(to * 1000);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
    start.setUTCHours(0, 0, 0, 0);
    return { trendFrom: Math.floor(start.getTime() / 1000), trendTo: to, trendDays: 7 };
  }
  // For week/month/year — trend covers the full selected period
  const days = Math.ceil((to - from) / 86400);
  return { trendFrom: from, trendTo: to, trendDays: days };
}

/** Build B2B-specific funnel from Бух Комм pipeline */
function buildB2BFunnel(
  snapshotLeads: KommoLead[],
  wonLeads: KommoLead[],
  lostLeads: KommoLead[],
) {
  const active = snapshotLeads.filter((l) => !l.is_deleted && !l.closed_at);

  // B2B qualification stages
  const contactMade = active.filter((l) => l.status_id === COMMERCIAL_STATUSES.CONTACT_MADE).length;
  const interestConfirmed = active.filter((l) => l.status_id === COMMERCIAL_STATUSES.INTEREST_CONFIRMED).length;
  const invoiceSent = active.filter((l) => l.status_id === COMMERCIAL_STATUSES.INVOICE_SENT).length;
  const prepayment = active.filter((l) => l.status_id === COMMERCIAL_STATUSES.PREPAYMENT).length;
  const installment = active.filter((l) => l.status_id === COMMERCIAL_STATUSES.INSTALLMENT).length;
  const noConsent = active.filter((l) => l.status_id === COMMERCIAL_STATUSES.NO_CONSENT).length;
  const newLead = active.filter((l) => l.status_id === COMMERCIAL_STATUSES.NEW_LEAD).length;
  const inProgress = active.filter((l) => l.status_id === COMMERCIAL_STATUSES.IN_PROGRESS).length;
  const noAnswer = active.filter((l) => l.status_id === COMMERCIAL_STATUSES.NO_ANSWER).length;

  // Qualified = contactMade and beyond (excluding noConsent)
  const qualLeads = contactMade + interestConfirmed + invoiceSent + prepayment + installment;

  return {
    activeDeals: active.length,
    qualLeads,
    totalLeads: snapshotLeads.filter((l) => !l.is_deleted).length,
    // B2B stages (instead of a2/b1/b2plus)
    newLead,
    inProgress,
    noAnswer,
    contactMade,
    noConsent,
    interestConfirmed,
    invoiceSent,
    prepayment,
    installment,
    wonToday: wonLeads.length,
    lostToday: lostLeads.length,
  };
}

// ==================== Pipeline distribution helper ====================

interface PipelineStats {
  pipelineId: number;
  pipelineName: string;
  activeDeals: number;
  statuses: Array<{ statusId: number; name: string; count: number }>;
}

// BERATER statuses that belong to "Линия 3 — Доведение" (follow-through stages).
// Anything in BERATER not in this set is counted as Линия 2. Kept as an id Set
// instead of a name match so status renames don't silently re-bucket rows.
const BERATER_LINE_3_STATUS_IDS = new Set<number>([
  102183931, // Доведение
  102183935, // Консультация перед термином ДЦ
  102183939, // Конс. перед ДЦ проведена
  102183943, // Консультация перед термином АА
  102183947, // Конс. перед АА проведена
  93860875,  // Термин ДЦ отмен./перенес.
  93886075,  // Термин ДЦ состоялся
  93860883,  // Термин АА отмен./перенес.
  93860891,  // Апелляция
]);

function buildPipelineBreakdown(
  leads: KommoLead[],
  department: string,
): PipelineStats[] {
  const pipelineNames: Record<number, string> = {
    [B2G_PIPELINES.FIRST_LINE]: "Бух Гос (1я линия)",
    [B2G_PIPELINES.BERATER]: "Бух Бератер (2я линия)",
    [B2B_PIPELINES.COMMERCIAL]: "Бух Комм",
    [B2B_PIPELINES.MEDICAL_COMM]: "Medical Admin Commercial",
  };

  // Pipeline status names (synced 2026-04-22 from Kommo API)
  const statusNames: Record<number, string> = {
    // Бух Гос (pipeline 10935879)
    83873487: "Incoming leads",
    93485479: "База",
    83873491: "Новый лид",
    90367079: "Взято в работу",
    90367083: "Недозвон",
    90367087: "Контакт установлен",
    104211575: "Принимает решение",
    95514983: "Консультация проведена",
    101935919: "Док-ты отправлены в ДЦ",
    95514987: "Отложенный старт",
    // Бух Бератер (pipeline 12154099)
    93860327: "Incoming leads",
    93860331: "Принято от 1й линии",
    93860335: "Взято в работу",
    93860339: "Недозвон",
    93860863: "Контакт установлен",
    93860879: "Термин АА",
    102183931: "Доведение",
    102183935: "Консультация перед термином ДЦ",
    102183939: "Конс. перед ДЦ проведена",
    93860875: "Термин ДЦ отмен./перенес.",
    93886075: "Термин ДЦ состоялся",
    102183943: "Консультация перед термином АА",
    102183947: "Конс. перед АА проведена",
    93860883: "Термин АА отмен./перенес.",
    93860887: "На рассмотрении бератера",
    95515895: "Отложенный старт",
    93860891: "Апелляция",
    // Бух Комм (pipeline 10631243)
    81523499: "Incoming leads",
    83364011: "Tech",
    81523503: "Новый лид",
    104076579: "Новый лид 2",
    104076583: "Новый лид 3",
    81523507: "Взят в работу",
    82883595: "Недозвон",
    81523515: "Контакт установлен",
    88519479: "Нет предв. согласия",
    82661915: "Интерес подтверждён",
    82661919: "Счёт выставлен",
    82946495: "Предоплата получена",
    82946499: "Рассрочка",
    // Medical Admin Commercial (pipeline 13209983)
    101858011: "Incoming leads",
    101858015: "Tech",
    101858019: "Новый лид",
    104076587: "Новый лид 2",
    104076591: "Новый лид 3",
    101858023: "Взят в работу",
    101858255: "Недозвон",
    101858259: "Контакт установлен",
    101858263: "Нет предв. согласия",
    101858267: "Интерес подтверждён",
    101858271: "Счёт выставлен",
    101858275: "Предоплата получена",
    101858279: "Рассрочка",
  };

  const pipelineIds = getPipelineIds(department);
  const byPipeline = new Map<number, KommoLead[]>();

  for (const pid of pipelineIds) {
    byPipeline.set(pid, []);
  }

  for (const lead of leads) {
    if (lead.is_deleted) continue;
    const bucket = byPipeline.get(lead.pipeline_id);
    if (bucket) bucket.push(lead);
  }

  const result: PipelineStats[] = [];

  for (const [pipelineId, pLeads] of byPipeline) {
    const active = pLeads.filter((l) => !l.closed_at);

    // For B2G BERATER: split into "Линия 2" and "Линия 3 — Доведение" so the
    // user sees the Доведение funnel as its own card (status-id split, not a
    // separate Kommo pipeline).
    if (department === "b2g" && pipelineId === B2G_PIPELINES.BERATER) {
      const line2Leads: KommoLead[] = [];
      const line3Leads: KommoLead[] = [];
      for (const lead of active) {
        if (BERATER_LINE_3_STATUS_IDS.has(lead.status_id)) line3Leads.push(lead);
        else line2Leads.push(lead);
      }

      for (const [cardName, cardLeads] of [
        ["Бух Бератер (2я линия)", line2Leads] as const,
        ["Линия 3 — Доведение", line3Leads] as const,
      ]) {
        const statusCounts = new Map<number, number>();
        for (const lead of cardLeads) {
          statusCounts.set(lead.status_id, (statusCounts.get(lead.status_id) ?? 0) + 1);
        }
        const statuses = Array.from(statusCounts.entries())
          .map(([sid, count]) => ({
            statusId: sid,
            name: statusNames[sid] || `Status ${sid}`,
            count,
          }))
          .sort((a, b) => b.count - a.count);
        result.push({
          pipelineId,
          pipelineName: cardName,
          activeDeals: cardLeads.length,
          statuses,
        });
      }
      continue;
    }

    // Count by status
    const statusCounts = new Map<number, number>();
    for (const lead of active) {
      statusCounts.set(lead.status_id, (statusCounts.get(lead.status_id) ?? 0) + 1);
    }

    const statuses = Array.from(statusCounts.entries())
      .map(([sid, count]) => ({
        statusId: sid,
        name: statusNames[sid] || `Status ${sid}`,
        count,
      }))
      .sort((a, b) => b.count - a.count);

    result.push({
      pipelineId,
      pipelineName: pipelineNames[pipelineId] || `Pipeline ${pipelineId}`,
      activeDeals: active.length,
      statuses,
    });
  }

  return result;
}

// ==================== MAIN HANDLER ====================

const RESPONSE_CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department") || "b2g";
    const period = url.searchParams.get("period") || "day";
    const dateStr = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
    // Optional explicit range — when provided, overrides period-based boundaries.
    // Lets the UI collapse day/week/month/year buttons into one calendar with
    // День/Период toggle.
    const fromStr = url.searchParams.get("from");
    const toStr = url.searchParams.get("to");

    const cacheKey = `dashboard-response:${department}:${period}:${dateStr}:${fromStr || ""}:${toStr || ""}`;
    const responseData = await cached(cacheKey, RESPONSE_CACHE_TTL, () =>
      buildDashboardResponse(department, period, dateStr, fromStr, toStr)
    );

    return NextResponse.json(responseData);
  } catch (error) {
    console.error("Dashboard API error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

async function buildDashboardResponse(
  department: string,
  period: string,
  dateStr: string,
  fromStr: string | null,
  toStr: string | null,
) {
    // Explicit from/to (inclusive, "YYYY-MM-DD") take priority over period/date.
    let from: number;
    let to: number;
    let effectivePeriod = period;
    if (fromStr && toStr) {
      const fromDate = new Date(`${fromStr}T00:00:00Z`);
      const toDate = new Date(`${toStr}T00:00:00Z`);
      toDate.setUTCHours(23, 59, 59, 999);
      from = Math.floor(fromDate.getTime() / 1000);
      to = Math.floor(toDate.getTime() / 1000);
      // Mark as custom so getTrendRange uses the full range (not 7-day default).
      effectivePeriod = fromStr === toStr ? "day" : "custom";
    } else {
      const derived = getDateRange(period, dateStr);
      from = derived.from;
      to = derived.to;
    }
    const { trendFrom, trendTo } = getTrendRange(effectivePeriod, from, to);

    const pipelineIds = getPipelineIds(department);
    const activeStatusIds = getActiveStatusIds(department);

    const allManagers = await getManagersWithKommo(department);

    // All external calls in parallel. Calls (and trend) come from the analytics
    // DB mirror — much more accurate than Kommo's paginated notes API. Leads,
    // tasks, and won/lost still come from Kommo (those aren't in the mirror).
    const closedDateFilter = { field: "closed_at" as const, from, to };
    const [snapshotLeads, tasks, wonLeads, lostLeads, todayCallMap, trendBuckets] = await Promise.all([
      // All lead snapshots/filters go through analytics.leads_cohort (local
      // mirror) instead of Kommo API — ~20x faster, deterministic results.
      getAnalyticsLeads({ pipelineIds, statusIds: activeStatusIds, activeOnly: true }).catch(() => [] as KommoLead[]),
      getTasks(false).catch(() => []),
      getAnalyticsLeads({ pipelineIds, statusIds: [142], dateFilter: closedDateFilter }).catch(() => [] as KommoLead[]),
      getAnalyticsLeads({ pipelineIds, statusIds: [143], dateFilter: closedDateFilter }).catch(() => [] as KommoLead[]),
      getAnalyticsCallMetricsByMaster(allManagers, department, from, to).catch((e) => {
        console.error("[Dashboard] analytics calls failed:", e);
        return new Map<string, UserCallMetrics>();
      }),
      getAnalyticsDailyTrend(department, trendFrom, trendTo).catch((e) => {
        console.error("[Dashboard] analytics trend failed:", e);
        return [];
      }),
    ]);

    // Summary = sum of all per-manager metrics for the period
    const todaySummary = sumCallMetrics(Array.from(todayCallMap.values()));

    // Step 4: Aggregate lead funnel.
    // Kommo doesn't store historical pipeline snapshots, so the funnel and
    // pipeline breakdown always reflect the CURRENT active state (regardless
    // of the selected date range). Calls/revenue/won-lost DO respect the
    // range — they're derived from timestamped events, not live state.
    let funnel: Record<string, unknown>;

    if (department === "b2b") {
      funnel = buildB2BFunnel(snapshotLeads, wonLeads, lostLeads);
    } else {
      // B2G funnel with qualification stages. "Flow" metrics (a2/b1/b2+) still
      // use the from/to range since they track movement, not snapshot state.
      const snapshotLeadsAll = [...snapshotLeads, ...wonLeads, ...lostLeads];
      const flowActive = snapshotLeads.filter(
        (l) => l.updated_at >= from && l.updated_at <= to,
      );
      const flowLeads = [...flowActive, ...wonLeads, ...lostLeads];
      const fc = aggregateLeadFunnelMetrics(snapshotLeadsAll, flowLeads, from, to);
      funnel = {
        activeDeals: fc.activeDeals,
        qualLeads: fc.qualLeads,
        totalLeads: fc.totalLeads,
        a2: fc.a2,
        b1: fc.b1,
        b2plus: fc.b2plus,
        wonToday: wonLeads.length,
        lostToday: lostLeads.length,
      };
    }

    // Step 5: Aggregate tasks (Kommo — keyed by kommoUserId)
    const taskMap = aggregateTaskMetrics(tasks);
    let totalOverdue = 0;
    for (const m of allManagers) {
      if (m.kommoUserId != null) {
        totalOverdue += taskMap.get(m.kommoUserId)?.overdueTasks ?? 0;
      }
    }

    // Step 6: WON revenue from today
    const todayRevenue = wonLeads.reduce((sum, l) => sum + (l.price || 0), 0);

    // Step 7: Per-manager breakdown. Include ALL active managers+rops from the
    // master table; analytics matches by name so kommoUserId is no longer required.
    // Managers without a kommoUserId get 0 overdue tasks but still show calls.
    // Only role='manager' per user policy — ROPs/admins don't appear in the
    // per-manager tables even if they were carrying calls.
    const perManager = allManagers
      .filter((m) => m.role === "manager")
      .map((mgr) => {
        const cm = todayCallMap.get(mgr.id);
        const tm = mgr.kommoUserId ? taskMap.get(mgr.kommoUserId) : undefined;
        return {
          id: mgr.id,
          name: mgr.name,
          line: mgr.line,
          kommoUserId: mgr.kommoUserId,
          callsTotal: cm?.callsTotal ?? 0,
          callsConnected: cm?.callsConnected ?? 0,
          dialPercent: cm?.dialPercent ?? 0,
          totalMinutes: cm?.totalMinutes ?? 0,
          avgDialogMinutes: cm?.avgDialogMinutes ?? 0,
          missedIncoming: cm?.missedIncoming ?? 0,
          incomingTotal: cm?.incomingTotal ?? 0,
          outgoingTotal: cm?.outgoingTotal ?? 0,
          overdueTasks: tm?.overdueTasks ?? 0,
        };
      })
      .sort((a, b) => b.callsTotal - a.callsTotal);

    // Step 8: Trend line (already per-day buckets from analytics)
    const trend = trendBuckets;

    // Step 9: Missed calls breakdown (today)
    const missedBreakdown = {
      incomingTotal: todaySummary.incomingTotal,
      missedIncoming: todaySummary.missedIncoming,
      missedPercent: todaySummary.incomingTotal > 0
        ? Math.round((todaySummary.missedIncoming / todaySummary.incomingTotal) * 100)
        : 0,
    };

    // Step 10: Per-pipeline breakdown
    // Pipeline breakdown reflects current active pipeline state. Kommo has no
    // historical snapshots to reconstruct what the pipeline looked like on a
    // past date, so tying this to from/to would make past-date views empty.
    const pipelineBreakdown = buildPipelineBreakdown(snapshotLeads, department);

    return {
      date: dateStr,
      period,
      department,
      todayMetrics: {
        callsTotal: todaySummary.callsTotal,
        callsConnected: todaySummary.callsConnected,
        dialPercent: todaySummary.dialPercent,
        totalMinutes: todaySummary.totalMinutes,
        avgDialogMinutes: todaySummary.avgDialogMinutes,
        missedIncoming: todaySummary.missedIncoming,
        incomingTotal: todaySummary.incomingTotal,
        outgoingTotal: todaySummary.outgoingTotal,
        overdueTasks: totalOverdue,
        revenue: todayRevenue,
        managersCount: allManagers.length,
      },
      funnel,
      missedBreakdown,
      perManager,
      trend,
      pipelineBreakdown,
    };
}
