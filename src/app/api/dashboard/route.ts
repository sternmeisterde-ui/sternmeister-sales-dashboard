// GET /api/dashboard?department=b2g
// Returns aggregated Kommo CRM metrics for the Dashboard tab:
//   - todayMetrics: summary KPI cards
//   - perManager: per-manager breakdown
//   - trend: last 7 days call/lead trend
//   - funnel: pipeline funnel counts
//   - missedBreakdown: detailed missed calls info
//   - pipelineBreakdown: per-pipeline lead distribution (for B2G: Бух Гос + Бух Бератер)

import { NextRequest, NextResponse } from "next/server";
import { getCallNotes, getLeads, getTasks } from "@/lib/kommo/client";
import {
  aggregateCallMetrics,
  aggregateLeadFunnelMetrics,
  aggregateTaskMetrics,
  sumCallMetrics,
  type UserCallMetrics,
} from "@/lib/kommo/metrics";
import { getD1ManagersWithKommo } from "@/lib/db/queries-daily";
import {
  getPipelineIds,
  getActiveStatusIds,
  B2G_PIPELINES,
  B2B_PIPELINES,
  COMMERCIAL_STATUSES,
} from "@/lib/kommo/pipeline-config";
import type { KommoCallNote, KommoLead } from "@/lib/kommo/types";

// ==================== Helpers ====================

function todayRange(): { from: number; to: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return {
    from: Math.floor(start.getTime() / 1000),
    to: Math.floor(end.getTime() / 1000),
  };
}

function last7DaysRange(): { from: number; to: number } {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);
  return {
    from: Math.floor(start.getTime() / 1000),
    to: Math.floor(end.getTime() / 1000),
  };
}

