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
  /** Мед Гос — medical qualifier (Praxisempfang), зеркало FIRST_LINE */
  MEDICAL_GOV: 13209991,
  /** Мед Бератер — medical 2я/3я линия, зеркало BERATER */
  MED_BERATER: 14001515,
} as const;

/**
 * Вертикаль бизнеса внутри отдела. Осмысленна только для b2g:
 *   buh = Бух Гос + Бух Бератер, med = Мед Гос + Мед Бератер, all = все четыре.
 * Для b2b пока игнорируется (медицина там уже слита в общий b2b-агрегат).
 * См. dev_docs/specs/21-МЕД-АДМИН-В-B2G.md.
 */
export type Vertical = "buh" | "med" | "all";

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
  DECISION_MAKING: 104211575, // Принимает решение (post-consult holding state)
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
  TERM_AA: 93860879,                 // Термин АА (на этапе)
  TERM_AA_CANCELLED: 93860883,       // Термин АА отменен/перенесен
  CONSULT_BEFORE_AA: 102183943,      // Консультация перед термином АА
  CONSULT_BEFORE_AA_DONE: 102183947, // Консультация перед термином АА проведена
  BERATER_REVIEW: 93860887,          // На рассмотрении бератера
  DELAYED_START: 95515895,           // Отложенный старт
  APPEAL: 93860891,                  // Апелляция
  WON: 142,                          // Гутшайн одобрен
  LOST: 143,                         // Закрыто и не реализовано
} as const;

// ==================== STATUS IDS — МЕД ГОС (Medical qualifier) ====================
// Мед Гос (pipeline 13209991) — зеркало Бух Гос 1-й линии для медицинской воронки.
// Собственный диапазон status_id (не пересекается с Бух Гос). ID перенесены из
// OKK/src/config/constants.ts (d2_med_qualifier). ⚠ Это статусы рабочей воронки,
// на которых ОКК оценивает звонки; пред-стадии (Неразобранное/База/Документы в ДЦ)
// в ОКК-наборе отсутствуют — при необходимости добрать из Kommo API
// /api/v4/leads/pipelines/13209991. См. spec 21 §6.

export const MED_GOV_STATUSES = {
  NEW_LEAD: 101858059,        // Новый лид
  IN_PROGRESS: 101858063,     // Взято в работу
  NO_ANSWER: 101858423,       // Недозвон
  CONTACT_MADE: 101858427,    // Контакт установлен
  DECISION_MAKING: 108064559, // Принимает решение
  CONSULT_DONE: 101858431,    // Консультация проведена
  DELAYED_START: 101858435,   // Отложенный старт
  WON: 142,                   // Успешно реализовано
  LOST: 143,                  // Закрыто и не реализовано
} as const;

// ==================== STATUS IDS — МЕД БЕРАТЕР ====================
// Мед Бератер (pipeline 14001515) — зеркало Бух Бератер для медицины. В Kommo две
// стадии задвоены (по два status_id): «Термин ДЦ состоялся» (108066251/108066259) и
// «Термин ДЦ отменён/перенесён» (108066247/108066255) — оба ID учтены (…_DUP).
// ID из OKK/src/config/constants.ts (d2_med_berater / berater2 / dovedenie).

export const MED_BERATER_STATUSES = {
  RECEIVED_FROM_FIRST: 108064611,    // Принято от первой линии
  DOVEDENIE: 108064615,              // Доведение
  CONSULT_BEFORE_DC: 108064619,      // Консультация перед термином ДЦ
  CONSULT_BEFORE_DC_DONE: 108066243, // Консультация перед термином ДЦ проведена
  TERM_DC_DONE: 108066251,           // Термин ДЦ состоялся
  TERM_DC_DONE_DUP: 108066259,       // Термин ДЦ состоялся (дубль Kommo)
  TERM_DC_CANCELLED: 108066247,      // Термин ДЦ отменён/перенесён
  TERM_DC_CANCELLED_DUP: 108066255,  // Термин ДЦ отменён/перенесён (дубль Kommo)
  CONSULT_BEFORE_AA: 108066267,      // Консультация перед термином АА
  CONSULT_BEFORE_AA_DONE: 108066271, // Консультация перед термином АА проведена
  TERM_AA_CANCELLED: 108066263,      // Термин АА отменён/перенесён
  BERATER_REVIEW: 108066275,         // На рассмотрении бератера
  DELAYED_START: 108066279,          // Отложенный старт
  APPEAL: 108066283,                 // Апелляция
  WON: 142,                          // Гутшайн одобрен
  LOST: 143,                         // Закрыто и не реализовано
} as const;

