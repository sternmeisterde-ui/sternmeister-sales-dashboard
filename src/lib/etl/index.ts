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
import { syncLeads, updateContactDates } from "./sync-leads";
import { syncCommunications } from "./sync-communications";
import { syncStatusChanges } from "./sync-status-changes";
import { syncTasks } from "./sync-tasks";
import { computeSla } from "./compute-sla";

export interface SyncOptions {
  fromDate: Date;
  toDate: Date;
  /** Skip individual tables if not needed */
  skip?: ("leads" | "communications" | "status_changes" | "tasks" | "sla")[];
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
  const skip = new Set(opts.skip ?? []);

  console.log(
    `[ETL] runSync from=${opts.fromDate.toISOString()} to=${opts.toDate.toISOString()}`,
  );

  const lookups = await fetchLookups();

  // Leads must always be synced first to build leadCache (needed for comms + status changes)
  let leadsCount = 0;
  let leadCache: Awaited<ReturnType<typeof syncLeads>> = [];

  if (!skip.has("leads")) {
    leadCache = await syncLeads(opts.fromDate, opts.toDate, lookups);
    leadsCount = leadCache.length;
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

  const slaRows = skip.has("sla")
    ? 0
    : await computeSla(opts.fromDate, opts.toDate);

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
