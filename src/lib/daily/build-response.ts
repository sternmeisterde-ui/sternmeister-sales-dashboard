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
import { getManagersWithKommo, getPlans, getScheduleForDate } from "@/lib/db/queries-daily";
import { dailySections, type SectionDef } from "@/lib/daily/metrics-config";
import { B2G_ALL_PIPELINE_IDS, ALL_ACTIVE_STATUS_IDS } from "@/lib/kommo/pipeline-config";
import type { LeadFunnelCounts } from "@/lib/kommo/metrics";
import type { KommoLead } from "@/lib/kommo/types";

// ==================== Period helpers ====================

function getDateRange(
  period: string,
  dateStr: string
): { from: number; to: number; periodType: string; periodDate: string } {
  const base = new Date(`${dateStr}T00:00:00Z`);

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
      const weekNum = getISOWeek(monday);
      return {
        from: Math.floor(monday.getTime() / 1000),
        to: Math.floor(sunday.getTime() / 1000),
        periodType: "week",
        periodDate: `${monday.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`,
      };
    }
    case "month": {
      const firstDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
      const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0, 23, 59, 59, 999));
      return {
        from: Math.floor(firstDay.getTime() / 1000),
        to: Math.floor(lastDay.getTime() / 1000),
        periodType: "month",
        periodDate: `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}`,
      };
    }
    case "year": {
      const yearStart = new Date(Date.UTC(base.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
      const yearEnd = new Date(Date.UTC(base.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
      return {
        from: Math.floor(yearStart.getTime() / 1000),
        to: Math.floor(yearEnd.getTime() / 1000),
        periodType: "year",
        periodDate: String(base.getUTCFullYear()),
      };
    }
    default: {
      const dayStart = new Date(base);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(base);
      dayEnd.setUTCHours(23, 59, 59, 999);
      return {
        from: Math.floor(dayStart.getTime() / 1000),
        to: Math.floor(dayEnd.getTime() / 1000),
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

export async function buildDailyResponseCached(department: string, period: string, dateStr: string) {
  const cacheKey = `daily-response:${department}:${period}:${dateStr}`;
  return cached(cacheKey, RESPONSE_CACHE_TTL, () => buildDailyResponse(department, period, dateStr));
}

// ==================== MAIN BUILD FUNCTION ====================

export async function buildDailyResponse(department: string, period: string, dateStr: string) {
  const { from, to, periodType, periodDate } = getDateRange(period, dateStr);
  const { leadsPages, closedPages, callPages } = getMaxPages(period);

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
  const [snapshotActiveLeads, tasks, wonLeads, lostLeads, callNotes, termsWonLeads, newLeadsInPeriod, termAACount] = await Promise.all([
    getLeads(B2G_ALL_PIPELINE_IDS, ALL_ACTIVE_STATUS_IDS, leadsPages).catch((e) => {
      console.error("Kommo snapshot leads error:", e);
      return [] as KommoLead[];
    }),
    getTasks(false).catch((e) => {
      console.error("Kommo tasks error:", e);
      return [];
    }),
    getLeads(B2G_ALL_PIPELINE_IDS, [142], closedPages, closedDateFilter).catch((e) => {
      console.error("Kommo won leads error:", e);
      return [] as KommoLead[];
    }),
    getLeads(B2G_ALL_PIPELINE_IDS, [143], closedPages, closedDateFilter).catch((e) => {
      console.error("Kommo lost leads error:", e);
      return [] as KommoLead[];
    }),
    getCallNotes(from, to, kommoUserIds, callPages).catch((e) => {
      console.error("Kommo call notes error:", e);
      return [];
    }),
    getLeads([10935879], [142], closedPages, termsDateFilter).catch((e) => {
      console.error("Kommo terms won leads error:", e);
      return [] as KommoLead[];
    }),
    // ALL leads from first line created in period (including closed) — for totalLeads/qualLeads
    getLeads([10935879], undefined, leadsPages, createdDateFilter).catch((e) => {
      console.error("Kommo new leads error:", e);
      return [] as KommoLead[];
    }),
    // Термин АА: events where leads moved INTO statuses 102183943/102183947 in berater pipeline
    getStatusChangeCount(from, to, 12154099, [102183943, 102183947]).catch((e) => {
      console.error("Kommo term AA events error:", e);
      return 0;
    }),
  ]);

  const activeOnly = snapshotActiveLeads.filter((l) => !l.closed_at);
  const byPipeline: Record<number, number> = {};
  for (const l of snapshotActiveLeads) {
    byPipeline[l.pipeline_id] = (byPipeline[l.pipeline_id] || 0) + 1;
  }
  console.log(
    `[Daily API] ${department}/${period}/${dateStr}: allLeads=${snapshotActiveLeads.length} active=${activeOnly.length} byPipeline=${JSON.stringify(byPipeline)} won=${wonLeads.length} lost=${lostLeads.length} calls=${callNotes.length} terms=${termsWonLeads.length} managers=${managers.length} line1=${managers.filter((m) => m.line === "1").length}`
  );

  const flowActiveLeads = snapshotActiveLeads.filter(
    (lead) => lead.updated_at >= from && lead.updated_at <= to
  );

  const snapshotLeads = [...snapshotActiveLeads, ...wonLeads, ...lostLeads];
  const flowLeads = [...flowActiveLeads, ...wonLeads, ...lostLeads];

  const callMetricsMap = aggregateCallMetrics(callNotes);
  const leadMetricsMap = aggregateLeadMetrics(snapshotLeads, from, to);
  const funnelCounts = aggregateLeadFunnelMetrics(snapshotLeads, flowLeads, from, to);
  const taskMetricsMap = aggregateTaskMetrics(tasks);

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

  const sections = dailySections.map((section) => {
    const sectionManagers = managers.filter(
      (m) => section.key === "funnel" || m.line === section.dbLine
    );

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

      if (section.key === "funnel") {
        fact = getFunnelFact(metric.key, funnelCounts, managersOnLineCount, snapshotLeads, line1ManagerCount, termsWonLeads, from, to, newLeadsInPeriod, termAACount);
      } else {
        const facts = buildUserFacts(summaryCallMetrics, totalOverdue, section);
        fact = facts[metric.key] ?? null;
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

      return { key: metric.key, label: metric.label, plan, fact, percent, isGroupHeader: false };
    });

    let managerData: Array<{
      id: string;
      name: string;
      kommoUserId: number | null;
      metrics: Array<{ key: string; plan: string | null; fact: string | null; percent: number | null }>;
    }> = [];

    if (section.key === "funnel") {
      const funnelManagers = managers.filter((m) => m.line === "1" || m.line === "2");
      if (funnelManagers.length > 0) {
        const excludeQual = new Set([142, 143, 93485479, 95514987, 83873487, 83873491, 90367079, 90367083]);
        const excludePortfolio = new Set([142, 143, 93485479, 95514987]);
        const awaitStatuses = new Set([93860331, 102183931, 102183935, 102183939]);
        const beraterPipeline = 12154099;
        const firstLinePipeline = 10935879;

        managerData = funnelManagers.map((mgr) => {
          const uid = mgr.kommoUserId;
          const mgrLeads = uid ? snapshotLeads.filter((l) => l.responsible_user_id === uid) : [];
          const mgrActiveLeads = mgrLeads.filter((l) => !l.is_deleted && !l.closed_at);
          const mgrTermsWon = uid ? (termsWonLeads || []).filter((l) => l.responsible_user_id === uid) : [];
          const mgrNewLeads = uid ? (newLeadsInPeriod || []).filter((l) => l.responsible_user_id === uid && !l.is_deleted) : [];

          const mgrMetrics = section.metrics
            .filter((m) => !m.isGroupHeader)
            .map((metric) => {
              let fact: string | null = null;
              switch (metric.key) {
                case "activeDeals":
                  fact = String(mgrActiveLeads.length);
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
                  // "New" = created in current month
                  const baseD = new Date(from * 1000);
                  const mStart = new Date(Date.UTC(baseD.getUTCFullYear(), baseD.getUTCMonth(), 1)).getTime() / 1000;
                  const mEnd = new Date(Date.UTC(baseD.getUTCFullYear(), baseD.getUTCMonth() + 1, 0, 23, 59, 59)).getTime() / 1000;
                  fact = String(mgrTermsWon.filter((l) => l.created_at >= mStart && l.created_at <= mEnd).length);
                  break;
                }
                case "awaitTermTotal":
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && awaitStatuses.has(l.status_id)).length);
                  break;
                case "awaitTermNew": {
                  const bD = new Date(from * 1000);
                  const ms = new Date(Date.UTC(bD.getUTCFullYear(), bD.getUTCMonth(), 1)).getTime() / 1000;
                  const me = new Date(Date.UTC(bD.getUTCFullYear(), bD.getUTCMonth() + 1, 0, 23, 59, 59)).getTime() / 1000;
                  fact = String(mgrActiveLeads.filter((l) => l.pipeline_id === beraterPipeline && awaitStatuses.has(l.status_id) && l.created_at >= ms && l.created_at <= me).length);
                  break;
                }
                case "gutscheinsApproved": {
                  const mgrGut = uid ? wonLeads.filter((l) => l.responsible_user_id === uid && l.pipeline_id === beraterPipeline).length : 0;
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

    if (section.perManager) {
      managerData = sectionManagers.map((mgr) => {
        const kommoId = mgr.kommoUserId;
        const mgrCallMetrics = kommoId ? callMetricsMap.get(kommoId) : undefined;
        const mgrOverdue = kommoId ? (taskMetricsMap.get(kommoId)?.overdueTasks ?? 0) : 0;
        const mgrFacts = buildUserFacts(mgrCallMetrics, mgrOverdue, section);

        const mgrMetrics = section.metrics
          .filter((m) => !m.isGroupHeader)
          .map((metric) => {
            const plan = getPlan(section.dbLine, mgr.id, metric.key);
            let fact = mgrFacts[metric.key] ?? null;
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

// ==================== FUNNEL FACT RESOLVER ====================

function getFunnelFact(
  key: string,
  fc: LeadFunnelCounts,
  managersOnLine: number,
  snapshotLeads?: KommoLead[],
  line1ManagerCount?: number,
  termsWonLeads?: KommoLead[],
  from?: number,
  to?: number,
  newLeadsInPeriod?: KommoLead[],
  termAATransferredCount?: number,
): string | null {
  switch (key) {
    case "activeDeals": {
      const adCount = (snapshotLeads || []).filter((l) => !l.is_deleted && !l.closed_at).length;
      return String(adCount);
    }
    case "termsTotal":
      return String(termsWonLeads?.length ?? 0);
    case "termsNew": {
      // "New" = leads created in current month (not recycled from old months)
      const baseDate = new Date((from ?? 0) * 1000);
      const monthStart = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), 1)).getTime() / 1000;
      const monthEnd = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() + 1, 0, 23, 59, 59)).getTime() / 1000;
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
      const pipelineId = 10935879;
      const portfolioLeads = (snapshotLeads || []).filter(
        (l) => l.pipeline_id === pipelineId && !l.is_deleted && !excludeStatuses.has(l.status_id)
      );
      const divisor = line1ManagerCount || managersOnLine || 1;
      return String(Math.round(portfolioLeads.length / divisor));
    }
    case "awaitTermTotal": {
      const awaitStatuses = new Set([93860331, 102183931, 102183935, 102183939]);
      const beraterPipeline = 12154099;
      const awaiting = (snapshotLeads || []).filter(
        (l) => l.pipeline_id === beraterPipeline && !l.is_deleted && !l.closed_at && awaitStatuses.has(l.status_id)
      );
      return String(awaiting.length);
    }
    case "awaitTermNew": {
      // Awaiting term + created in current month
      const awaitStatusesNew = new Set([93860331, 102183931, 102183935, 102183939]);
      const beraterPipelineNew = 12154099;
      const baseNew = new Date((from ?? 0) * 1000);
      const mStartNew = new Date(Date.UTC(baseNew.getUTCFullYear(), baseNew.getUTCMonth(), 1)).getTime() / 1000;
      const mEndNew = new Date(Date.UTC(baseNew.getUTCFullYear(), baseNew.getUTCMonth() + 1, 0, 23, 59, 59)).getTime() / 1000;
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
        (l) => l.pipeline_id === 12154099 && !l.is_deleted && !l.closed_at && l.status_id === 93860875
      ).length);
    }
    case "termDCDone": {
      // Термин ДЦ состоялся: status 93886075 in berater pipeline
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === 12154099 && !l.is_deleted && !l.closed_at && l.status_id === 93886075
      ).length);
    }
    case "termAATransferred": {
      // Переведены на термин АА: counted via Events API (status changes)
      return String(termAATransferredCount ?? 0);
    }
    case "termAACancelled": {
      // Термин АА отменен/перенесен: status 93860883 in berater pipeline
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === 12154099 && !l.is_deleted && !l.closed_at && l.status_id === 93860883
      ).length);
    }
    case "termAACount": {
      // Термин АА (на этапе): statuses 102183943 + 102183947 in berater pipeline
      const aaStatuses = new Set([102183943, 102183947]);
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === 12154099 && !l.is_deleted && !l.closed_at && aaStatuses.has(l.status_id)
      ).length);
    }
    case "beraterReview": {
      // На рассмотрении бератера: status 93860887
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === 12154099 && !l.is_deleted && !l.closed_at && l.status_id === 93860887
      ).length);
    }
    case "delayedStart": {
      // Отложенный старт: status 95515895 in berater pipeline
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === 12154099 && !l.is_deleted && !l.closed_at && l.status_id === 95515895
      ).length);
    }
    case "appeal": {
      // Апелляция: status 93860891
      return String((snapshotLeads || []).filter(
        (l) => l.pipeline_id === 12154099 && !l.is_deleted && !l.closed_at && l.status_id === 93860891
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
