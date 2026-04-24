// Metric definitions registry for the Daily tab
// Drives both frontend rendering and backend data mapping

import { b2bDailySections } from "./metrics-config-b2b";

export interface MetricDef {
  key: string;
  label: string;
  hasPlan: boolean;
  hasFact: boolean;
  unit: "" | "%" | "мин" | "шт" | "сек";
  /** Where the fact comes from */
  factSource: "kommo_tasks" | "computed" | "manual" | "db";
  /** If true, this is a group header row (no data) */
  isGroupHeader?: boolean;
}

export interface SectionDef {
  key: string;
  title: string;
  icon: string; // lucide icon name
  /** DB line value: '1' for qualifier, '2' for secondLine, 'funnel' for funnel, or B2B section keys */
  dbLine: string;
  /** If true, show per-manager columns */
  perManager: boolean;
  metrics: MetricDef[];
}

// ====================== FUNNEL SECTION ======================
// Department-wide pipeline metrics (no per-manager breakdown)
const funnelMetrics: MetricDef[] = [
  // --- Госники header (from Excel row 82-85) ---
  { key: "activeDeals", label: "Сделок на активных этапах, шт.", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "managersOnLine", label: "Менеджеров на линии, всего", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  // --- Лиды ---
  { key: "_grp_leads", label: "Лиды", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "totalLeads_p", label: "Всего лидов план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "totalLeads", label: "Всего лидов факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "qualLeads_p", label: "Всего квал лидов план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "qualLeads", label: "Всего квал лидов факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "qualLeadsPercent", label: "% квал. лидов", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  // Квал. разбивка A2 / B1 / B2+ — снапшот по статусам первой линии (формула из Excel)
  { key: "a2", label: "A2", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "b1", label: "B1", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "b2plus", label: "B2 и выше", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  // --- Воронка ---
  { key: "_grp_funnel", label: "Воронка", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "avgPortfolio", label: "Ср. портфель менеджера", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  // Направлено заданий / Передано на консультацию / их конверсии (формулы из Excel)
  { key: "tasksTotal", label: "Направлено заданий всего", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "tasksNew", label: "Направлено заданий новые", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "convQualTask", label: "Конверсия из квала в задание (новые)", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "consultTotal", label: "Передано на консультацию всего", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "consultNew", label: "Передано на консультацию новые", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "convTaskConsult", label: "Конверсия из задания в консультацию (новые)", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  // --- Воронка Бератер ---
  { key: "_grp_terms", label: "Воронка Бератер", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "termsTotal", label: "Переданы на термин всего", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "termsNew", label: "Переданы на термин новые", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "awaitTermTotal", label: "Ожидают термин всего", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "awaitTermNew", label: "Ожидают термин новые", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "convConsultTerm", label: "Конверсия из консультации в термин (новые)", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "termDCCancelled", label: "Термин ДЦ отменен/перенесен", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "termDCDone", label: "Термин ДЦ состоялся", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "termAATransferred", label: "Переведены на термин АА", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "termAACancelled", label: "Термин АА отменен/перенесен", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "termAACount", label: "Термин АА, шт.", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "beraterReview", label: "На рассмотрении бератера", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "delayedStart", label: "Отложенный старт", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "appeal", label: "Апелляция", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  // --- Результаты ---
  { key: "_grp_results", label: "Результаты", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "gutscheinsApproved", label: "Одобрено гутшайнов", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "beraterReject", label: "Отказ бератера", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "appealsSubmitted", label: "Подано апелляций", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "revenue", label: "Выручка факт, €", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
];

// ====================== QUALIFIER (1st LINE) SECTION ======================
const qualifierMetrics: MetricDef[] = [
  { key: "staffCount", label: "Кол-во сотрудников", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  // --- Звонки ---
  { key: "_grp_calls", label: "Звонки", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "callsTotal_p", label: "Количество звонков план", hasPlan: false, hasFact: true, unit: "шт", factSource: "computed" },
  { key: "callsTotal", label: "Количество звонков факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "callsConnected", label: "Дозвон от 1 сек.", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "dialPercent", label: "% дозвона", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
  { key: "missedIncoming", label: "Пропущенные входящие", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  // --- Время ---
  { key: "_grp_time", label: "Время", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "totalMinutes_p", label: "Всего на линии (мин) план", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "totalMinutes", label: "Всего на линии (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "avgDialogPerEmployee", label: "Ср. время в диалоге на сотр.", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "avgDialogMinutes", label: "Ср. время диалога", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  // --- Время ожидания ---
  { key: "avgWait_p", label: "Ср. время ожидания ответа (сек) план", hasPlan: false, hasFact: true, unit: "сек", factSource: "computed" },
  // --- Качество ---
  { key: "_grp_quality", label: "Качество", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "overdueTasks", label: "Просроченные задачи", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_tasks" },
  { key: "frozenLeads", label: "Замороженные лиды (без первого звонка)", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "regulationPercent", label: "Выполнение регламента, %", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "avgCallsPerLead", label: "Ср. касаний звонком на лид", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  { key: "sla_p", label: "SLA (мин) план", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "sla_f", label: "SLA от лида (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "sla_shift_f", label: "SLA от смены (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "tlt_f", label: "TLT (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "okk_p", label: "ОКК план", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "okk_f", label: "ОКК факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
  { key: "roleplay_p", label: "Оценка за ролевку план", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "roleplay_f", label: "Оценка за ролевку факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
];

// ====================== SECOND LINE SECTION ======================
const secondLineMetrics: MetricDef[] = [
  { key: "staffCount", label: "Кол-во сотрудников", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  // --- Звонки ---
  { key: "_grp_calls", label: "Звонки", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "callsTotal_p", label: "Количество звонков план", hasPlan: false, hasFact: true, unit: "шт", factSource: "computed" },
  { key: "callsTotal", label: "Количество звонков факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "callsConnected", label: "Дозвон от 1 сек.", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "dialPercent", label: "% дозвона", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
  { key: "missedIncoming", label: "Пропущенные входящие", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  // --- Время ---
  { key: "_grp_time", label: "Время", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "totalMinutes_p", label: "Всего на линии (мин) план", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "totalMinutes", label: "Всего на линии (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "avgDialogPerEmployee", label: "Ср. время в диалоге на сотр.", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "avgDialogMinutes", label: "Ср. время диалога", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "avgWait_p", label: "Ср. время ожидания ответа (сек) план", hasPlan: false, hasFact: true, unit: "сек", factSource: "computed" },
  // --- Качество ---
  { key: "_grp_quality", label: "Качество", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "overdueTasks", label: "Просроченные задачи", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_tasks" },
  { key: "regulationPercent", label: "Выполнение регламента, %", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "avgCallsPerLead", label: "Ср. касаний звонком на лид", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  { key: "okk_p", label: "ОКК план", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "okk_f", label: "ОКК факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
  { key: "roleplay_p", label: "Оценка за ролевку план", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "roleplay_f", label: "Оценка за ролевку факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
];

// ====================== THIRD LINE (Доведение) SECTION ======================
const thirdLineMetrics: MetricDef[] = [
  { key: "staffCount", label: "Кол-во сотрудников", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  // --- Звонки ---
  { key: "_grp_calls", label: "Звонки", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "callsTotal_p", label: "Количество звонков план", hasPlan: false, hasFact: true, unit: "шт", factSource: "computed" },
  { key: "callsTotal", label: "Количество звонков факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "callsConnected", label: "Дозвон от 1 сек.", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "dialPercent", label: "% дозвона", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
  { key: "missedIncoming", label: "Пропущенные входящие", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  // --- Время ---
  { key: "_grp_time", label: "Время", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "totalMinutes_p", label: "Всего на линии (мин) план", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "totalMinutes", label: "Всего на линии (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "avgDialogPerEmployee", label: "Ср. время в диалоге на сотр.", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "avgDialogMinutes", label: "Ср. время диалога", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "avgWait_p", label: "Ср. время ожидания ответа (сек) план", hasPlan: false, hasFact: true, unit: "сек", factSource: "computed" },
  // --- Качество ---
  { key: "_grp_quality", label: "Качество", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "overdueTasks", label: "Просроченные задачи", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_tasks" },
  { key: "regulationPercent", label: "Выполнение регламента, %", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "avgCallsPerLead", label: "Ср. касаний звонком на лид", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  { key: "sla_p", label: "SLA (мин) план", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "sla_f", label: "SLA от лида (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "sla_shift_f", label: "SLA от смены (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "tlt_f", label: "TLT (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "okk_p", label: "ОКК план", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "okk_f", label: "ОКК факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
  { key: "roleplay_p", label: "Оценка за ролевку план", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "roleplay_f", label: "Оценка за ролевку факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
];

// ====================== SECTIONS EXPORT ======================

export const dailySections: SectionDef[] = [
  {
    key: "funnel",
    title: "Сделки на активных этапах и Воронка",
    icon: "TrendingUp",
    // dbLine='1' — funnel shares line-1 plan storage (totalLeads_p/qualLeads_p
    // etc come into квалификатор). Stale line='funnel' rows were dropped
    // 2026-04-24; this keeps UI saves consistent with imported daily plans.
    dbLine: "1",
    perManager: false,
    metrics: funnelMetrics,
  },
  {
    key: "qualifier",
    title: "Менеджер-квалификатор (Первая линия)",
    icon: "Users",
    dbLine: "1",
    perManager: true,
    metrics: qualifierMetrics,
  },
  {
    key: "secondLine",
    title: "Менеджер второй линии",
    icon: "Activity",
    dbLine: "2",
    perManager: true,
    metrics: secondLineMetrics,
  },
  {
    key: "thirdLine",
    title: "Доведение (Третья линия)",
    icon: "Activity",
    dbLine: "3",
    perManager: true,
    metrics: thirdLineMetrics,
  },
];

/** Get all metric keys that have hasPlan=true across all sections */
export function getEditableMetricKeys(): { section: string; key: string; label: string }[] {
  const result: { section: string; key: string; label: string }[] = [];
  for (const section of dailySections) {
    for (const metric of section.metrics) {
      if (metric.hasPlan && !metric.isGroupHeader) {
        result.push({ section: section.key, key: metric.key, label: metric.label });
      }
    }
  }
  return result;
}

/** Get sections by department — B2G uses line-based structure, B2B uses product/channel-based */
export function getDailySections(department: string): SectionDef[] {
  if (department === "b2b") return b2bDailySections;
  return dailySections;
}
