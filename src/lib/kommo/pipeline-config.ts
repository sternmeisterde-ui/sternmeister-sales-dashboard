/**
 * Kommo Pipeline Status Mapping
 *
 * Pipelines:
 *   - Бух Комм (B2B/коммерсы) — ID: 10631243
 *   - Бух Гос (B2G/госники, 1я линия) — ID: 10935879
 *   - Бух Бератер (B2G/госники, 2я линия) — ID: 12154099
 *   - Medical Admin Gov — ID: 13209991
 *   - Medical Admin Commercial — ID: 13209983
 *
 * Maps Kommo pipeline statuses to Daily tab funnel metrics.
 * This drives the aggregation of leads into the funnel view.
 */

// ==================== PIPELINE IDS ====================

/** B2B (коммерсы) */
export const B2B_PIPELINES = {
  /** Бух Комм — commercial pipeline */
  COMMERCIAL: 10631243,
  /** Medical Admin Commercial */
  MEDICAL_COMM: 13209983,
} as const;

/** B2G (госники) */
export const B2G_PIPELINES = {
  /** Бух Гос — first line qualification */
  FIRST_LINE: 10935879,
  /** Бух Бератер — second line (berater/consultation) */
  BERATER: 12154099,
  /** Medical Admin Gov */
  MEDICAL_GOV: 13209991,
} as const;

// ==================== STATUS IDS — БУХ КОММ (Коммерсы / B2B) ====================

export const COMMERCIAL_STATUSES = {
  INCOMING: 81523499,              // Incoming leads
  TECH: 83364011,                  // Tech
  NEW_LEAD: 81523503,              // Новый лид
  NEW_LEAD_2: 104076579,           // Новый лид 2
  NEW_LEAD_3: 104076583,           // Новый лид 3
  IN_PROGRESS: 81523507,           // Взят в работу
  NO_ANSWER: 82883595,             // Недозвон
  CONTACT_MADE: 81523515,          // Контакт установлен
  NO_CONSENT: 88519479,            // Нет предварительного согласия
  INTEREST_CONFIRMED: 82661915,    // Интерес подтвержден
  INVOICE_SENT: 82661919,          // Счет выставлен
  PREPAYMENT: 82946495,            // Предоплата получена
  INSTALLMENT: 82946499,           // Рассрочка
  WON: 142,                        // Closed - won
  LOST: 143,                       // Closed - lost
} as const;

// ==================== STATUS IDS — MEDICAL ADMIN COMMERCIAL (Мед 1 / B2B) ====================
// Medical uses a separate Kommo pipeline (13209983) with its OWN status IDs —
// they do NOT overlap with COMMERCIAL_STATUSES. Any code that filters/aggregates
// B2B leads must cover BOTH status sets, or Medical leads silently drop out.

export const MEDICAL_COMM_STATUSES = {
  INCOMING: 101858011,             // Incoming leads
  TECH: 101858015,                 // Tech
  NEW_LEAD: 101858019,             // Новый лид
  NEW_LEAD_2: 104076587,           // Новый лид 2
  NEW_LEAD_3: 104076591,           // Новый лид 3
  IN_PROGRESS: 101858023,          // Взят в работу
  NO_ANSWER: 101858255,            // Недозвон
  CONTACT_MADE: 101858259,         // Контакт установлен
  NO_CONSENT: 101858263,           // Нет предварительного согласия
  INTEREST_CONFIRMED: 101858267,   // Интерес подтверждён
  INVOICE_SENT: 101858271,         // Счёт выставлен
  PREPAYMENT: 101858275,           // Предоплата получена
  INSTALLMENT: 101858279,          // Рассрочка
  WON: 142,                        // Closed - won
  LOST: 143,                       // Closed - lost
} as const;

// ==================== STATUS IDS — FIRST LINE (Бухгалтерия Гос) ====================

export const FIRST_LINE_STATUSES = {
  UNSORTED: 83873487,        // Неразобранное
  BASE: 93485479,            // База
  NEW_LEAD: 83873491,        // Новый лид
  IN_PROGRESS: 90367079,     // Взято в работу
  NO_ANSWER: 90367083,       // Недозвон
  CONTACT_MADE: 90367087,    // Контакт установлен
  CONSULT_DONE: 95514983,    // Консультация проведена
  DOCS_SENT_DC: 101935919,   // Документы отправлены в ДЦ
  DELAYED_START: 95514987,   // Отложенный старт
  WON: 142,                  // Термин ДЦ (closed won)
  LOST: 143,                 // Закрыто и не реализовано
} as const;