/** Group call notes by calendar day → per-day call counts */
function groupCallsByDay(notes: KommoCallNote[], fromTs: number): Array<{
  date: string;
  callsTotal: number;
  callsConnected: number;
  totalMinutes: number;
  missedIncoming: number;
  incomingTotal: number;
  outgoingTotal: number;
}> {
  const dayMap = new Map<string, KommoCallNote[]>();

  // Initialize all 7 days
  for (let i = 0; i < 7; i++) {
    const d = new Date(fromTs * 1000);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    dayMap.set(key, []);
  }

  for (const note of notes) {
    const ts = note.created_at * 1000;
    const key = new Date(ts).toISOString().slice(0, 10);
    if (dayMap.has(key)) {
      dayMap.get(key)!.push(note);
    }
  }

  const result: Array<{
    date: string;
    callsTotal: number;
    callsConnected: number;
    totalMinutes: number;
    missedIncoming: number;
    incomingTotal: number;
    outgoingTotal: number;
  }> = [];

  for (const [date, dayNotes] of dayMap) {
    const outgoing = dayNotes.filter((n) => n.note_type === "call_out");
    const incoming = dayNotes.filter((n) => n.note_type === "call_in");
    const connected = dayNotes.filter((n) => (n.params?.duration ?? 0) >= 1);
    const missed = incoming.filter(
      (n) => n.params?.call_status === 3 || (n.params?.duration ?? 0) === 0
    );
    const totalSeconds = connected.reduce(
      (sum, n) => sum + (n.params?.duration ?? 0), 0
    );

    result.push({
      date,
      callsTotal: outgoing.length,
      callsConnected: connected.length,
      totalMinutes: Math.round(totalSeconds / 60),
      missedIncoming: missed.length,
      incomingTotal: incoming.length,
      outgoingTotal: outgoing.length,
    });
  }

  result.sort((a, b) => a.date.localeCompare(b.date));
  return result;
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

function buildPipelineBreakdown(
  leads: KommoLead[],
  department: string,
): PipelineStats[] {
  const pipelineNames: Record<number, string> = {
    [B2G_PIPELINES.FIRST_LINE]: "Бух Гос (1я линия)",
    [B2G_PIPELINES.BERATER]: "Бух Бератер (2я линия)",
    [B2B_PIPELINES.COMMERCIAL]: "Бух Комм",
  };

  // B2G status names
  const statusNames: Record<number, string> = {
    // Бух Гос
    83873487: "Неразобранное",
    93485479: "База",
    83873491: "Новый лид",
    90367079: "Взято в работу",
    90367083: "Недозвон",
    90367087: "Контакт установлен",
    95514983: "Консультация проведена",
    101935919: "Док-ты отправлены в ДЦ",
    95514987: "Отложенный старт",
    // Бух Бератер
    93860327: "Неразобранное",
    93860331: "Принято от 1й линии",
    93860335: "Взято в работу",
    93860339: "Недозвон",
    93860863: "Контакт установлен",
    93860875: "Термин ДЦ отмен./перенес.",
    93886075: "Термин ДЦ состоялся",
    93860879: "Термин АА",
    93860883: "Термин АА отмен./перенес.",
    93860887: "На рассмотрении бератера",
    95515895: "Отложенный старт",
    93860891: "Апелляция",
    // Бух Комм
    81523499: "Incoming leads",
    83364011: "Tech",
    81523503: "Новый лид",
    81523507: "Взят в работу",
    82883595: "Недозвон",
    81523515: "Контакт установлен",
    88519479: "Нет предв. согласия",
    82661915: "Интерес подтвержден",
    82661919: "Счет выставлен",
    82946495: "Предоплата получена",
    82946499: "Рассрочка",
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

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department") || "b2g";

    const today = todayRange();
    const week = last7DaysRange();

    const pipelineIds = getPipelineIds(department);
    const activeStatusIds = getActiveStatusIds(department);

    // Step 1: DB — get managers (filter by department line if needed)
    const allManagers = await getD1ManagersWithKommo();
    // For B2B we still want all managers' calls — Kommo user IDs drive call attribution
    const kommoUserIds = allManagers
      .map((m) => m.kommoUserId)
      .filter((id): id is number => id !== null);

    // Step 2: Kommo API — fetch in parallel groups
    // Group A: snapshot data (no date filter)
    const [snapshotLeads, tasks] = await Promise.all([
      getLeads(pipelineIds, activeStatusIds, 10).catch(() => [] as KommoLead[]),
      getTasks(false).catch(() => []),
    ]);

    // Group B: period-filtered data
    const closedDateFilter = { field: "closed_at" as const, from: today.from, to: today.to };
    const [wonLeadsToday, lostLeadsToday, callNotesToday, callNotesWeek] = await Promise.all([
      getLeads(pipelineIds, [142], 3, closedDateFilter).catch(() => [] as KommoLead[]),
      getLeads(pipelineIds, [143], 3, closedDateFilter).catch(() => [] as KommoLead[]),
      getCallNotes(today.from, today.to, kommoUserIds, 20).catch(() => [] as KommoCallNote[]),
      getCallNotes(week.from, week.to, kommoUserIds, 30).catch(() => [] as KommoCallNote[]),
    ]);

    // Step 3: Aggregate today's call metrics
    const todayCallMap = aggregateCallMetrics(callNotesToday);
    const allTodayCallMetrics: UserCallMetrics[] = [];
    for (const uid of kommoUserIds) {
      const m = todayCallMap.get(uid);
      if (m) allTodayCallMetrics.push(m);
    }
    const todaySummary = sumCallMetrics(allTodayCallMetrics);

    // Step 4: Aggregate lead funnel
    let funnel: Record<string, unknown>;

    if (department === "b2b") {
      funnel = buildB2BFunnel(snapshotLeads, wonLeadsToday, lostLeadsToday);
    } else {
      // B2G funnel with qualification stages
      const snapshotLeadsAll = [...snapshotLeads, ...wonLeadsToday, ...lostLeadsToday];
      const flowActive = snapshotLeads.filter(
        (l) => l.updated_at >= today.from && l.updated_at <= today.to
      );
      const flowLeads = [...flowActive, ...wonLeadsToday, ...lostLeadsToday];
      const fc = aggregateLeadFunnelMetrics(snapshotLeadsAll, flowLeads, today.from, today.to);
      funnel = {
        activeDeals: fc.activeDeals,
        qualLeads: fc.qualLeads,
        totalLeads: fc.totalLeads,
        a2: fc.a2,
        b1: fc.b1,
        b2plus: fc.b2plus,
        wonToday: wonLeadsToday.length,
        lostToday: lostLeadsToday.length,
      };
    }

    // Step 5: Aggregate tasks
    const taskMap = aggregateTaskMetrics(tasks);
    let totalOverdue = 0;
    for (const uid of kommoUserIds) {
      totalOverdue += taskMap.get(uid)?.overdueTasks ?? 0;
    }

    // Step 6: WON revenue from today
    const todayRevenue = wonLeadsToday.reduce((sum, l) => sum + (l.price || 0), 0);

    // Step 7: Per-manager breakdown (today)
    const perManager = allManagers
      .filter((m) => m.kommoUserId !== null)
      .map((mgr) => {
        const cm = mgr.kommoUserId ? todayCallMap.get(mgr.kommoUserId) : undefined;
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

    // Step 8: 7-day trend
    const trend = groupCallsByDay(callNotesWeek, week.from);

    // Step 9: Missed calls breakdown (today)
    const missedBreakdown = {
      incomingTotal: todaySummary.incomingTotal,
      missedIncoming: todaySummary.missedIncoming,
      missedPercent: todaySummary.incomingTotal > 0
        ? Math.round((todaySummary.missedIncoming / todaySummary.incomingTotal) * 100)
        : 0,
    };

    // Step 10: Per-pipeline breakdown
    const pipelineBreakdown = buildPipelineBreakdown(snapshotLeads, department);

    return NextResponse.json({
      date: new Date().toISOString().slice(0, 10),
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
    });
  } catch (error) {
    console.error("Dashboard API error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
