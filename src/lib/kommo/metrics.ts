// Aggregate Kommo call notes into per-user call metrics
import type { KommoCallNote, KommoLead, KommoTask } from "./types";
import {
  FUNNEL_STATUS_MAP,
  NEW_VARIANTS_MAP,
  QUALIFIED_STATUSES,
  A2_STATUSES,
  B1_STATUSES,
  B2_PLUS_STATUSES,
} from "./pipeline-config";

export interface UserCallMetrics {
  kommoUserId: number;
  callsTotal: number;          // total outgoing calls
  callsConnected: number;      // connected calls (duration >= 1 sec)
  totalMinutes: number;        // total talk time in minutes
  avgDialogMinutes: number;    // avg duration per connected call (minutes)
  dialPercent: number;         // callsConnected / callsTotal * 100
  missedIncoming: number;      // missed incoming calls
  incomingTotal: number;       // total incoming calls
  outgoingTotal: number;       // total outgoing calls
}

export interface UserLeadMetrics {
  kommoUserId: number;
  activeDeals: number;         // leads in non-closed statuses
  newLeads: number;            // leads created in period
}

export interface UserTaskMetrics {
  kommoUserId: number;
  overdueTasks: number;
}

/** Department-wide lead funnel counts based on pipeline statuses */
export interface LeadFunnelCounts {
  activeDeals: number;
  totalLeads: number;
  /** Snapshot: leads currently in qualified stages (excludes closed WON/LOST) */
  qualLeads: number;
  /** Flow: leads created in period that are in qualified stages */
  qualLeadsNew: number;
  /** Flow: all leads in flow set that are in qualified stages (for conversion calc) */
  qualLeadsFlow: number;
  a2: number;
  b1: number;
  b2plus: number;
  /** Counts from FUNNEL_STATUS_MAP metric keys (total — all matching leads) */
  byMetric: Record<string, number>;
  /** Counts from NEW_VARIANTS_MAP (new — leads created within period only) */
  byMetricNew: Record<string, number>;
}

/**
 * Aggregate call notes by user (created_by = Kommo user ID).
 * Uses KommoCallNote from the Notes API which includes full params
 * (duration, call_status, phone, etc.) unlike the Events API.
 */
export function aggregateCallMetrics(notes: KommoCallNote[]): Map<number, UserCallMetrics> {
  const byUser = new Map<number, KommoCallNote[]>();

  for (const note of notes) {
    const userId = note.created_by;
    if (!byUser.has(userId)) byUser.set(userId, []);
    byUser.get(userId)!.push(note);
  }

  const result = new Map<number, UserCallMetrics>();

  for (const [userId, userNotes] of byUser) {
    const outgoing = userNotes.filter((n) => n.note_type === "call_out");
    const incoming = userNotes.filter((n) => n.note_type === "call_in");

    // Connected = duration >= 1 second
    const connectedOutgoing = outgoing.filter((n) => (n.params?.duration ?? 0) >= 1);
    const connectedIncoming = incoming.filter((n) => (n.params?.duration ?? 0) >= 1);

    // Missed incoming = call_status 3 (no_answer) or duration === 0
    const missed = incoming.filter((n) => {
      const status = n.params?.call_status;
      const duration = n.params?.duration ?? 0;
      return status === 3 || duration === 0;
    });

    // Total talk seconds across all connected calls (both in and out)
    const totalSeconds = [...connectedOutgoing, ...connectedIncoming]
      .reduce((sum, n) => sum + (n.params?.duration ?? 0), 0);

    const connectedCount = connectedOutgoing.length;
    const totalCalls = outgoing.length;

    result.set(userId, {
      kommoUserId: userId,
      callsTotal: totalCalls,
      callsConnected: connectedCount,
      totalMinutes: Math.round(totalSeconds / 60),
      avgDialogMinutes: connectedCount > 0
        ? Math.round((totalSeconds / connectedCount / 60) * 100) / 100
        : 0,
      dialPercent: totalCalls > 0
        ? Math.round((connectedCount / totalCalls) * 100)
        : 0,
      missedIncoming: missed.length,
      incomingTotal: incoming.length,
      outgoingTotal: outgoing.length,
    });
  }

  return result;
}

/**
 * Aggregate leads by responsible_user_id (per-user counts)
 */
export function aggregateLeadMetrics(
  leads: KommoLead[],
  periodStart: number,
  periodEnd: number
): Map<number, UserLeadMetrics> {
  const result = new Map<number, UserLeadMetrics>();

  for (const lead of leads) {
    const userId = lead.responsible_user_id;
    if (!result.has(userId)) {
      result.set(userId, { kommoUserId: userId, activeDeals: 0, newLeads: 0 });
    }
    const m = result.get(userId)!;

    // Active deal = not deleted and not in won/lost status
    if (!lead.is_deleted && !lead.closed_at) {
      m.activeDeals++;
    }

    // New lead = created within period
    if (lead.created_at >= periodStart && lead.created_at <= periodEnd) {
      m.newLeads++;
    }
  }

  return result;
}

/**
 * Aggregate leads into funnel counts using two lead sets:
 *
 * @param snapshotLeads — ALL active leads (no date filter) + period-filtered WON/LOST.
 *   Used for **snapshot** metrics: activeDeals, a2, b1, b2plus, qualLeads.
 *
 * @param flowLeads — Active leads updated in period + period-filtered WON/LOST.
 *   Used for **flow** metrics: byMetric counts (tasksTotal, consultTotal, etc.),
 *   byMetricNew ("new" variants), totalLeads, gutscheinsApproved, beraterReject.
 *
 * This split ensures:
 *  - Snapshot metrics (how many leads sit at each stage NOW) are always accurate
 *  - Flow metrics (what happened DURING the period) respect the date filter
 */
