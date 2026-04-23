// Analytics DB schema — mirror of the 3rd-party integrator's MySQL (45.156.25.84/db)
// so we can reproduce Looker dashboards in our own stack. Cross-check target:
// `report_sternmeister_custom_report` and `report_sternmeister_funnel`.
//
// Types: MySQL TINYINT→smallint, DATETIME→timestamp, DOUBLE→doublePrecision,
// TEXT→text. Timestamps stored in UTC; the app converts to Europe/Berlin on read.

import {
  pgSchema,
  bigint,
  date,
  doublePrecision,
  index,
  integer,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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
  },
  (t) => [
    index().on(t.leadId),
    index().on(t.createdAt),
    index().on(t.pipeline, t.status),
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
  },
  (t) => [
    index().on(t.leadId),
    index().on(t.createdAt),
    index().on(t.manager, t.createdAt),
    index().on(t.communicationType),
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
    index().on(t.taskId),
    index().on(t.leadId),
    index().on(t.deadline),
    index().on(t.isCompleted, t.deadline),
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
    slaStatus: text("sla_status"),
  },
  (t) => [
    index().on(t.leadId),
    index().on(t.leadCreatedAt),
    index().on(t.slaStatus),
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