// ==================== STATUS IDS — BERATER ====================

export const BERATER_STATUSES = {
  UNSORTED: 93860327,                // Неразобранное
  RECEIVED_FROM_FIRST: 93860331,     // Принято от первой линии
  DOVEDENIE: 102183931,              // Доведение
  CONSULT_BEFORE_DC: 102183935,      // Консультация перед термином ДЦ
  CONSULT_BEFORE_DC_DONE: 102183939, // Консультация перед термином ДЦ проведена
  IN_PROGRESS: 93860335,             // Взято в работу
  NO_ANSWER: 93860339,               // Недозвон
  CONTACT_MADE: 93860863,            // Контакт установлен
  TERM_DC_CANCELLED: 93860875,       // Термин ДЦ отменен/перенесен
  TERM_DC_DONE: 93886075,            // Термин ДЦ состоялся
  TERM_AA_CANCELLED: 93860883,       // Термин АА отменен/перенесен
  CONSULT_BEFORE_AA: 102183943,      // Консультация перед термином АА
  CONSULT_BEFORE_AA_DONE: 102183947, // Консультация перед термином АА проведена
  BERATER_REVIEW: 93860887,          // На рассмотрении бератера
  DELAYED_START: 95515895,           // Отложенный старт
  APPEAL: 93860891,                  // Апелляция
  WON: 142,                          // Гутшайн одобрен
  LOST: 143,                         // Закрыто и не реализовано
} as const;

// ==================== QUALIFICATION STAGES (A2, B1, B2+) ====================
// Company-specific qualification levels based on pipeline progress:
//
// A2 = "Контакт установлен" — first contact made, interest not confirmed
// B1 = "Консультация проведена" — consultation done, ready for docs
// B2+ = "Документы отправлены в ДЦ" and beyond — advanced stage

/** Status IDs that count as "A2" (contact made, not yet consulted) */
export const A2_STATUSES: Set<number> = new Set([
  FIRST_LINE_STATUSES.CONTACT_MADE,
]);

/** Status IDs that count as "B1" (consultation done, docs not yet sent) */
export const B1_STATUSES: Set<number> = new Set([
  FIRST_LINE_STATUSES.CONSULT_DONE,
]);

/** Status IDs that count as "B2+" (docs sent or further) */
export const B2_PLUS_STATUSES: Set<number> = new Set([
  FIRST_LINE_STATUSES.DOCS_SENT_DC,
  FIRST_LINE_STATUSES.DELAYED_START,
  // Also berater pipeline active statuses (transferred from first line)
  BERATER_STATUSES.RECEIVED_FROM_FIRST,
  BERATER_STATUSES.DOVEDENIE,
  BERATER_STATUSES.CONSULT_BEFORE_DC,
  BERATER_STATUSES.CONSULT_BEFORE_DC_DONE,
  BERATER_STATUSES.IN_PROGRESS,
  BERATER_STATUSES.CONTACT_MADE,
  BERATER_STATUSES.TERM_DC_CANCELLED,
  BERATER_STATUSES.TERM_DC_DONE,
  BERATER_STATUSES.TERM_AA_CANCELLED,
  BERATER_STATUSES.CONSULT_BEFORE_AA,
  BERATER_STATUSES.CONSULT_BEFORE_AA_DONE,
  BERATER_STATUSES.BERATER_REVIEW,
  BERATER_STATUSES.DELAYED_START,
  BERATER_STATUSES.APPEAL,
]);

// ==================== QUALIFIED LEADS ====================
// "Квалифицированный лид" = lead that reached "Контакт установлен" or further

export const QUALIFIED_STATUSES: Set<number> = new Set([
  ...A2_STATUSES,
  ...B1_STATUSES,
  ...B2_PLUS_STATUSES,
  // Won statuses count too
  FIRST_LINE_STATUSES.WON,
  BERATER_STATUSES.WON,
]);