// ==================== QUALIFICATION STAGES (A2, B1, B2+) ====================
// Company-specific qualification levels based on pipeline progress:
//
// A2 = "Контакт установлен" — first contact made, interest not confirmed
// B1 = "Консультация проведена" — consultation done, ready for docs
// B2+ = "Документы отправлены в ДЦ" and beyond — advanced stage
//
// TODO(2026-04-24): User asked to tie A2/B1/B2+ to Kommo CFV[869928]
// ("технически поля") instead of status IDs. That requires (1) adding CFV
// 869928 to the analytics.leads_cohort ETL mirror and (2) rewriting the
// status-membership logic below into a CFV value lookup. Status-based
// fallback stays in place until the CFV mirror exists.

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
  FIRST_LINE_STATUSES.DECISION_MAKING,
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

// ==================== QUAL FILTER FOR DASHBOARD CHARTS ====================
// Frozen 2026-05-07 from a Kommo filter URL provided by ROP. Allow-list
// semantics: a FIRST_LINE lead is "qual" iff
//   1. its status_id is in QUAL_FIRST_LINE_STATUS_IDS (excludes the
//      pre-processing buckets Неразобранное and База), AND
//   2. its non_qual_enum_id (cf 879824 "Причина закрытия госники") is either
//      NULL or in QUAL_REASON_ENUM_IDS.
// Used by chart 3 (qual-leads-docs) and chart 4 stage A (termin-funnel,
// FIRST_LINE creation → Термин ДЦ).

/** FIRST_LINE statuses that count as "qual" for the dashboards.
 *  Excludes Неразобранное (83873487) and База (93485479) — pre-processing
 *  buckets where the lead hasn't yet been picked up. */
export const QUAL_FIRST_LINE_STATUS_IDS: readonly number[] = [
  FIRST_LINE_STATUSES.NEW_LEAD,        // 83873491 Новый лид
  FIRST_LINE_STATUSES.IN_PROGRESS,     // 90367079 Взято в работу
  FIRST_LINE_STATUSES.NO_ANSWER,       // 90367083 Недозвон
  FIRST_LINE_STATUSES.CONTACT_MADE,    // 90367087 Контакт установлен
  FIRST_LINE_STATUSES.CONSULT_DONE,    // 95514983 Консультация проведена
  FIRST_LINE_STATUSES.DECISION_MAKING, // 104211575 Принимает решение
  FIRST_LINE_STATUSES.DOCS_SENT_DC,    // 101935919 Документы отправлены в ДЦ
  FIRST_LINE_STATUSES.DELAYED_START,   // 95514987 Отложенный старт
  FIRST_LINE_STATUSES.WON,             // 142 Термин ДЦ
  FIRST_LINE_STATUSES.LOST,            // 143 Закрыто и не реализовано
];

/** "Причина закрытия госники" (cf 879824) enum values that count as qual.
 *  Frozen from ROP-provided Kommo URL — list of reasons that DON'T disqualify
 *  the lead. NULL (поле не заполнено) ALSO counts as qual; that case is
 *  handled in the SQL clause separately, not in this list. */
export const QUAL_REASON_ENUM_IDS: readonly number[] = [
  744186, 744188, 744190, 744192,
  744304, 744312, 744314, 744316, 744318, 744320,
  744384,
  745292, 745304,
  746174,
  746700,
  750386,
  753840, 753842,
];

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
  FIRST_LINE_STATUSES.DECISION_MAKING,
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

// ==================== МЕД ACTIVE STATUS IDS ====================
// Active (non-closed) статусы мед-воронок — для фетча активных лидов из Kommo при
// vertical='med'/'all'. WON(142)/LOST(143) исключены (закрытые тянутся отдельно).

