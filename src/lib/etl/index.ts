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
//
//   Side step: syncClientRoleplays — mirrors OKK client-roleplay scores
//   (D2 client_evaluations) → analytics.client_roleplays. Independent of
//   leadCache; auto-skipped without D2_OKK_DATABASE_URL.

import { fetchLookups } from "./lookups";
import { syncLeads, updateContactDates, type LeadCacheEntry } from "./sync-leads";
import { syncContacts } from "./sync-contacts";
import { syncCommunications } from "./sync-communications";
import { syncStatusChanges } from "./sync-status-changes";
import { syncCloseReasonChanges } from "./sync-close-reason-changes";
import { syncResponsibleChanges } from "./sync-responsible-changes";
import { syncLeadDeletions } from "./sync-lead-deletions";
import { syncClientRoleplays } from "./sync-client-roleplays";
import { syncBotRoleplays, syncBotUsers } from "./sync-bot-roleplays";
import { syncTasks } from "./sync-tasks";
import { computeSla } from "./compute-sla";
import { detectWonExports } from "./detect-won-exports";
import { syncTelephony, type TelephonyProvider } from "./sync-telephony";
import { enrichTelephonyLeads } from "./enrich-telephony-leads";
import { analyticsDb } from "@/lib/db/analytics";
import { leadsCohort } from "@/lib/db/schema-analytics";
import { and, gte, lte, sql } from "drizzle-orm";
import { captureEtlException } from "./sentry";
import { withDbRetry } from "@/lib/db/with-retry";

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
  skip?: ("leads" | "contacts" | "communications" | "status_changes" | "tasks" | "sla" | "telephony" | "close_reason_changes" | "responsible_changes" | "lead_deletions" | "client_roleplays" | "bot_roleplays" | "detect-exports")[];
  /**
   * Incremental mode: fetches leads by updated_at (catches status changes / reassignments),
   * skips tasks (slow), skips status_changes (optional for speed).
   * Use for scheduled 10-min cron runs. Full backfill should use incremental=false.
   */
  incremental?: boolean;
  /**
   * Restrict telephony providers in this run. Default = both. The 10-min
   * cron passes `["cloudtalk"]` because CallGear's API embargoes data for
   * ~6 hours; a separate hourly job (`/api/analytics/sync/callgear`)
   * pulls CallGear on a 7h+ lag.
   */
  telephonyProviders?: TelephonyProvider[];
  /**
   * Telephony-only lookback override: syncTelephony runs on
   * [telephonyFromDate, toDate] instead of [fromDate, toDate]. Lets the
   * 10-min cron sweep a wide telephony window (self-healing after
   * failed/skipped ticks) without widening the Kommo-facing steps.
   * Combine with telephonySkipExisting so the sweep only ADDS missing
   * CDRs. История: 2026-07 нашли ~1%/нед. потерь CloudTalk — окна
   * упавших тиков никто не перечитывал.
   */
  telephonyFromDate?: Date;
  /** Pass-through to syncTelephony.skipExisting (см. док там). */
  telephonySkipExisting?: boolean;
}

export interface SyncResult {
  leads: number;
  contacts: number;
  communications: number;
  statusChanges: number;
  tasks: number;
  slaRows: number;
  telephonyLegs: number;
  /** Telephony rows that received a real lead_id during this run */
  telephonyRowsLinked: number;
  /** Additional rows INSERTed by enrichment fan-out (one per extra lead) */
  telephonyRowsFannedOut: number;
  /** B2B won/installment leads newly queued for Google Drive call export. */
  exportsQueued: number;
  durationMs: number;
  /** Steps that threw — each kept the rest of the pipeline alive. */
  stepErrors: { step: string; message: string }[];
}

/**
 * Run an ETL step in isolation. Errors are caught, logged, recorded into
 * `errors`, and a fallback value is returned so the rest of the pipeline
 * proceeds. Used for every step whose failure should not cascade — i.e.,
 * everything except `fetchLookups` (we cannot run without lookups) and
 * `syncLeads` (downstream needs the lead cache; they can rehydrate from
 * DB but a hard fetch failure already produced a Kommo error we want to
 * surface).
 */
