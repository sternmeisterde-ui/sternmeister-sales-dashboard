// GET /api/daily?department=b2g&period=day&date=2026-02-28
// Returns merged Kommo facts + DB plans for the Daily tab
import { NextRequest, NextResponse } from "next/server";
import { cached } from "@/lib/kommo/cache";
import { getCallNotes, getLeads, getTasks } from "@/lib/kommo/client";
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
      const weekNum = getISOWeek(monday);
      return {
        from: Math.floor(monday.getTime() / 1000),
        to: Math.floor(sunday.getTime() / 1000),
        periodType: "week",
        periodDate: `${monday.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`,
      };
    }
    case "month": {
      const firstDay = new Date(
        Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1)
      );
      const lastDay = new Date(
        Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0, 23, 59, 59, 999)
      );
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

// ==================== Per-period page limits ====================
// Fewer pages for short periods = fewer API requests = faster loading
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

// ==================== Build per-user metric values ====================

function buildUserFacts(
  callMetrics: UserCallMetrics | undefined,
  taskOverdue: number,
  _section: SectionDef
): Record<string, string> {
  const facts: Record<string, string> = {};

  if (callMetrics) {
    facts["callsTotal"] = String(callMetrics.callsTotal);
    facts["callsConnected"] = String(callMetrics.callsConnected);
    facts["dialPercent"] = String(callMetrics.dialPercent);
    facts["missedIncoming"] = String(callMetrics.missedIncoming);
    facts["totalMinutes"] = String(callMetrics.totalMinutes);
    facts["avgDialogMinutes"] = String(callMetrics.avgDialogMinutes);
  }

  facts["overdueTasks"] = String(taskOverdue);

  return facts;
}

// ==================== MAIN HANDLER ====================

