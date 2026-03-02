// Metric definitions registry for the Daily tab
// Drives both frontend rendering and backend data mapping

export interface MetricDef {
  key: string;
  label: string;
  hasPlan: boolean;
  hasFact: boolean;
  unit: "" | "%" | "мин" | "шт" | "сек";
  /** Where the fact comes from */
  factSource: "kommo_calls" | "kommo_leads" | "kommo_tasks" | "computed" | "manual" | "db";
  /** If true, this is a group header row (no data) */
  isGroupHeader?: boolean;
}

export interface SectionDef {
  key: "funnel" | "qualifier" | "secondLine";
  title: string;
  icon: string; // lucide icon name
  /** DB line value: '1' for qualifier, '2' for secondLine, 'funnel' for funnel */
  dbLine: string;
  /** If true, show per-manager columns */
  perManager: boolean;
  metrics: MetricDef[];
}

// ====================== FUNNEL SECTION ======================
// Department-wide pipeline metrics (no per-manager breakdown)
const funnelMetrics: MetricDef[] = [
  { key: "activeDeals", label: "Сделок на активных этапах, шт.", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "managersOnLine", label: "Менеджеров на линии, всего", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  // --- Лиды ---
  { key: "_grp_leads", label: "Лиды", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "totalLeads", label: "Всего лидов", hasPlan: true, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "qualLeads", label: "Всего квал лидов", hasPlan: true, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "qualLeadsPercent", label: "% квал. лидов", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  // --- Этапы воронки ---
  { key: "_grp_funnel", label: "Воронка", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "a2", label: "A2", hasPlan: false, hasFact: true, unit: "", factSource: "kommo_leads" },
  { key: "b1", label: "B1", hasPlan: false, hasFact: true, unit: "", factSource: "kommo_leads" },
  { key: "b2plus", label: "B2 и выше", hasPlan: false, hasFact: true, unit: "", factSource: "kommo_leads" },
  { key: "avgPortfolio", label: "Ср. портфель менеджера", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  // --- Задания ---
  { key: "_grp_tasks", label: "Задания и консультации", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "tasksTotal", label: "Направлено заданий всего", hasPlan: true, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "tasksNew", label: "Направлено заданий новые", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "convQualTask", label: "Конверсия (квал → задание)", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "consultTotal", label: "Передано на консультацию всего", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "consultNew", label: "Передано на консультацию новые", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "convTaskConsult", label: "Конверсия (задание → консультация)", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  // --- Термины ---
  { key: "_grp_terms", label: "Термины", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "termsTotal", label: "Переданы на термин всего", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "termsNew", label: "Переданы на термин новые", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "awaitTermTotal", label: "Ожидают термин всего", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "awaitTermNew", label: "Ожидают термин новые", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "convConsultTerm", label: "Конверсия: консультация → термин", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "termDCCancelled", label: "Термин ДЦ отменен/перенесен", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "termDCDone", label: "Термин ДЦ состоялся", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "termAA", label: "Переведены на термин АА", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "termAACancelled", label: "Термин АА отменен/перенесен", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "termAADone", label: "Термин АА", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  // --- Результаты ---
  { key: "_grp_results", label: "Результаты", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "beraterReview", label: "На рассмотрении бератера", hasPlan: false, hasFact: true, unit: "", factSource: "kommo_leads" },
  { key: "delayedStart", label: "Отложенный старт", hasPlan: false, hasFact: true, unit: "", factSource: "kommo_leads" },
  { key: "appeal", label: "Апелляция", hasPlan: false, hasFact: true, unit: "", factSource: "kommo_leads" },
  { key: "gutscheinsApproved", label: "Одобрено гутшайнов", hasPlan: true, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "beraterReject", label: "Отказ бератора", hasPlan: false, hasFact: true, unit: "", factSource: "kommo_leads" },
  { key: "appealsSubmitted", label: "Подано апелляций", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
];

// ====================== QUALIFIER (1st LINE) SECTION ======================
const qualifierMetrics: MetricDef[] = [
  { key: "staffCount", label: "Кол-во сотрудников", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  // --- Звонки ---
  { key: "_grp_calls", label: "Звонки", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "callsTotal", label: "Количество звонков", hasPlan: true, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  { key: "callsConnected", label: "Дозвон от 1 сек.", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  { key: "dialPercent", label: "% дозвона", hasPlan: false, hasFact: true, unit: "%", factSource: "kommo_calls" },
  { key: "missedIncoming", label: "Пропущенные входящие", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  // --- Время ---
  { key: "_grp_time", label: "Время", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "totalMinutes", label: "Всего на линии (мин)", hasPlan: true, hasFact: true, unit: "мин", factSource: "kommo_calls" },
  { key: "avgDialogPerEmployee", label: "Ср. время в диалоге на сотр.", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "avgDialogMinutes", label: "Ср. время диалога", hasPlan: false, hasFact: true, unit: "мин", factSource: "kommo_calls" },
  // --- Качество ---
  { key: "_grp_quality", label: "Качество", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "overdueTasks", label: "Просроченные задачи", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_tasks" },
  { key: "sla", label: "SLA (мин)", hasPlan: true, hasFact: true, unit: "мин", factSource: "manual" },
  { key: "okk", label: "ОКК", hasPlan: true, hasFact: true, unit: "%", factSource: "manual" },
];

// ====================== SECOND LINE SECTION ======================
const secondLineMetrics: MetricDef[] = [
  { key: "staffCount", label: "Кол-во сотрудников", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  // --- Звонки ---
  { key: "_grp_calls", label: "Звонки", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "callsTotal", label: "Количество звонков", hasPlan: true, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  { key: "callsConnected", label: "Дозвон от 1 сек.", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  { key: "dialPercent", label: "% дозвона", hasPlan: false, hasFact: true, unit: "%", factSource: "kommo_calls" },
  { key: "missedIncoming", label: "Пропущенные входящие", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  // --- Время ---
  { key: "_grp_time", label: "Время", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "totalMinutes", label: "Всего на линии (мин)", hasPlan: true, hasFact: true, unit: "мин", factSource: "kommo_calls" },
  { key: "avgDialogPerEmployee", label: "Ср. время в диалоге на сотр.", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "avgDialogMinutes", label: "Ср. время диалога", hasPlan: false, hasFact: true, unit: "мин", factSource: "kommo_calls" },
  // --- Качество ---
  { key: "_grp_quality", label: "Качество", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "overdueTasks", label: "Просроченные задачи", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_tasks" },
  { key: "sla", label: "SLA (мин)", hasPlan: true, hasFact: true, unit: "мин", factSource: "manual" },
  { key: "okk", label: "ОКК", hasPlan: true, hasFact: true, unit: "%", factSource: "manual" },
];

// ====================== SECTIONS EXPORT ======================

export const dailySections: SectionDef[] = [
  {
    key: "funnel",
    title: "Сделки на активных этапах и Воронка",
    icon: "TrendingUp",
    dbLine: "funnel",
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
