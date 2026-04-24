// ETL orchestrator — syncs Kommo data into analytics.* tables
//
// Run order:
//   1. fetchLookups      — pipelines, users, loss reasons from Kommo
//   2. syncLeads         — analytics.leads_cohort (creates leadCache)
//   3. syncCommunications — analytics.communications (uses contactIds from leadCache)
//   4. syncStatusChanges — analytics.lead_status_changes
//   5. syncTasks         — analytics.tasks
//   6. updateContactDates — back-fills leads_cohort.contact_date
//   7. computeSla        — analytics.sla (from leads_cohort + communications)

import { fetchLookups } from "./lookups";
import { syncLeads, updateContactDates, type LeadCacheEntry } from "./sync-leads";
import { syncCommunications } from "./sync-communications";
import { syncStatusChanges } from "./sync-status-changes";
import { syncTasks } from "./sync-tasks";
import { computeSla } from "./compute-sla";
import { analyticsDb } from "@/lib/db/analytics";
import { leadsCohort } from "@/lib/db/schema-analytics";
import { and, gte, lte } from "drizzle-orm";

/**
 * Load leadCache from analytics.leads_cohort — used when leads-sync is
 * skipped but downstream syncs (communications / status_changes / tasks)
 * still need per-lead metadata.
 */
async function loadLeadCacheFromDb(
  fromDate: Date,
  toDate: Date,
): Promise<LeadCacheEntry[]> {
  const rows = await analyticsDb
    .select()
    .from(leadsCohort)
    .where(and(gte(leadsCohort.createdAt, fromDate), lte(leadsCohort.createdAt, toDate)))
    .limit(100000);

  return rows.map((r): LeadCacheEntry => ({
    leadId: Number(r.leadId ?? 0),
    createdAt: r.createdAt ?? new Date(0),
    pipelineId: Number(r.pipelineId ?? 0),
    pipelineName: r.pipeline ?? "",
    statusId: Number(r.statusId ?? 0),
    statusName: r.status ?? "",
    statusOrder: Number(r.statusOrder ?? 0),
    category: r.category ?? null,
    manager: r.manager ?? null,
    responsibleUserId: Number(r.responsibleUserId ?? 0),
    contactIds: [], // not stored; empty ok for status_changes/tasks which don't use it
  }));
}

export interface SyncOptions {
  fromDate: Date;
  toDate: Date;
  /** Skip individual tables if not needed */
  skip?: ("leads" | "communications" | "status_changes" | "tasks" | "sla")[];
  /**
   * Incremental mode: fetches leads by updated_at (catches status changes / reassignments),
   * skips tasks (slow), skips status_changes (optional for speed).
   * Use for scheduled 10-min cron runs. Full backfill should use incremental=false.
   */
  incremental?: boolean;
}

export interface SyncResult {
  leads: number;
  communications: number;
  statusChanges: number;
  tasks: number;
  slaRows: number;
  durationMs: number;
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const t0 = Date.now();
  const incremental = opts.incremental ?? false;

  // In incremental mode: skip tasks (slow), use updated_at for leads
  const skip = new Set([
    ...(opts.skip ?? []),
    ...(incremental ? (["tasks", "status_changes"] as const) : []),
  ]);

  console.log(
    `[ETL] runSync mode=${incremental ? "incremental" : "full"} from=${opts.fromDate.toISOString()} to=${opts.toDate.toISOString()}`,
  );

  const lookups = await fetchLookups();

  // Leads must always be synced first to build leadCache (needed for comms + status changes)
  let leadsCount = 0;
  let leadCache: Awaited<ReturnType<typeof syncLeads>> = [];

  if (!skip.has("leads")) {
    // Incremental: fetch by updated_at so we catch status changes + reassignments too
    const dateField = incremental ? "updated_at" : "created_at";
    leadCache = await syncLeads(opts.fromDate, opts.toDate, lookups, dateField);
    leadsCount = leadCache.length;
  } else if (!skip.has("communications") || !skip.has("status_changes") || !skip.has("tasks")) {
    // Leads skipped but downstream syncs need per-lead metadata (responsibleUserId,
    // statusId, etc.). Reload lead cache from analytics.leads_cohort — no Kommo call.
    leadCache = await loadLeadCacheFromDb(opts.fromDate, opts.toDate);
    console.log(`[ETL] leadCache rehydrated from DB: ${leadCache.length} leads`);
  }

  const [commsCount, statusChangesCount] = await Promise.all([
    skip.has("communications")
      ? Promise.resolve(0)
      : syncCommunications(opts.fromDate, opts.toDate, leadCache, lookups),
    skip.has("status_changes")
      ? Promise.resolve(0)
      : syncStatusChanges(opts.fromDate, opts.toDate, leadCache, lookups),
  ]);

  const tasksCount = skip.has("tasks")
    ? 0
    : await syncTasks(leadCache, lookups);

  // Update contact_date on leads after communications are populated
  if (!skip.has("communications") && leadCache.length > 0) {
    await updateContactDates(leadCache.map((e) => e.leadId));
  }

  // Incremental: recompute SLA only for leads touched in this window (by ID, not by created_at).
  // Full: recompute SLA for all leads created in the date range.
  // Incremental: recompute SLA only for leads touched in this window (by ID, not by created_at).
  // Full: recompute SLA for all leads created in the date range.
  const filterLeadIds = incremental && leadCache.length > 0
    ? leadCache.map((e) => e.leadId)
    : undefined;

  const slaRows = skip.has("sla")
    ? 0
    : await computeSla(opts.fromDate, opts.toDate, filterLeadIds);

  const result: SyncResult = {
    leads: leadsCount,
    communications: commsCount,
    statusChanges: statusChangesCount,
    tasks: tasksCount,
    slaRows,
    durationMs: Date.now() - t0,
  };

  console.log(
    `[ETL] done in ${result.durationMs}ms —`,
    `leads=${result.leads}`,
    `comms=${result.communications}`,
    `status_changes=${result.statusChanges}`,
    `tasks=${result.tasks}`,
    `sla=${result.slaRows}`,
  );

  return result;
}
