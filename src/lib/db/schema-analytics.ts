// Analytics DB schema — mirror of the 3rd-party integrator's MySQL (45.156.25.84/db)
// so we can reproduce Looker dashboards in our own stack. Cross-check target:
// `report_sternmeister_custom_report` and `report_sternmeister_funnel`.
//
// Types: MySQL TINYINT→smallint, DATETIME→timestamp, DOUBLE→doublePrecision,
// TEXT→text. Timestamps stored in UTC; the app converts to Europe/Berlin on read.

import {
  pgSchema,
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const analyticsSchema = pgSchema("analytics");

// ==================== DATASOURCE ====================

export const leadsCohort = analyticsSchema.table(
  "leads_cohort",
  {
    leadId: bigint("lead_id", { mode: "number" }),
    createdAt: timestamp("created_at"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),
    lossReason: text("loss_reason"),
    lossReasonId: bigint("loss_reason_id", { mode: "number" }),
    pipeline: text("pipeline"),
    pipelineId: bigint("pipeline_id", { mode: "number" }),
    status: text("status"),
    statusId: bigint("status_id", { mode: "number" }),
    statusOrder: integer("status_order"),
    budget: doublePrecision("budget"),
    contactDate: timestamp("contact_date"),
    manager: text("manager"),
    responsibleUserId: bigint("responsible_user_id", { mode: "number" }),
    category: text("category"),
    // B2B Commerce payment tracking (Kommo custom fields, per ТЗ R24).
    // Pulled by field-name from lead.custom_fields_values in sync-leads.
    closedAt: timestamp("closed_at"),
    firstPaymentDate: timestamp("first_payment_date"),
    firstPaymentAmount: doublePrecision("first_payment_amount"),
    prepaymentDate: timestamp("prepayment_date"),
    prepaymentAmount: doublePrecision("prepayment_amount"),
    // B2G non-qual categorisation (Kommo custom field 879824 enum_id).
    // enum_ids: 744486 Неправильный номер, 744876/747530/747532/747534/747536 Неквал.*
    nonQualEnumId: bigint("non_qual_enum_id", { mode: "number" }),
    // B2B closing-reason categorisation (Kommo custom field 876383 enum_id).
    // Required by Kommo at status_id=143 on pipelines 10631243 (Бух Комм) and
    // 13209983 (Мед Комм) — distinct from the standard loss_reason_id which
    // managers leave NULL on this account. Drives Looker SLA gate, where
    // {740587 Неквал лид, 740593 Спам, 740595 Предложение сотрудничества}
    // drop a lead-call pair from the SLA AVG. See migration 0007.
    b2bCloseReasonEnumId: bigint("b2b_close_reason_enum_id", { mode: "number" }),
    // Termin dashboard (Бух Бератер pipeline). Looked up by field_id in
    // sync-leads — see B2G_CUSTOM_FIELD_IDS.terminDateDC / terminDateAA.
    // Added in migration 0006_termin_dates.sql.
    terminDate: timestamp("termin_date"),
    aaTerminDate: timestamp("aa_termin_date"),
    // FIRST observed value of each termin date (write-once at the row level
    // — sync-leads.ts pre-fetches existing values on every resync and only
    // writes them if currently NULL). Powers the planning dashboard's
    // "первая запланированная дата" metric — termin_date itself drifts on
    // every reschedule, so the original commitment would otherwise be lost.
    // Added in migration 0013_termin_first_dates.sql.
    terminDateFirst: timestamp("termin_date_first"),
    aaTerminDateFirst: timestamp("aa_termin_date_first"),
    // Kommo CFV 869928 ("LANGUAGE_LEVEL") — текст вроде "A2 (Базовый уровень)
    // — Свободно...". Используется Funnel Dashboard для раскладки когорт по
    // уровню языка. Добавлено в 0019_leads_cohort_language_level.sql.
    languageLevel: text("language_level"),
    // Kommo CFV 887458 ("Исключить из аналитики"). Если TRUE, лид выпадает
    // из всех расчётов Funnel. Добавлено в 0020_leads_cohort_funnel_extras.sql.
    excludeFromAnalytics: boolean("exclude_from_analytics").default(false).notNull(),
    // Reserved: earliest event_at в QUAL_FIRST_LINE_STATUSES. Currently unused
    // — Funnel использует created_at как anchor (совпадает с qualification.py
    // cohort-conversion). Колонка зарезервирована для будущего refactor'а.
    firstQualificationAt: timestamp("first_qualification_at"),
    // Snapshot lead.updated_at из Kommo. Fallback для disqualified_at когда
    // в lead_close_reason_changes нет точной даты события.
    updatedAt: timestamp("updated_at"),
    // Лид удалён в Kommo. Funnel Dashboard исключает таких из base.
    // Заполняется ETL-шагом sync-lead-deletions из Kommo /events
    // (lead_deleted). Добавлено в 0022_leads_cohort_is_deleted.sql.
    isDeleted: boolean("is_deleted").default(false).notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    index().on(t.leadId),
    index().on(t.createdAt),
    index().on(t.pipeline, t.status),
    // Optimises Daily Commerce fact queries (ТЗ R24/R28/R29):
    //   SUM by first_payment_date / prepayment_date ∈ period, per pipeline.
    index().on(t.pipelineId, t.firstPaymentDate),
    index().on(t.pipelineId, t.prepaymentDate),
    index().on(t.closedAt),
    // Phase 1 of Daily refactor (2026-04-24): added via hand-rolled migration
    // drizzle/analytics/0003_daily_hot_indexes.sql (CREATE INDEX CONCURRENTLY,
    // which Drizzle can't emit). Declared here so schema/DB don't drift.
    index("idx_lc_pipeline_closed").on(t.pipelineId, t.closedAt),
    index("idx_lc_pipeline_created").on(t.pipelineId, t.createdAt),
    index("idx_lc_pipeline_status").on(t.pipelineId, t.statusId),
    index("idx_lc_responsible").on(t.responsibleUserId),
    index("idx_lc_non_qual").on(t.nonQualEnumId),
    // Termin dashboard cohort scan — partial keeps it small.
    index("idx_lc_termin_cohort")
      .on(t.pipelineId, t.createdAt)
      .where(
        sql`termin_date IS NOT NULL OR aa_termin_date IS NOT NULL`,
      ),
  ],
);

export const communications = analyticsSchema.table(
  "communications",
  {
    communicationId: text("communication_id"),
    communicationType: text("communication_type"),
    entityId: bigint("entity_id", { mode: "number" }),
    createdAt: timestamp("created_at"),
    leadId: bigint("lead_id", { mode: "number" }),
    pipelineId: bigint("pipeline_id", { mode: "number" }),
    pipelineName: text("pipeline_name"),
    category: text("category"),
    leadCreatedAt: timestamp("lead_created_at"),
    leadDayStart: timestamp("lead_day_start"),
    callStatus: smallint("call_status"),
    duration: integer("duration"),
    manager: text("manager"),
    statusId: bigint("status_id", { mode: "number" }),
    statusName: text("status_name"),
    utmSource: text("utm_source"),
    firstContactFlg: smallint("first_contact_flg"),
    lastContactFlg: smallint("last_contact_flg"),
    firstCallAt: timestamp("first_call_at"),
    businessHoursSla: bigint("business_hours_sla", { mode: "number" }),
    businessHoursSinceCommunication: doublePrecision(
      "business_hours_since_communication",
    ),
    // Caller phone for telephony-sourced rows (sync-telephony writes it; ETL
    // enrichTelephonyLeads consumes it to resolve phone→lead via Kommo
    // contacts). NULL on Kommo-sourced and message rows. Added in 0005.
    phone: text("phone"),
  },
  (t) => [
    index().on(t.leadId),
    index().on(t.createdAt),
    index().on(t.manager, t.createdAt),
    index().on(t.communicationType),
    // Phase 1 of Daily refactor: see leads_cohort note above.
    index("idx_comm_pipeline_created").on(t.pipelineId, t.createdAt),
    index("idx_comm_manager_pipeline_created").on(t.manager, t.pipelineId, t.createdAt),
    // Composite unique on (communication_id, COALESCE(lead_id, 0)) — supports
    // Pattern A row fanout from enrich-telephony-leads where one CDR call
    // becomes N rows (one per matched lead). NULL lead_id is treated as 0
    // inside the index expression so the raw not-yet-enriched row counts as
    // unique too. Partial (WHERE NOT NULL) so legacy orphan rows without a
    // comm_id don't block the constraint. Created in 0005; replaces the old
    // single-column communications_communication_id_unique from 0004.
    uniqueIndex("communications_comm_lead_unique")
      .on(t.communicationId, sql`COALESCE(${t.leadId}, 0)`)
      .where(sql`${t.communicationId} IS NOT NULL`),
    // Helper index for enrich-telephony-leads phone-scan. Partial keeps it
    // small — only rows still needing resolution participate.
    index("idx_comms_phone_unenriched")
      .on(t.phone)
      .where(sql`${t.leadId} IS NULL AND ${t.phone} IS NOT NULL`),
  ],
);

export const tasks = analyticsSchema.table(
  "tasks",
  {
    leadCreatedAt: timestamp("lead_created_at"),
    leadId: bigint("lead_id", { mode: "number" }),
    closedFlg: smallint("closed_flg"),
    leadManager: text("lead_manager"),
    taskId: bigint("task_id", { mode: "number" }),
    taskCreatedAt: timestamp("task_created_at"),
    completedAt: timestamp("completed_at"),
    isCompleted: smallint("is_completed"),
    deadline: timestamp("deadline"),
    taskManager: text("task_manager"),
  },
  (t) => [
    index().on(t.leadId),
    index().on(t.deadline),
    index().on(t.isCompleted, t.deadline),
    // Phase 1 of Daily refactor: getOverdueTasksByManager filters by
    // (task_manager, is_completed, deadline).
    index("idx_tasks_mgr_completed_deadline").on(t.taskManager, t.isCompleted, t.deadline),
    // Kommo task ID is the natural key — one row per task. Required for
    // the ON CONFLICT DO UPDATE pattern in sync-tasks.ts so retries of a
    // chunked INSERT (Neon transient + fetch retry) become no-op upserts
    // instead of duplicates. See migration 0015.
    uniqueIndex("tasks_task_id_unique").on(t.taskId),
  ],
);

export const leadStatusChanges = analyticsSchema.table(
  "lead_status_changes",
  {
    amoDomain: text("amo_domain"),
    leadId: bigint("lead_id", { mode: "number" }),
    pipelineId: bigint("pipeline_id", { mode: "number" }),
    pipeline: text("pipeline"),
    statusId: bigint("status_id", { mode: "number" }),
    status: text("status"),
    sort: integer("sort"),
    eventAt: timestamp("event_at"),
    leadCreatedAt: timestamp("lead_created_at"),
    lastEventAt: timestamp("last_event_at"),
    nextStatusId: bigint("next_status_id", { mode: "number" }),
    nextEventAt: timestamp("next_event_at"),
    manager: text("manager"),
  },
  (t) => [
    index().on(t.leadId, t.eventAt),
    index().on(t.pipelineId, t.statusId),
    index().on(t.eventAt),
    // Natural identity of a single pipeline transition. Without this,
    // sync-status-changes' chunked INSERT could double-write whenever the
    // Neon HTTP client retried a fetch that had already committed
    // server-side (see migration 0014).
    uniqueIndex("lead_status_changes_unique").on(t.leadId, t.eventAt, t.statusId),
  ],
);

export const sla = analyticsSchema.table(
  "sla",
  {
    leadId: bigint("lead_id", { mode: "number" }),
    leadCreatedAt: timestamp("lead_created_at"),
    pipelineId: bigint("pipeline_id", { mode: "number" }),
    pipelineName: text("pipeline_name"),
    statusId: bigint("status_id", { mode: "number" }),
    statusName: text("status_name"),
    utmSource: text("utm_source"),
    category: text("category"),
    manager: text("manager"),
    lossReasonName: text("loss_reason_name"),
    slaStart: timestamp("sla_start"),
    firstContactAt: timestamp("first_contact_at"),
    lastContactAt: timestamp("last_contact_at"),
    firstCallOutAt: timestamp("first_call_out_at"),
    firstMessageAt: timestamp("first_message_at"),
    isWaiting: smallint("is_waiting"),
    isWaitingCall: smallint("is_waiting_call"),
    slaFirstContactSeconds: bigint("sla_first_contact_seconds", { mode: "number" }),
    slaFirstCallSeconds: bigint("sla_first_call_seconds", { mode: "number" }),
    slaFirstCallCalendarSeconds: bigint("sla_first_call_calendar_seconds", { mode: "number" }),
    slaFirstCallFromShiftSeconds: bigint("sla_first_call_from_shift_seconds", { mode: "number" }),
    businessHoursSinceLastContact: bigint("business_hours_since_last_contact", { mode: "number" }),
    // TLT (Time between Latest Touches) — BH-time between the two most
    // recent call_out events made by the lead's responsible manager.
    // NULL when the manager has 0–1 calls on the lead. Drives the Looker
    // TLT views with their own per-pipeline blacklist (different from
    // SLA первого звонка's whitelist). See 0008_tlt_seconds.sql.
    tltSeconds: bigint("tlt_seconds", { mode: "number" }),
    // Integrator-snapshot columns — one-time mirror of values from
    // 45.156.25.84/db before we cut off the integrator feed. compute-sla
    // does NOT touch these; they're frozen at the snapshot. Looker
    // COALESCE's them into queries so historical leads match integrator's
    // Looker dashboard exactly. NULL = no integrator data → fallback to
    // our compute. See 0009_integrator_snapshot.sql.
    slaFirstCallSecondsIntegrator: bigint("sla_first_call_seconds_integrator", { mode: "number" }),
    slaFirstCallCalendarSecondsIntegrator: bigint("sla_first_call_calendar_seconds_integrator", { mode: "number" }),
    tltIntegrator: bigint("tlt_integrator", { mode: "number" }),
    slaStatus: text("sla_status"),
  },
  (t) => [
    index().on(t.leadId),
    index().on(t.leadCreatedAt),
    index().on(t.slaStatus),
    // Phase 1 of Daily refactor: getSlaFacts + getFrozenLeadsTeam.
    index("idx_sla_pipeline_leadcreated").on(t.pipelineId, t.leadCreatedAt),
    index("idx_sla_status_leadcreated").on(t.slaStatus, t.leadCreatedAt),
  ],
);

export const adsReport = analyticsSchema.table(
  "ads_report",
  {
    date: date("date"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),
    impressions: bigint("impressions", { mode: "number" }),
    clicks: bigint("clicks", { mode: "number" }),
    spend: doublePrecision("spend"),
    leadsCount: bigint("leads_count", { mode: "number" }),
    qualLeadsCount: bigint("qual_leads_count", { mode: "number" }),
    paymentCnt: bigint("payment_cnt", { mode: "number" }),
    paymentAmount: doublePrecision("payment_amount"),
    eLeadsCnt: bigint("e_leads_cnt", { mode: "number" }),
    pipelineLeadsCnt: bigint("pipeline_leads_cnt", { mode: "number" }),
    pipelinePaymentCnt: bigint("pipeline_payment_cnt", { mode: "number" }),
    pipelinePaymentAmount: doublePrecision("pipeline_payment_amount"),
    webinarLeadsCnt: bigint("webinar_leads_cnt", { mode: "number" }),
    webinarPaymentCnt: bigint("webinar_payment_cnt", { mode: "number" }),
    webinarPaymentAmount: doublePrecision("webinar_payment_amount"),
    usersCnt: bigint("users_cnt", { mode: "number" }),
  },
  (t) => [
    index().on(t.date),
    index().on(t.utmSource, t.date),
  ],
);

export const salesReport = analyticsSchema.table(
  "sales_report",
  {
    date: date("date"),
    manager: text("manager"),
    createCnt: bigint("create_cnt", { mode: "number" }),
    paymentCnt: bigint("payment_cnt", { mode: "number" }),
    paymentSum: doublePrecision("payment_sum"),
    salesPlan: bigint("sales_plan", { mode: "number" }),
    callsCnt: bigint("calls_cnt", { mode: "number" }),
    totalDuration: bigint("total_duration", { mode: "number" }),
    successCalls: bigint("success_calls", { mode: "number" }),
    outgoingCalls: bigint("outgoing_calls", { mode: "number" }),
    businessHoursSla: bigint("business_hours_sla", { mode: "number" }),
    businessHoursSlaCnt: bigint("business_hours_sla_cnt", { mode: "number" }),
    quality: doublePrecision("quality"),
  },
  (t) => [index().on(t.date, t.manager)],
);

// ==================== REPORT (dashboard source) ====================

export const customReport = analyticsSchema.table(
  "custom_report",
  {
    metricName: text("metric_name"),
    metricType: text("metric_type"),
    dt: timestamp("dt"),
    entityId: text("entity_id"),
    leadId: bigint("lead_id", { mode: "number" }),
    numericValue: doublePrecision("numeric_value"),
    manager: text("manager"),
    currentManager: text("current_manager"),
    category: text("category"),
    pipelineId: bigint("pipeline_id", { mode: "number" }),
    pipelineName: text("pipeline_name"),
    statusId: bigint("status_id", { mode: "number" }),
    statusName: text("status_name"),
    utmSource: text("utm_source"),
    currentPipelineName: text("current_pipeline_name"),
    currentStatusName: text("current_status_name"),
  },
  (t) => [
    index().on(t.metricName, t.dt),
    index().on(t.metricType, t.dt),
    index().on(t.manager, t.dt),
    index().on(t.leadId),
  ],
);

/**
 * Enum-option catalog for Kommo lead custom fields used to categorize refusals
 * (e.g. field 879824 "Причина закрытия Госники"). Populated by ETL lookups step
 * and consumed by getRefusalReasons() to translate enum_id → human-readable value.
 */
export const refusalEnums = analyticsSchema.table(
  "refusal_enums",
  {
    enumId: bigint("enum_id", { mode: "number" }).primaryKey(),
    value: text("value").notNull(),
    fieldId: bigint("field_id", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
);

// Phones that Kommo /contacts search returned 0 hits for — see migration
// 0016. The enrich-telephony-leads scan LEFT JOINs and excludes these so
// the dead-letter dial-attempts (cold calls, mistypes, forwarded numbers)
// don't block the queue from progressing to newer resolvable rows.
export const enrichSkipPhones = analyticsSchema.table(
  "enrich_skip_phones",
  {
    phone: text("phone").primaryKey(),
    firstSkippedAt: timestamp("first_skipped_at").defaultNow().notNull(),
    lastAttemptedAt: timestamp("last_attempted_at").defaultNow().notNull(),
    attempts: integer("attempts").default(1).notNull(),
  },
);

export const funnel = analyticsSchema.table(
  "funnel",
  {
    metricName: text("metric_name"),
    dtOperational: timestamp("dt_operational"),
    dtCohort: timestamp("dt_cohort"),
    entityId: text("entity_id"),
    leadId: bigint("lead_id", { mode: "number" }),
    numericValue: doublePrecision("numeric_value"),
    manager: text("manager"),
    pipelineName: text("pipeline_name"),
    statusName: text("status_name"),
  },
  (t) => [
    index().on(t.metricName, t.dtOperational),
    index().on(t.metricName, t.dtCohort),
    index().on(t.leadId),
    index().on(t.pipelineName, t.statusName),
  ],
);

// Kommo contact mirror. Populated by sync-contacts.ts via /api/v4/contacts
// (batched by id, 250 per request, 1 rps). Idempotent — ON CONFLICT updates
// name/phones/raw_payload on every resync. raw_payload kept for debugging
// only; queries should use the normalised columns.
export const contacts = analyticsSchema.table(
  "contacts",
  {
    contactId: bigint("contact_id", { mode: "number" }).primaryKey(),
    name: text("name"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    phone: text("phone"),
    phonesAll: jsonb("phones_all"),
    responsibleUserId: bigint("responsible_user_id", { mode: "number" }),
    kommoCreatedAt: timestamp("kommo_created_at"),
    kommoUpdatedAt: timestamp("kommo_updated_at"),
    rawPayload: jsonb("raw_payload").notNull(),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_contacts_phone").on(t.phone),
    index("idx_contacts_updated_at").on(t.kommoUpdatedAt),
  ],
);

// Per-conversion benchmark storage. Set by admins via PATCH endpoint —
// shared across all users. See migration 0018_funnel_target_levels.sql.
export const funnelTargetLevels = analyticsSchema.table(
  "funnel_target_levels",
  {
    conversionId: text("conversion_id").primaryKey(),
    conversionPct: doublePrecision("conversion_pct"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by"),
  },
);

// Lead ↔ Contact link table. One lead can have multiple contacts (rare);
// one contact can belong to multiple leads (common — same client across
// Бух Гос and Бух Бератер). is_active flipped to false when Kommo no
// longer returns the link; rows never deleted so history is preserved.
export const leadContactLinks = analyticsSchema.table(
  "lead_contact_links",
  {
    leadId: bigint("lead_id", { mode: "number" }).notNull(),
    contactId: bigint("contact_id", { mode: "number" }).notNull(),
    firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    isActive: boolean("is_active").default(true).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.leadId, t.contactId], name: "lead_contact_links_pkey" }),
    index("idx_lcl_contact_id").on(t.contactId),
    index("idx_lcl_active")
      .on(t.leadId)
      .where(sql`is_active = TRUE`),
  ],
);
