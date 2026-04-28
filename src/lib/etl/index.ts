// ETL orchestrator — syncs Kommo data into analytics.* tables
//
// Run order:
//   1. fetchLookups        — pipelines, users, loss reasons from Kommo
//   2. syncLeads           — analytics.leads_cohort (creates leadCache)
//   3. syncCommunications  — analytics.communications (Kommo-source rows)
//   4. syncStatusChanges   — analytics.lead_status_changes
//   5. syncTasks           — analytics.tasks
//   6. updateContactDates  — back-fills leads_cohort.contact_date
//   7. syncTelephony       — analytics.communications dial-attempt rows from
//                            CallGear/CloudTalk (auto-skipped if CALLGEAR_ACCESS_TOKEN absent)
//   8. enrichTelephonyLeads — phone→lead resolution, fan-out raw telephony
//                            rows into per-lead copies (Pattern A from
//                            docs/mysql-analytics.md). Skipped if no
//                            KOMMO_ACCESS_TOKEN OR no telephony in step 7.
//   9. computeSla          — analytics.sla (from leads_cohort + enriched
//                            communications). Last so it sees both Kommo
//                            and telephony rows with real lead_ids.

import { fetchLookups } from "./lookups";
import { syncLeads, updateContactDates, type LeadCacheEntry } from "./sync-leads";
import { syncCommunications } from "./sync-communications";
import { syncStatusChanges } from "./sync-status-changes";
import { syncTasks } from "./sync-tasks";
import { computeSla } from "./compute-sla";
import { syncTelephony } from "./sync-telephony";
import { enrichTelephonyLeads } from "./enrich-telephony-leads";
import { analyticsDb } from "@/lib/db/analytics";
import { leadsCohort } from "@/lib/db/schema-analytics";
import { and, gte, lte, sql } from "drizzle-orm";

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
  skip?: ("leads" | "communications" | "status_changes" | "tasks" | "sla" | "telephony")[];
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
  telephonyLegs: number;
  /** Telephony rows that received a real lead_id during this run */
  telephonyRowsLinked: number;
  /** Additional rows INSERTed by enrichment fan-out (one per extra lead) */
  telephonyRowsFannedOut: number;
  durationMs: number;
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const t0 = Date.now();
  const incremental = opts.incremental ?? false;

  // In incremental mode: skip tasks (slow — pulls all open tasks per lead).
  // Status_changes USED to be skipped here too, but the Termin dashboard
  // depends on TERM_DC_DONE event timestamps for its AA-baseline formula —
  // without per-tick syncing the AA average drifts upward (falls back to
  // created_at instead of dt(TERM_DC_DONE)). The Kommo /events endpoint
  // supports filter[created_at][from/to], so a 15-min window pulls ~25
  // events on average — negligible cost. (2026-04-28)
  const skip = new Set([
    ...(opts.skip ?? []),
    ...(incremental ? (["tasks"] as const) : []),
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

  // Telephony first — its DELETE-then-INSERT wipes both legacy non-prefix
  // call rows and prior cg-leg/ct rows in the window so re-runs are clean.
  // Auto-skipped when no provider creds. CallGear and CloudTalk are
  // independent — either presence enables the step (each provider fetcher
  // self-skips when its own creds are missing).
  let telephonyLegs = 0;
  const hasTelephonyCreds =
    !!process.env.CALLGEAR_ACCESS_TOKEN || !!process.env.CLOUDTALK_API_ID;
  if (!skip.has("telephony") && hasTelephonyCreds) {
    try {
      const telRes = await syncTelephony(opts.fromDate, opts.toDate);
      telephonyLegs = telRes.inserted;
    } catch (err) {
      // Don't fail the whole ETL — telephony is additive coverage; on error
      // we still ship the Kommo-sourced rows that already landed.
      console.error(
        `[ETL] sync-telephony failed (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    }
  } else if (!skip.has("telephony")) {
    console.log(
      "[ETL] sync-telephony: skipped (no CALLGEAR_ACCESS_TOKEN nor CLOUDTALK_API_ID set)",
    );
  }

  // Enrichment turns raw telephony rows (lead_id=NULL) into per-lead rows
  // by resolving phone → contact → leads via Kommo and fanning out one row
  // per matched lead (Pattern A — docs/mysql-analytics.md). Runs only when
  // telephony was attempted in this window AND a Kommo token is available.
  // Non-fatal on error: SLA + the raw rows still ship.
  let telephonyRowsLinked = 0;
  let telephonyRowsFannedOut = 0;
  const enrichmentLeadIds: number[] = [];
  if (!skip.has("telephony") && hasTelephonyCreds) {
    try {
      const enrichRes = await enrichTelephonyLeads(opts.fromDate, opts.toDate);
      telephonyRowsLinked = enrichRes.rowsLinked;
      telephonyRowsFannedOut = enrichRes.rowsFannedOut;
      // Capture the leads that just got linked so the SLA step picks them up
      // even if their lead_created_at is outside this window.
      if (enrichRes.rowsLinked > 0 || enrichRes.rowsFannedOut > 0) {
        const linked = await analyticsDb.execute<{ lead_id: number | string }>(sql`
          SELECT DISTINCT lead_id
          FROM analytics.communications
          WHERE communication_type LIKE 'call%'
            AND lead_id IS NOT NULL
            AND created_at >= ${opts.fromDate}
            AND created_at <= ${opts.toDate}
        `);
        for (const r of linked.rows) enrichmentLeadIds.push(Number(r.lead_id));
      }
    } catch (err) {
      console.error(
        `[ETL] enrich-telephony-leads failed (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // SLA last — sees both Kommo-source rows AND newly enriched telephony
  // rows. Incremental mode unions leadCache (created in window) with the
  // leads that just received a telephony call so SLA recomputes for both.
  let filterLeadIds: number[] | undefined;
  if (incremental) {
    const ids = new Set<number>(leadCache.map((e) => e.leadId));
    for (const id of enrichmentLeadIds) ids.add(id);
    filterLeadIds = ids.size > 0 ? Array.from(ids) : undefined;
  }

  const slaRows = skip.has("sla")
    ? 0
    : await computeSla(opts.fromDate, opts.toDate, filterLeadIds);

  const result: SyncResult = {
    leads: leadsCount,
    communications: commsCount,
    statusChanges: statusChangesCount,
    tasks: tasksCount,
    slaRows,
    telephonyLegs,
    telephonyRowsLinked,
    telephonyRowsFannedOut,
    durationMs: Date.now() - t0,
  };

  console.log(
    `[ETL] done in ${result.durationMs}ms —`,
    `leads=${result.leads}`,
    `comms=${result.communications}`,
    `status_changes=${result.statusChanges}`,
    `tasks=${result.tasks}`,
    `telephony=${result.telephonyLegs}`,
    `linked=${result.telephonyRowsLinked}`,
    `fannedOut=${result.telephonyRowsFannedOut}`,
    `sla=${result.slaRows}`,
  );

  return result;
}