// Response-level cache: 2 min TTL for assembled daily data
const RESPONSE_CACHE_TTL = 2 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department") || "b2g";
    const period = url.searchParams.get("period") || "day";
    const dateStr =
      url.searchParams.get("date") || new Date().toISOString().slice(0, 10);

    const cacheKey = `daily-response:${department}:${period}:${dateStr}`;
    const responseData = await cached(cacheKey, RESPONSE_CACHE_TTL, async () => {
      return buildDailyResponse(department, period, dateStr);
    });

    return NextResponse.json(responseData);
  } catch (error) {
    console.error("Daily API error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}

async function buildDailyResponse(department: string, period: string, dateStr: string) {
    const { from, to, periodType, periodDate } = getDateRange(period, dateStr);
    const { leadsPages, closedPages, callPages } = getMaxPages(period);

    // ─── Step 1: DB queries (fast, parallel) ───
    // Always load monthly plan as base — day/week plans are derived proportionally
    const base = new Date(dateStr + "T00:00:00Z");
    const monthPeriodDate = `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}`;
    const daysInMonth = new Date(base.getUTCFullYear(), base.getUTCMonth() + 1, 0).getUTCDate();

    const [allManagers, monthlyPlans, scheduleMap] = await Promise.all([
      getManagersWithKommo(department),
      getPlans(department, "month", monthPeriodDate),
      period === "day" ? getScheduleForDate(dateStr) : Promise.resolve(null),
    ]);

    // Calculate plan multiplier/divisor based on period
    // Month plan is the base (divisor=1). Day/week = divide, year = multiply by 12
    let planDivisor = 1;
    if (periodType === "day") {
      planDivisor = daysInMonth; // e.g. 31 for March
    } else if (periodType === "week") {
      planDivisor = daysInMonth / 7; // ~4.3 weeks per month
    } else if (periodType === "year") {
      planDivisor = 1 / 12; // year = month * 12
    }
    // month uses divisor=1 (full monthly plan)

    const plans = monthlyPlans;

    // Schedule / on-line filtering
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

    // ─── Step 2: Kommo API (cached, sequential groups to avoid rate limit bursts) ───
    //
    // Group A: Snapshot data (no date filter / static)
    //   - Active leads snapshot (all active leads NOW — for snapshot metrics)
    //   - Tasks (overdue — point-in-time)
    //
    // Group B: Period-filtered data
    //   - WON leads closed in period
    //   - LOST leads closed in period
    //   - Call notes for period
    //
    // Running as 2 sequential groups reduces peak burst from 5→2-3 concurrent chains.
    // Each individual call is cached by client.ts, so repeat requests are instant.

    const closedDateFilter = { field: "closed_at" as const, from, to };

    // For "termsTotal" — previous day (or same period for non-day views)
    let termsFrom = from;
    let termsTo = to;
    if (periodType === "day") {
      // Previous day: shift back 24h
      termsFrom = from - 86400;
      termsTo = from - 1;
    }

    // All Kommo API calls in parallel (each individually cached by client.ts)
    const termsDateFilter = { field: "closed_at" as const, from: termsFrom, to: termsTo };
    const [snapshotActiveLeads, tasks, wonLeads, lostLeads, callNotes, termsWonLeads] = await Promise.all([
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
    ]);

    // ─── Step 3: Build lead sets ───
    //
    // snapshotLeads = all active (current state) + period WON/LOST
    //   → for: activeDeals, a2, b1, b2plus, qualLeads, avgPortfolio
    //
    // flowLeads = active leads updated in period + period WON/LOST
    //   → for: tasksTotal, consultTotal, gutscheinsApproved, beraterReject, etc.
    //
    // Flow leads are derived from snapshot by filtering updated_at — no extra API call.

    const flowActiveLeads = snapshotActiveLeads.filter(
      (lead) => lead.updated_at >= from && lead.updated_at <= to
    );

    const snapshotLeads = [...snapshotActiveLeads, ...wonLeads, ...lostLeads];
    const flowLeads = [...flowActiveLeads, ...wonLeads, ...lostLeads];

    // ─── Step 4: Aggregate ───
    const callMetricsMap = aggregateCallMetrics(callNotes);
    const leadMetricsMap = aggregateLeadMetrics(snapshotLeads, from, to);
    const funnelCounts = aggregateLeadFunnelMetrics(snapshotLeads, flowLeads, from, to);
    const taskMetricsMap = aggregateTaskMetrics(tasks);

    // ─── Step 5: Plans lookup ───
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

      // Apply period divisor (monthly plan → day/week proportion)
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

    // ─── Step 6: Build response sections ───
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

      let totalActiveDeals = 0;
      let totalNewLeads = 0;
      for (const uid of sectionKommoUserIds) {
        const lm = leadMetricsMap.get(uid);
        if (lm) {
          totalActiveDeals += lm.activeDeals;
          totalNewLeads += lm.newLeads;
        }
      }

      let totalOverdue = 0;
      for (const uid of sectionKommoUserIds) {
        totalOverdue += taskMetricsMap.get(uid)?.overdueTasks ?? 0;
      }

      // Build summary metrics
      const summaryMetrics = section.metrics.map((metric) => {
        if (metric.isGroupHeader) {
          return { key: metric.key, label: metric.label, plan: null, fact: null, percent: null, isGroupHeader: true };
        }

        let plan = getPlan(section.dbLine, null, metric.key);
        let fact: string | null = null;

        // Computed plan for qualLeadsPercent = plan(qualLeads) / plan(totalLeads)
        if (metric.key === "qualLeadsPercent") {
          const planTotal = getPlan(section.dbLine, null, "totalLeads");
          const planQual = getPlan(section.dbLine, null, "qualLeads");
          if (planTotal && planQual && Number(planTotal) > 0) {
            plan = String(Math.round((Number(planQual) / Number(planTotal)) * 100));
          }
        }

        if (section.key === "funnel") {
          fact = getFunnelFact(metric.key, funnelCounts, managersOnLineCount, snapshotLeads, line1ManagerCount, termsWonLeads, from, to);
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
          // For %-based metrics, show difference rather than ratio of ratios
          if (metric.unit === "%") {
            percent = null; // don't show % of % — plan and fact are already percentages
          } else {
            percent = Math.round((Number(fact) / Number(plan)) * 100);
          }
        }

        return { key: metric.key, label: metric.label, plan, fact, percent, isGroupHeader: false };
      });

      // Per-manager data
      let managerData: Array<{
        id: string;
        name: string;
        kommoUserId: number | null;
        metrics: Array<{
          key: string;
          plan: string | null;
          fact: string | null;
          percent: number | null;
        }>;
      }> = [];

      // For funnel section: distribute totalLeads/qualLeads equally among line-1 managers
      if (section.key === "funnel") {
        const line1Managers = managers.filter((m) => m.line === "1");
        if (line1Managers.length > 0) {
          const splitKeys = new Set(["totalLeads", "qualLeads"]);
          managerData = line1Managers.map((mgr) => {
            const mgrMetrics = section.metrics
              .filter((m) => !m.isGroupHeader)
              .map((metric) => {
                let plan: string | null = null;
                let fact: string | null = null;
                let percent: number | null = null;

                if (splitKeys.has(metric.key)) {
                  // Divide total evenly
                  const totalFact = getFunnelFact(metric.key, funnelCounts, managersOnLineCount, snapshotLeads, line1ManagerCount, termsWonLeads, from, to);
                  const totalPlan = getPlan(section.dbLine, null, metric.key);
                  if (totalFact) fact = String(Math.round(Number(totalFact) / line1Managers.length));
                  if (totalPlan) plan = String(Math.round(Number(totalPlan) / line1Managers.length));
                  if (plan && fact && Number(plan) > 0) {
                    percent = Math.round((Number(fact) / Number(plan)) * 100);
                  }
                } else if (metric.key === "qualLeadsPercent") {
                  // Same % for all managers (computed from totals)
                  const totalFact = getFunnelFact("qualLeadsPercent", funnelCounts, managersOnLineCount, snapshotLeads, line1ManagerCount, termsWonLeads, from, to);
                  const planTotal = getPlan(section.dbLine, null, "totalLeads");
                  const planQual = getPlan(section.dbLine, null, "qualLeads");
                  fact = totalFact;
                  if (planTotal && planQual && Number(planTotal) > 0) {
                    plan = String(Math.round((Number(planQual) / Number(planTotal)) * 100));
                  }
                }

                return { key: metric.key, plan, fact, percent };
              });

            return { id: mgr.id, name: mgr.name, kommoUserId: mgr.kommoUserId, metrics: mgrMetrics };
          });
        }
      }

      if (section.perManager) {
        managerData = sectionManagers.map((mgr) => {
          const kommoId = mgr.kommoUserId;
          const mgrCallMetrics = kommoId ? callMetricsMap.get(kommoId) : undefined;
          const mgrOverdue = kommoId
            ? (taskMetricsMap.get(kommoId)?.overdueTasks ?? 0)
            : 0;
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

          return {
            id: mgr.id,
            name: mgr.name,
            kommoUserId: mgr.kommoUserId,
            metrics: mgrMetrics,
          };
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

    // Schedule info for day view
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
  to?: number
): string | null {
  switch (key) {
    case "activeDeals":
      return String(fc.activeDeals);
    case "termsTotal":
      // WON leads from first line (Термин ДЦ) — previous day or selected period
      return String(termsWonLeads?.length ?? 0);
    case "termsNew": {
      // Same as termsTotal but only leads created in period
      const tf = from ?? 0;
      const tt = to ?? Infinity;
      return String(
        (termsWonLeads || []).filter(
          (l) => l.created_at >= tf && l.created_at <= tt
        ).length
      );
    }
    case "managersOnLine":
      return String(managersOnLine);
    case "totalLeads":
      return String(fc.totalLeads);
    case "qualLeads":
      return String(fc.qualLeads);

    case "a2":
      return String(fc.a2);
    case "b1":
      return String(fc.b1);
    case "b2plus":
      return String(fc.b2plus);

    case "avgPortfolio": {
      // All deals in "Бух Гос" pipeline EXCLUDING: closed(143), won/термин ДЦ(142), база(93485479), отложенный старт(95514987)
      const excludeStatuses = new Set([142, 143, 93485479, 95514987]);
      const pipelineId = 10935879; // Бух Гос first line
      const portfolioLeads = (snapshotLeads || []).filter(
        (l) => l.pipeline_id === pipelineId && !l.is_deleted && !excludeStatuses.has(l.status_id)
      );
      const divisor = line1ManagerCount || managersOnLine || 1;
      return String(Math.round(portfolioLeads.length / divisor));
    }

    case "awaitTermTotal": {
      // Snapshot: leads currently awaiting term in berater pipeline
      const awaitStatuses = new Set([93860331, 102183931, 102183935, 102183939]);
      const beraterPipeline = 12154099;
      const awaiting = (snapshotLeads || []).filter(
        (l) => l.pipeline_id === beraterPipeline && !l.is_deleted && !l.closed_at && awaitStatuses.has(l.status_id)
      );
      return String(awaiting.length);
    }
    case "awaitTermNew": {
      // Flow: leads created in period that are currently awaiting term
      const awaitStatusesNew = new Set([93860331, 102183931, 102183935, 102183939]);
      const beraterPipelineNew = 12154099;
      const f = from ?? 0;
      const t = to ?? Infinity;
      const awaitingNew = (snapshotLeads || []).filter(
        (l) => l.pipeline_id === beraterPipelineNew && !l.is_deleted && !l.closed_at
          && awaitStatusesNew.has(l.status_id) && l.created_at >= f && l.created_at <= t
      );
      return String(awaitingNew.length);
    }

    case "qualLeadsPercent":
      // qualLeads / totalLeads (snapshot qual / period new leads)
      return fc.totalLeads > 0
        ? String(Math.round((fc.qualLeads / fc.totalLeads) * 100))
        : "0";
    case "convQualTask":
      // Conversion: qualified → task (docs sent). Both from flow set.
      return fc.qualLeadsFlow > 0
        ? String(Math.round(((fc.byMetric["tasksTotal"] ?? 0) / fc.qualLeadsFlow) * 100))
        : "0";
    case "convTaskConsult":
      return (fc.byMetric["tasksTotal"] ?? 0) > 0
        ? String(Math.round(((fc.byMetric["consultTotal"] ?? 0) / (fc.byMetric["tasksTotal"] ?? 1)) * 100))
        : "0";
    case "convConsultTerm":
      return (fc.byMetric["consultTotal"] ?? 0) > 0
        ? String(Math.round(((fc.byMetric["termsTotal"] ?? 0) / (fc.byMetric["consultTotal"] ?? 1)) * 100))
        : "0";

    default: {
      if (key in fc.byMetric) {
        return String(fc.byMetric[key]);
      }
      if (key in fc.byMetricNew) {
        return String(fc.byMetricNew[key]);
      }
      return null;
    }
  }
}