// ==================== ALL ACTIVE (NON-CLOSED) STATUS IDS ====================
// Used to filter leads from Kommo API — fetch only active leads first,
// then separately fetch WON/LOST for result counts.
export const ALL_ACTIVE_STATUS_IDS: number[] = [
  // First line
  FIRST_LINE_STATUSES.UNSORTED,
  FIRST_LINE_STATUSES.BASE,
  FIRST_LINE_STATUSES.NEW_LEAD,
  FIRST_LINE_STATUSES.IN_PROGRESS,
  FIRST_LINE_STATUSES.NO_ANSWER,
  FIRST_LINE_STATUSES.CONTACT_MADE,
  FIRST_LINE_STATUSES.CONSULT_DONE,
  FIRST_LINE_STATUSES.DOCS_SENT_DC,
  FIRST_LINE_STATUSES.DELAYED_START,
  // Berater
  BERATER_STATUSES.UNSORTED,
  BERATER_STATUSES.RECEIVED_FROM_FIRST,
  BERATER_STATUSES.DOVEDENIE,
  BERATER_STATUSES.CONSULT_BEFORE_DC,
  BERATER_STATUSES.CONSULT_BEFORE_DC_DONE,
  BERATER_STATUSES.IN_PROGRESS,
  BERATER_STATUSES.NO_ANSWER,
  BERATER_STATUSES.CONTACT_MADE,
  BERATER_STATUSES.TERM_DC_CANCELLED,
  BERATER_STATUSES.TERM_DC_DONE,
  BERATER_STATUSES.TERM_AA_CANCELLED,
  BERATER_STATUSES.CONSULT_BEFORE_AA,
  BERATER_STATUSES.CONSULT_BEFORE_AA_DONE,
  BERATER_STATUSES.BERATER_REVIEW,
  BERATER_STATUSES.DELAYED_START,
  BERATER_STATUSES.APPEAL,
];

// ==================== FUNNEL METRICS STATUS MAPPING ====================

/** Map from funnel metric key to pipeline_id + status_id sets */
export const FUNNEL_STATUS_MAP: Record<string, { pipelineIds?: number[]; statusIds: Set<number> }> = {
  // Задания (docs sent to DC from first line)
  tasksTotal: {
    pipelineIds: [B2G_PIPELINES.FIRST_LINE],
    statusIds: new Set([FIRST_LINE_STATUSES.DOCS_SENT_DC]),
  },

  // Консультации (consultation done on first line)
  consultTotal: {
    pipelineIds: [B2G_PIPELINES.FIRST_LINE],
    statusIds: new Set([FIRST_LINE_STATUSES.CONSULT_DONE]),
  },

  // Термины — from Бератер pipeline
  termDCCancelled: {
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([BERATER_STATUSES.TERM_DC_CANCELLED]),
  },
  termDCDone: {
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([BERATER_STATUSES.TERM_DC_DONE]),
  },
  termAA: {
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([BERATER_STATUSES.CONSULT_BEFORE_AA]),
  },
  termAACancelled: {
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([BERATER_STATUSES.TERM_AA_CANCELLED]),
  },
  termAADone: {
    // Leads that were at Термин АА and progressed to berater review or beyond
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([
      BERATER_STATUSES.BERATER_REVIEW,
      BERATER_STATUSES.DELAYED_START,
      BERATER_STATUSES.APPEAL,
      BERATER_STATUSES.WON,
    ]),
  },

  // Результаты — from Бератер pipeline
  beraterReview: {
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([BERATER_STATUSES.BERATER_REVIEW]),
  },
  delayedStart: {
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([
      BERATER_STATUSES.DELAYED_START,
      FIRST_LINE_STATUSES.DELAYED_START,
    ]),
  },
  appeal: {
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([BERATER_STATUSES.APPEAL]),
  },
  gutscheinsApproved: {
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([BERATER_STATUSES.WON]),
  },
  beraterReject: {
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([BERATER_STATUSES.LOST]),
  },

  // Подано апелляций (leads at appeal status in berater)
  appealsSubmitted: {
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([BERATER_STATUSES.APPEAL]),
  },

  // Переданы на термин всего — all active leads in berater pipeline
  termsTotal: {
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([
      BERATER_STATUSES.RECEIVED_FROM_FIRST,
      BERATER_STATUSES.IN_PROGRESS,
      BERATER_STATUSES.NO_ANSWER,
      BERATER_STATUSES.CONTACT_MADE,
      BERATER_STATUSES.TERM_DC_CANCELLED,
      BERATER_STATUSES.TERM_DC_DONE,
      BERATER_STATUSES.CONSULT_BEFORE_AA,
      BERATER_STATUSES.TERM_AA_CANCELLED,
      BERATER_STATUSES.BERATER_REVIEW,
      BERATER_STATUSES.DELAYED_START,
      BERATER_STATUSES.APPEAL,
    ]),
  },

  // Ожидают термин всего — leads in berater before term DC
  awaitTermTotal: {
    pipelineIds: [B2G_PIPELINES.BERATER],
    statusIds: new Set([
      BERATER_STATUSES.RECEIVED_FROM_FIRST,
      BERATER_STATUSES.DOVEDENIE,
      BERATER_STATUSES.CONSULT_BEFORE_DC,
      BERATER_STATUSES.CONSULT_BEFORE_DC_DONE,
    ]),
  },
};