export function aggregateLeadFunnelMetrics(
  snapshotLeads: KommoLead[],
  flowLeads: KommoLead[],
  periodStart: number,
  periodEnd: number
): LeadFunnelCounts {
  const counts: LeadFunnelCounts = {
    activeDeals: 0,
    totalLeads: 0,
    qualLeads: 0,
    qualLeadsNew: 0,
    qualLeadsFlow: 0,
    a2: 0,
    b1: 0,
    b2plus: 0,
    byMetric: {},
    byMetricNew: {},
  };

  // Initialize all metric keys to 0
  for (const key of Object.keys(FUNNEL_STATUS_MAP)) {
    counts.byMetric[key] = 0;
  }
  for (const key of Object.keys(NEW_VARIANTS_MAP)) {
    counts.byMetricNew[key] = 0;
  }

  // ─── Pass 1: Snapshot leads → state-based counts ───
  for (const lead of snapshotLeads) {
    if (lead.is_deleted) continue;

    // Active deal = not closed
    if (!lead.closed_at) {
      counts.activeDeals++;
    }

    // Qualification stages — only for active pipeline leads (exclude closed WON=142 / LOST=143).
    // WON/LOST leads are in snapshotLeads for result metrics (gutscheins, reject)
    // but should NOT inflate qualification counts which represent current pipeline state.
    if (lead.status_id !== 142 && lead.status_id !== 143) {
      if (QUALIFIED_STATUSES.has(lead.status_id)) counts.qualLeads++;
      if (A2_STATUSES.has(lead.status_id)) counts.a2++;
      if (B1_STATUSES.has(lead.status_id)) counts.b1++;
      if (B2_PLUS_STATUSES.has(lead.status_id)) counts.b2plus++;
    }
  }

  // ─── Pass 2: Flow leads → period-based counts ───
  for (const lead of flowLeads) {
    if (lead.is_deleted) continue;

    const isNew = lead.created_at >= periodStart && lead.created_at <= periodEnd;

    // New lead = created within period
    if (isNew) {
      counts.totalLeads++;
      // New qualified lead = created in period AND currently in qualified status
      if (QUALIFIED_STATUSES.has(lead.status_id)) {
        counts.qualLeadsNew++;
      }
    }

    // All qualified leads in flow set (for conversion calculations like qual→task)
    if (QUALIFIED_STATUSES.has(lead.status_id)) {
      counts.qualLeadsFlow++;
    }

    // Count by FUNNEL_STATUS_MAP — "total" counts (leads in these statuses during period)
    for (const [metricKey, config] of Object.entries(FUNNEL_STATUS_MAP)) {
      if (config.pipelineIds && !config.pipelineIds.includes(lead.pipeline_id)) continue;
      if (config.statusIds.has(lead.status_id)) {
        counts.byMetric[metricKey] = (counts.byMetric[metricKey] ?? 0) + 1;
      }
    }

    // Count "new" variants — same status match but only leads created in period
    if (isNew) {
      for (const [newKey, totalKey] of Object.entries(NEW_VARIANTS_MAP)) {
        const config = FUNNEL_STATUS_MAP[totalKey];
        if (!config) continue;
        if (config.pipelineIds && !config.pipelineIds.includes(lead.pipeline_id)) continue;
        if (config.statusIds.has(lead.status_id)) {
          counts.byMetricNew[newKey] = (counts.byMetricNew[newKey] ?? 0) + 1;
        }
      }
    }
  }

  return counts;
}

/**
 * Count overdue tasks per user
 */
export function aggregateTaskMetrics(tasks: KommoTask[]): Map<number, UserTaskMetrics> {
  const now = Math.floor(Date.now() / 1000);
  const result = new Map<number, UserTaskMetrics>();

  for (const task of tasks) {
    if (task.is_completed) continue;
    if (task.complete_till > now) continue; // not overdue yet

    const userId = task.responsible_user_id;
    if (!result.has(userId)) {
      result.set(userId, { kommoUserId: userId, overdueTasks: 0 });
    }
    result.get(userId)!.overdueTasks++;
  }

  return result;
}

/**
 * Sum multiple UserCallMetrics into a department summary
 */
export function sumCallMetrics(metrics: UserCallMetrics[]): UserCallMetrics {
  const sum: UserCallMetrics = {
    kommoUserId: 0,
    callsTotal: 0,
    callsConnected: 0,
    totalMinutes: 0,
    avgDialogMinutes: 0,
    dialPercent: 0,
    missedIncoming: 0,
    incomingTotal: 0,
    outgoingTotal: 0,
  };

  for (const m of metrics) {
    sum.callsTotal += m.callsTotal;
    sum.callsConnected += m.callsConnected;
    sum.totalMinutes += m.totalMinutes;
    sum.missedIncoming += m.missedIncoming;
    sum.incomingTotal += m.incomingTotal;
    sum.outgoingTotal += m.outgoingTotal;
  }

  sum.dialPercent = sum.callsTotal > 0
    ? Math.round((sum.callsConnected / sum.callsTotal) * 100)
    : 0;
  sum.avgDialogMinutes = sum.callsConnected > 0
    ? Math.round((sum.totalMinutes / sum.callsConnected) * 100) / 100
    : 0;

  return sum;
}