/** Мед Гос active statuses */
export const MED_GOV_ALL_ACTIVE_STATUS_IDS: number[] = [
  MED_GOV_STATUSES.NEW_LEAD,
  MED_GOV_STATUSES.IN_PROGRESS,
  MED_GOV_STATUSES.NO_ANSWER,
  MED_GOV_STATUSES.CONTACT_MADE,
  MED_GOV_STATUSES.DECISION_MAKING,
  MED_GOV_STATUSES.CONSULT_DONE,
  MED_GOV_STATUSES.DELAYED_START,
];

/** Мед Бератер active statuses (включая задвоенные Kommo-стадии) */
export const MED_BERATER_ALL_ACTIVE_STATUS_IDS: number[] = [
  MED_BERATER_STATUSES.RECEIVED_FROM_FIRST,
  MED_BERATER_STATUSES.DOVEDENIE,
  MED_BERATER_STATUSES.CONSULT_BEFORE_DC,
  MED_BERATER_STATUSES.CONSULT_BEFORE_DC_DONE,
  MED_BERATER_STATUSES.TERM_DC_DONE,
  MED_BERATER_STATUSES.TERM_DC_DONE_DUP,
  MED_BERATER_STATUSES.TERM_DC_CANCELLED,
  MED_BERATER_STATUSES.TERM_DC_CANCELLED_DUP,
  MED_BERATER_STATUSES.CONSULT_BEFORE_AA,
  MED_BERATER_STATUSES.CONSULT_BEFORE_AA_DONE,
  MED_BERATER_STATUSES.TERM_AA_CANCELLED,
  MED_BERATER_STATUSES.BERATER_REVIEW,
  MED_BERATER_STATUSES.DELAYED_START,
  MED_BERATER_STATUSES.APPEAL,
];

/** Union — все активные статусы мед-вертикали b2g */
export const B2G_MED_ALL_ACTIVE_STATUS_IDS: number[] = [
  ...MED_GOV_ALL_ACTIVE_STATUS_IDS,
  ...MED_BERATER_ALL_ACTIVE_STATUS_IDS,
];

// ==================== PIPELINE IDS по вертикали ====================

/** Бух-вертикаль b2g: Бух Гос + Бух Бератер */
export const B2G_BUH_PIPELINE_IDS = [
  B2G_PIPELINES.FIRST_LINE,
  B2G_PIPELINES.BERATER,
];

/** Мед-вертикаль b2g: Мед Гос + Мед Бератер */
export const B2G_MED_PIPELINE_IDS = [
  B2G_PIPELINES.MEDICAL_GOV,
  B2G_PIPELINES.MED_BERATER,
];

/**
 * All pipeline IDs relevant for B2G daily metrics.
 * ⚠ Legacy-набор (Бух + Мед Гос, БЕЗ Мед Бератер) — сохранён как есть для обратной
 * совместимости вызовов getPipelineIds без vertical. Новую полную мед-вертикаль
 * (обе воронки) даёт vertical='all'/'med'. Не менять без ревизии всех вызовов.
 */
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

/**
 * Berater-воронка(и) для вкладки Термин по вертикали:
 *   buh → Бух Бератер, med → Мед Бератер, all → обе.
 * Без vertical → буховый набор (legacy — сохраняет прежнее поведение Термина).
 */
export function getBeraterPipelineIds(vertical?: Vertical): number[] {
  if (vertical === "med") return [B2G_PIPELINES.MED_BERATER];
  if (vertical === "all") return [B2G_PIPELINES.BERATER, B2G_PIPELINES.MED_BERATER];
  return [B2G_PIPELINES.BERATER]; // buh / undefined (legacy)
}

/**
 * status_id(ы) «Термин ДЦ отменён/перенесён» по вертикали — для когортного
 * подсчёта отмен/переносов. Мед-бератер задваивает стадию в Kommo → оба id.
 * Без vertical → буховый (legacy).
 */
export function getTerminCancelledStatusIds(vertical?: Vertical): number[] {
  const buh = [BERATER_STATUSES.TERM_DC_CANCELLED];
  const med = [MED_BERATER_STATUSES.TERM_DC_CANCELLED, MED_BERATER_STATUSES.TERM_DC_CANCELLED_DUP];
  if (vertical === "med") return med;
  if (vertical === "all") return [...buh, ...med];
  return buh; // buh / undefined (legacy)
}