// ==================== NEW VARIANT MAPPING ====================
// "New" metric keys → same status sets as "Total" but only leads created in period
export const NEW_VARIANTS_MAP: Record<string, string> = {
  tasksNew: "tasksTotal",
  consultNew: "consultTotal",
  termsNew: "termsTotal",
  awaitTermNew: "awaitTermTotal",
};

// ==================== B2B ACTIVE STATUS IDS ====================

/**
 * Active (non-closed) statuses for BOTH B2B pipelines — Бух Комм (10631243)
 * AND Medical Admin Commercial (13209983). The two pipelines have disjoint
 * status_id ranges, so we must union them; otherwise Medical leads are
 * silently filtered out of the Dashboard/Звонки snapshot (bug 2026-04-24).
 */
export const B2B_ALL_ACTIVE_STATUS_IDS: number[] = [
  // Бух Комм
  COMMERCIAL_STATUSES.INCOMING,
  COMMERCIAL_STATUSES.TECH,
  COMMERCIAL_STATUSES.NEW_LEAD,
  COMMERCIAL_STATUSES.NEW_LEAD_2,
  COMMERCIAL_STATUSES.NEW_LEAD_3,
  COMMERCIAL_STATUSES.IN_PROGRESS,
  COMMERCIAL_STATUSES.NO_ANSWER,
  COMMERCIAL_STATUSES.CONTACT_MADE,
  COMMERCIAL_STATUSES.NO_CONSENT,
  COMMERCIAL_STATUSES.INTEREST_CONFIRMED,
  COMMERCIAL_STATUSES.INVOICE_SENT,
  COMMERCIAL_STATUSES.PREPAYMENT,
  COMMERCIAL_STATUSES.INSTALLMENT,
  // Medical Admin Commercial
  MEDICAL_COMM_STATUSES.INCOMING,
  MEDICAL_COMM_STATUSES.TECH,
  MEDICAL_COMM_STATUSES.NEW_LEAD,
  MEDICAL_COMM_STATUSES.NEW_LEAD_2,
  MEDICAL_COMM_STATUSES.NEW_LEAD_3,
  MEDICAL_COMM_STATUSES.IN_PROGRESS,
  MEDICAL_COMM_STATUSES.NO_ANSWER,
  MEDICAL_COMM_STATUSES.CONTACT_MADE,
  MEDICAL_COMM_STATUSES.NO_CONSENT,
  MEDICAL_COMM_STATUSES.INTEREST_CONFIRMED,
  MEDICAL_COMM_STATUSES.INVOICE_SENT,
  MEDICAL_COMM_STATUSES.PREPAYMENT,
  MEDICAL_COMM_STATUSES.INSTALLMENT,
];

/** B2B statuses considered as "предоплата получена" */
export const B2B_PREPAYMENT_STATUSES: Set<number> = new Set([
  COMMERCIAL_STATUSES.PREPAYMENT,
  COMMERCIAL_STATUSES.INSTALLMENT,
]);

/**
 * "WON-family" status_ids per pipeline — used for sales/revenue counting.
 * Per Excel verification (Apr 2026): leads with first_payment_date/prepayment_date
 * are only counted as sales if they sit in one of these statuses.
 *   Бух Комм:  142 (Closed-won), 82946495 (Предоплата), 82946499 (Рассрочка).
 *   Medical:   142 (Successful), 101858279 (Рассрочка Medical).
 *     Inst-variants for Medical are pipeline-specific and confirmed via
 *     SELECT status_id, status FROM analytics.leads_cohort WHERE pipeline_id=13209983
 *     AND first_payment_date IS NOT NULL.
 */
