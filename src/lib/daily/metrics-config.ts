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
  factSource: "kommo_calls" | "kommo_leads" | "kommo_tasks" | "computed" | "manual" | "db";
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
  { key: "gutscheinsApproved_p", label: "Гутшайн Total план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "gutscheinsApproved", label: "Гутшайн Total факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "gutscheinPlanDone", label: "Выполненного плана %", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "activeDeals", label: "Всего лидов в работе", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "totalLeads_p", label: "Всего лидов план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "totalLeads", label: "Всего лидов факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  // --- Воронка ---
  { key: "_grp_funnel", label: "Воронка", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "qualLeads", label: "Всего квал лидов", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "qualLeadsPercent", label: "% квал. лидов", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "managersOnLine", label: "Менеджеров на линии", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  { key: "avgPortfolio", label: "Ср. портфель менеджера", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  // --- Воронка Бератер ---
  { key: "_grp_terms", label: "Воронка Бератер", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "termsTotal", label: "Переданы на термин всего", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "termsNew", label: "Переданы на термин новые", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "awaitTermTotal", label: "Ожидают термин всего", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "awaitTermNew", label: "Ожидают термин новые", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "termDCCancelled", label: "Термин ДЦ отменен/перенесен", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "termDCDone", label: "Термин ДЦ состоялся", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "termAATransferred", label: "Переведены на термин АА", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "termAACancelled", label: "Термин АА отменен/перенесен", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "termAACount", label: "Термин АА, шт.", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "beraterReview", label: "На рассмотрении бератера", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "delayedStart", label: "Отложенный старт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "appeal", label: "Апелляция", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
];

// ====================== QUALIFIER (1st LINE) SECTION ======================
const qualifierMetrics: MetricDef[] = [
  { key: "staffCount_p", label: "Менеджеров на линии план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "staffCount", label: "Менеджеров на линии факт", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  // --- Звонки ---
  { key: "_grp_calls", label: "Звонки", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "callsTotal_p", label: "Количество звонков план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "callsTotal", label: "Количество звонков факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  { key: "callsConnected", label: "Дозвон от 1 сек.", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  { key: "dialPercent_p", label: "% дозвона план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "dialPercent", label: "% дозвона факт", hasPlan: false, hasFact: true, unit: "%", factSource: "kommo_calls" },
  { key: "missedIncoming", label: "Пропущенные входящие", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  // --- Время ---
  { key: "_grp_time", label: "Время", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "totalMinutes_p", label: "Всего на линии (мин) план", hasPlan: true, hasFact: false, unit: "мин", factSource: "manual" },
  { key: "totalMinutes", label: "Всего на линии (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "kommo_calls" },
  { key: "avgDialogPerEmployee", label: "Ср. время в диалоге на сотр.", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "avgDialogMinutes", label: "Ср. время диалога", hasPlan: false, hasFact: true, unit: "мин", factSource: "kommo_calls" },
  // --- Качество ---
  { key: "_grp_quality", label: "Качество", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "overdueTasks", label: "Просроченные задачи", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_tasks" },
];

// ====================== SECOND LINE SECTION ======================
const secondLineMetrics: MetricDef[] = [
  { key: "staffCount_p", label: "Менеджеров на линии план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "staffCount", label: "Менеджеров на линии факт", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  // --- Звонки ---
  { key: "_grp_calls", label: "Звонки", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "callsTotal_p", label: "Количество звонков план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "callsTotal", label: "Количество звонков факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  { key: "callsConnected", label: "Дозвон от 1 сек.", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  { key: "dialPercent_p", label: "% дозвона план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "dialPercent", label: "% дозвона факт", hasPlan: false, hasFact: true, unit: "%", factSource: "kommo_calls" },
  { key: "missedIncoming", label: "Пропущенные входящие", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  // --- Время ---
  { key: "_grp_time", label: "Время", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "totalMinutes_p", label: "Всего на линии (мин) план", hasPlan: true, hasFact: false, unit: "мин", factSource: "manual" },
  { key: "totalMinutes", label: "Всего на линии (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "kommo_calls" },
  { key: "avgDialogPerEmployee", label: "Ср. время в диалоге на сотр.", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "avgDialogMinutes", label: "Ср. время диалога", hasPlan: false, hasFact: true, unit: "мин", factSource: "kommo_calls" },
  // --- Качество ---
  { key: "_grp_quality", label: "Качество", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "overdueTasks", label: "Просроченные задачи", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_tasks" },
];

// ====================== THIRD LINE (Доведение) SECTION ======================
const thirdLineMetrics: MetricDef[] = [
  { key: "staffCount_p", label: "Менеджеров на линии план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "staffCount", label: "Менеджеров на линии факт", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  // --- Звонки ---
  { key: "_grp_calls", label: "Звонки", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "callsTotal_p", label: "Количество звонков план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "callsTotal", label: "Количество звонков факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  { key: "callsConnected", label: "Дозвон от 1 сек.", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  { key: "dialPercent_p", label: "% дозвона план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "dialPercent", label: "% дозвона факт", hasPlan: false, hasFact: true, unit: "%", factSource: "kommo_calls" },
  { key: "missedIncoming", label: "Пропущенные входящие", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  // --- Время ---
  { key: "_grp_time", label: "Время", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "totalMinutes_p", label: "Всего на линии (мин) план", hasPlan: true, hasFact: false, unit: "мин", factSource: "manual" },
  { key: "totalMinutes", label: "Всего на линии (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "kommo_calls" },
  { key: "avgDialogPerEmployee", label: "Ср. время в диалоге на сотр.", hasPlan: false, hasFact: true, unit: "мин", factSource: "computed" },
  { key: "avgDialogMinutes", label: "Ср. время диалога", hasPlan: false, hasFact: true, unit: "мин", factSource: "kommo_calls" },
  // --- Качество ---
  { key: "_grp_quality", label: "Качество", hasPlan: false, hasFact: false, unit: "", factSource: "manual", isGroupHeader: true },
  { key: "overdueTasks", label: "Просроченные задачи", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_tasks" },
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