async function runStep<T>(
  name: string,
  fn: () => Promise<T>,
  fallback: T,
  errors: { step: string; message: string }[],
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ETL] ${name} failed (non-fatal):`, err);
    errors.push({ step: name, message });
    // Send to Sentry with ETL tags so the event is filterable
    // (`component:etl, step:<name>, severity:non_fatal`) on the existing
    // dashboard or, later, a dedicated ETL project. Non_fatal because the
    // pipeline keeps running — but we want the signal even when the cron's
    // outer try/catch sees no exception.
    captureEtlException(err, { step: name, severity: "non_fatal" });
    return fallback;
  }
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const t0 = Date.now();
  const incremental = opts.incremental ?? false;
  const stepErrors: { step: string; message: string }[] = [];

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

  // fetchLookups is the only step that can't be isolated — every downstream
  // step needs `lookups` (pipelines, users, refusal enums). If Kommo is hard
  // down, the run aborts; that's the correct behaviour.
  const lookups = await fetchLookups();

  // Leads must always be synced first to build leadCache (needed for comms + status changes).
  // Wrapped in runStep so a transient Kommo failure here doesn't kill the whole run —
  // we fall back to rehydrating leadCache from analytics.leads_cohort and proceed.
  let leadsCount = 0;
  let leadCache: Awaited<ReturnType<typeof syncLeads>> = [];

  if (!skip.has("leads")) {
    const dateField = incremental ? "updated_at" : "created_at";
    leadCache = await runStep(
      "sync-leads",
      () => syncLeads(opts.fromDate, opts.toDate, lookups, dateField),
      [],
      stepErrors,
    );
    leadsCount = leadCache.length;
    if (leadCache.length === 0 && stepErrors.some((e) => e.step === "sync-leads")) {
      // Leads-fetch crashed — rehydrate from DB so downstream syncs still run.
      leadCache = await loadLeadCacheFromDb(opts.fromDate, opts.toDate);
      console.log(`[ETL] leadCache rehydrated from DB after sync-leads error: ${leadCache.length} leads`);
    }
  } else if (!skip.has("communications") || !skip.has("status_changes") || !skip.has("tasks")) {
    // Leads skipped but downstream syncs need per-lead metadata (responsibleUserId,
    // statusId, etc.). Reload lead cache from analytics.leads_cohort — no Kommo call.
    leadCache = await loadLeadCacheFromDb(opts.fromDate, opts.toDate);
    console.log(`[ETL] leadCache rehydrated from DB: ${leadCache.length} leads`);
  }

  // Sync contacts referenced by the leads we just synced. Uses
  // contactIds from leadCache, so it must run after sync-leads. Skipped
  // when leadCache was rehydrated from DB (contactIds are empty there)
  // or when explicitly disabled. Adds ~1 Kommo request per 250 unique
  // contact IDs at the configured 1 rps.
  let contactsCount = 0;
  if (!skip.has("contacts") && leadCache.length > 0 && leadCache.some((e) => e.contactIds.length > 0)) {
    contactsCount = await runStep(
      "sync-contacts",
      () => syncContacts(leadCache),
      0,
      stepErrors,
    );
  }

  // Comms + status_changes were `Promise.all`'d before — but `Promise.all`
  // rejects on the first failure and orphans the other branch. We now run
  // each in its own runStep so one falling over (e.g., the 2026-04-30 13:57Z
  // crash on the partial-unique-index conflict) doesn't take the rest of the
  // pipeline with it. They still run concurrently because each runStep
  // returns a Promise we await together.
  const [commsCount, statusChangesCount] = await Promise.all([
    skip.has("communications")
      ? Promise.resolve(0)
      : runStep(
          "sync-communications",
          () => syncCommunications(opts.fromDate, opts.toDate, leadCache, lookups),
          0,
          stepErrors,
        ),
    skip.has("status_changes")
      ? Promise.resolve(0)
      : runStep(
          "sync-status-changes",
          () => syncStatusChanges(opts.fromDate, opts.toDate, leadCache, lookups),
          0,
          stepErrors,
        ),
  ]);

  const tasksCount = skip.has("tasks")
    ? 0
    : await runStep(
        "sync-tasks",
        () => syncTasks(leadCache, lookups),
        0,
        stepErrors,
      );

  // Close-reason history (CFV 879824 transitions) — нужна Funnel'у для точного
  // disqualified_at. 1 req/sec вне основной плотности — добавляет 5-15s к тику.
  if (!skip.has("close_reason_changes")) {
    await runStep(
      "sync-close-reason-changes",
      () => syncCloseReasonChanges(opts.fromDate, opts.toDate),
      0,
      stepErrors,
    );
  }

  // Смены ответственного — нужны вкладке «Регламент» (периоды ответственности:
  // Время на этапах/TLT/SLA считаются от передачи лида). Идемпотентный upsert
  // по event_id; окно то же, что у остальных инкрементальных шагов.
  if (!skip.has("responsible_changes")) {
    await runStep(
      "sync-responsible-changes",
      () => syncResponsibleChanges(opts.fromDate, opts.toDate),
      0,
      stepErrors,
    );
  }

  // Lead deletions — помечает удалённые в Kommo лиды как is_deleted=TRUE.
  // Funnel Dashboard их исключает из base (как cohort-conversion).
  if (!skip.has("lead_deletions")) {
    await runStep(
      "sync-lead-deletions",
      () => syncLeadDeletions(opts.fromDate, opts.toDate),
      0,
      stepErrors,
    );
  }

  // Client roleplays — зеркалит объективные оценки клиентских ролевок из ОКК
  // (D2 client_evaluations, roleplay_present=true) в analytics.client_roleplays.
  // Не нужен leadCache — ключуется по kommo_lead_id. Окно по eval.created_at.
  // Авто-skip если D2_OKK_DATABASE_URL не задан.
  if (!skip.has("client_roleplays")) {
    await runStep(
      "sync-client-roleplays",
      () => syncClientRoleplays(opts.fromDate, opts.toDate),
      0,
      stepErrors,
    );
  }

  // Bot roleplays — зеркалит тренировки клиентов с ботом (berater_bot Neon, ЗАСЫПАЕТ
  // при простое) в analytics.bot_roleplays. Full sync (таблица мала), авто-skip без
  // BERATER_BOT_DATABASE_URL. Убирает живую зависимость «Клиентов» от спящей бот-БД.
  if (!skip.has("bot_roleplays")) {
    await runStep("sync-bot-roleplays", () => syncBotRoleplays(), 0, stepErrors);
    // Регистрации пользователей бота → analytics.bot_users (отличать «в боте, 0
    // тренировок» от «не в боте»). Тот же триггер/skip, что и сессии.
    await runStep("sync-bot-users", () => syncBotUsers(), 0, stepErrors);
  }

  // Update contact_date on leads after communications are populated.
  if (!skip.has("communications") && leadCache.length > 0) {
    await runStep(
      "update-contact-dates",
      () => updateContactDates(leadCache.map((e) => e.leadId)),
      undefined,
      stepErrors,
    );
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
    const telRes = await runStep(
      "sync-telephony",
      () => syncTelephony(opts.telephonyFromDate ?? opts.fromDate, opts.toDate, {
        providers: opts.telephonyProviders,
        skipExisting: opts.telephonySkipExisting,
      }),
      {
        callgearLegs: 0,
        cloudtalkCalls: 0,
        unmatchedAgents: [] as { source: "callgear" | "cloudtalk"; agentId: string; name: string; count: number }[],
        inserted: 0,
      },
      stepErrors,
    );
    telephonyLegs = telRes.inserted;
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
    // In incremental mode (15-min cron), Kommo may not have the contact
    // for a phone yet at first attempt — without sweep we'd never retry.
    // 7-day lookback re-tries every still-unenriched call so cron is
    // self-healing. In full mode the caller controls fromDate already.
    const enrichRes = await runStep(
      "enrich-telephony-leads",
      () =>
        incremental
          ? enrichTelephonyLeads(opts.fromDate, opts.toDate, { lookbackDays: 7 })
          : enrichTelephonyLeads(opts.fromDate, opts.toDate),
      {
        scannedRows: 0,
        phonesQueried: 0,
        phonesResolved: 0,
        rowsLinked: 0,
        rowsFannedOut: 0,
        unresolvedPhones: [] as string[],
        backlogRemaining: 0,
      },
      stepErrors,
    );
    telephonyRowsLinked = enrichRes.rowsLinked;
    telephonyRowsFannedOut = enrichRes.rowsFannedOut;
    // Capture the leads that just got linked so the SLA step picks them up
    // even if their lead_created_at is outside this window. In incremental
    // mode the enrichment swept 7 days back, so widen the lookup too —
    // otherwise SLA misses leads enriched from older windows.
    if (enrichRes.rowsLinked > 0 || enrichRes.rowsFannedOut > 0) {
      const linkedFromDate = incremental
        ? new Date(opts.toDate.getTime() - 7 * 24 * 60 * 60 * 1000)
        : opts.fromDate;
      // Inline try/catch — runStep's generic signature can't carry Neon's
      // full QueryResult type cleanly, and we only need `.rows` here.
      // Wrapped in withDbRetry: this SELECT used to abort on transient Neon
      // HTTP hiccups (DASHBOARD-J root), dropping enrichment-linked leads
      // from the SLA recompute. Retries are cheap (max 3 attempts × 6s) and
      // an aborted call here means the next cron tick re-enriches in 10 min,
      // so we accept the cost to keep SLA in sync.
      try {
        const linked = await withDbRetry(
          () => analyticsDb.execute<{ lead_id: number | string }>(sql`
            SELECT DISTINCT lead_id
            FROM analytics.communications
            WHERE communication_type LIKE 'call%'
              AND lead_id IS NOT NULL
              AND created_at >= ${linkedFromDate}
              AND created_at <= ${opts.toDate}
          `),
          { label: "etl:collect-linked-ids" },
        );
        for (const r of linked.rows) enrichmentLeadIds.push(Number(r.lead_id));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[ETL] collect-linked-ids failed (non-fatal):", err);
        stepErrors.push({ step: "enrich-telephony-leads:collect-linked-ids", message });
      }
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
    : await runStep(
        "compute-sla",
        () => computeSla(opts.fromDate, opts.toDate, filterLeadIds),
        0,
        stepErrors,
      );

  // Очередь выгрузки звонков на Drive: B2B-сделки, попавшие в Рассрочка/WON.
  // Лёгкий шаг (SELECT+INSERT), не зависит от Kommo-окна — гоняем каждый тик.
  // Тяжёлую работу (скачать+залить) делает воркер /api/exports/process/tick.
  const exportsQueued = skip.has("detect-exports")
    ? 0
    : await runStep("detect-won-exports", () => detectWonExports(), 0, stepErrors);

  const result: SyncResult = {
    leads: leadsCount,
    contacts: contactsCount,
    communications: commsCount,
    statusChanges: statusChangesCount,
    tasks: tasksCount,
    slaRows,
    telephonyLegs,
    telephonyRowsLinked,
    telephonyRowsFannedOut,
    exportsQueued,
    durationMs: Date.now() - t0,
    stepErrors,
  };

  console.log(
    `[ETL] done in ${result.durationMs}ms —`,
    `leads=${result.leads}`,
    `contacts=${result.contacts}`,
    `comms=${result.communications}`,
    `status_changes=${result.statusChanges}`,
    `tasks=${result.tasks}`,
    `telephony=${result.telephonyLegs}`,
    `linked=${result.telephonyRowsLinked}`,
    `fannedOut=${result.telephonyRowsFannedOut}`,
    `sla=${result.slaRows}`,
    `exportsQueued=${result.exportsQueued}`,
    `stepErrors=${stepErrors.length}`,
  );

  return result;
}