export const B2B_WON_STATUSES_PER_PIPELINE: Record<number, number[]> = {
  [B2B_PIPELINES.COMMERCIAL]: [142, 82946495, 82946499],
  [B2B_PIPELINES.MEDICAL_COMM]: [142, 101858279],
};

// ==================== B2B QUALIFICATION STAGES ====================
// B2B qualification: "Контакт установлен" and beyond

/** B2B qualified statuses — unioned across Бух Комм + Medical Admin Commercial. */
export const B2B_QUALIFIED_STATUSES: Set<number> = new Set([
  // Бух Комм
  COMMERCIAL_STATUSES.CONTACT_MADE,
  COMMERCIAL_STATUSES.INTEREST_CONFIRMED,
  COMMERCIAL_STATUSES.INVOICE_SENT,
  COMMERCIAL_STATUSES.PREPAYMENT,
  COMMERCIAL_STATUSES.INSTALLMENT,
  COMMERCIAL_STATUSES.WON,
  // Medical Admin Commercial
  MEDICAL_COMM_STATUSES.CONTACT_MADE,
  MEDICAL_COMM_STATUSES.INTEREST_CONFIRMED,
  MEDICAL_COMM_STATUSES.INVOICE_SENT,
  MEDICAL_COMM_STATUSES.PREPAYMENT,
  MEDICAL_COMM_STATUSES.INSTALLMENT,
]);

// ==================== PIPELINE IDS for filtering ====================

/** All pipeline IDs relevant for B2G daily metrics */
export const B2G_ALL_PIPELINE_IDS = [
  B2G_PIPELINES.FIRST_LINE,
  B2G_PIPELINES.BERATER,
  B2G_PIPELINES.MEDICAL_GOV,
];

/** All pipeline IDs for B2B */
export const B2B_ALL_PIPELINE_IDS = [
  B2B_PIPELINES.COMMERCIAL,
  B2B_PIPELINES.MEDICAL_COMM,
];

/** Get pipeline IDs by department */
export function getPipelineIds(department: string): number[] {
  if (department === "b2b") return B2B_ALL_PIPELINE_IDS;
  return B2G_ALL_PIPELINE_IDS; // default: b2g
}

/** Get active status IDs by department */
export function getActiveStatusIds(department: string): number[] {
  if (department === "b2b") return B2B_ALL_ACTIVE_STATUS_IDS;
  return ALL_ACTIVE_STATUS_IDS; // default: b2g
}

// ==================== B2B CUSTOM FIELDS (Kommo lead) ====================
// Resolved by field NAME (case-insensitive, trimmed) so the code works
// across pipelines/accounts where field_id differs.
//
// The integrator documents these as "Факт. дата 1-го платежа / Сумма 1-го
// платежа / Дата предоплаты / Сумма предоплаты". Spelling varies in the wild
// (Факт. дата vs Фактическая дата, 1-го vs 1ого); we accept the common forms.

export const B2B_CUSTOM_FIELD_NAMES = {
  firstPaymentDate: [
    "Факт. Дата 1-го платежа",
    "Фактическая дата 1-го платежа",
    "Факт. дата 1-го платежа",
    "Дата 1-го платежа",
  ],
  firstPaymentAmount: [
    "Сумма 1-го платежа",
    "Сумма первого платежа",
  ],
  prepaymentDate: [
    "Дата предоплаты",
  ],
  prepaymentAmount: [
    "Сумма предоплаты",
  ],
} as const;

/** B2B lead is excluded from "Квал Бух лидов факт" if it sits in these statuses. */
export const B2B_BUH_KOMLEADS_EXCLUDED_STATUSES: Set<number> = new Set([
  COMMERCIAL_STATUSES.INCOMING,
]);

/** B2B Medical has no Incoming stage — nothing to exclude by status. */
export const B2B_MED_KOMLEADS_EXCLUDED_STATUSES: Set<number> = new Set([]);

/**
 * Loss-reason names that disqualify a lead from "Квал ком. лидов факт".
 * Matched case-insensitively against loss_reason.name; substring match so
 * variants like "Неквал: доход < ...", "Спам (бот)" are covered.
 */
export const B2B_KOMLEADS_EXCLUDED_LOSS_REASON_PATTERNS = [
  /неквал/i,
  /спам/i,
] as const;