/**
 * Get pipeline IDs by department + (optional) vertical.
 *
 * Без `vertical` → legacy-поведение (byte-identical сегодняшнему): для b2g это
 * B2G_ALL_PIPELINE_IDS (Бух + Мед Гос). С `vertical` — новая семантика Бух/Мед/Все.
 * Vertical применяется только к b2g; для b2b он игнорируется.
 */
export function getPipelineIds(department: string, vertical?: Vertical): number[] {
  if (department === "b2b") return B2B_ALL_PIPELINE_IDS;
  // b2g
  if (vertical === "buh") return B2G_BUH_PIPELINE_IDS;
  if (vertical === "med") return B2G_MED_PIPELINE_IDS;
  if (vertical === "all") return [...B2G_BUH_PIPELINE_IDS, ...B2G_MED_PIPELINE_IDS];
  return B2G_ALL_PIPELINE_IDS; // legacy default
}

/**
 * Get active status IDs by department + (optional) vertical.
 *
 * Без `vertical` → legacy-поведение (для b2g — Бух-только ALL_ACTIVE_STATUS_IDS,
 * как сегодня). С `vertical` — Бух / Мед / объединение.
 */
export function getActiveStatusIds(department: string, vertical?: Vertical): number[] {
  if (department === "b2b") return B2B_ALL_ACTIVE_STATUS_IDS;
  // b2g
  if (vertical === "buh") return ALL_ACTIVE_STATUS_IDS;
  if (vertical === "med") return B2G_MED_ALL_ACTIVE_STATUS_IDS;
  if (vertical === "all") return [...ALL_ACTIVE_STATUS_IDS, ...B2G_MED_ALL_ACTIVE_STATUS_IDS];
  return ALL_ACTIVE_STATUS_IDS; // legacy default (Бух-только)
}

/** Нормализовать произвольную строку из query в Vertical (b2g). Дефолт — 'all'. */
export function parseVertical(raw: string | null | undefined): Vertical {
  return raw === "buh" || raw === "med" || raw === "all" ? raw : "all";
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

// ==================== B2G CUSTOM FIELDS (Бух Бератер leads) ====================
// Resolved by field_id (NOT name) — names can be renamed in Kommo, and the
// previous name-based findByName lost priority order through Set semantics:
// when both "Дата термина ДЦ" and "Дата термина" were present, whichever
// Kommo emitted first won. Field IDs are stable and disambiguate by intent.
//
// Termin dates power /api/dashboard/termins (cohort chart of avg days from
// deal creation → assigned termin).
//
// Verified live (2026-04-28) on Бух Бератер leads via inspect-one-lead.ts:
//   ┌─ field_id ─┬─ field_name ─────────┬─ when populated ─────────────────┐
//   │ 885996     │ "Дата термина"       │ legacy generic (older leads)
//   │ 887026     │ "Дата термина ДЦ"    │ NEWER specific — primary source
//   │ 887028     │ "Дата термина АА"    │ AA-specific
//   └────────────┴──────────────────────┴──────────────────────────────────┘
// sync-leads.ts reads `terminDate` from 887026 with explicit fallback to
// 885996 ONLY when 887026 is unset (legacy leads). `aaTerminDate` is read
// from 887028 with no fallback.
export const B2G_CUSTOM_FIELD_IDS = {
  /** "Дата термина ДЦ" — primary, specific to DC appointment. */
  terminDateDC: 887026,
  /** "Дата термина АА" — primary, specific to AA appointment. */
  terminDateAA: 887028,
  /** "Дата термина" — legacy generic; fallback for older leads only. */
  terminDateGeneric: 885996,
} as const;

/** @deprecated Kept only to avoid breaking external imports during transition.
 *  New code reads from `B2G_CUSTOM_FIELD_IDS`. Will be removed after the
 *  termin backfill rewrites every row using field-id matching. */
export const B2G_CUSTOM_FIELD_NAMES = {
  terminDate: [
    "Дата термина ДЦ",
    "Дата Термина ДЦ",
    "Дата термина",
    "Дата Термина",
  ],
  aaTerminDate: [
    "Дата термина АА",
    "Дата Термина АА",
    "Дата АА термина",
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
