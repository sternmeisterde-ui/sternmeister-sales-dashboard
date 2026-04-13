// B2B (коммерция) metric definitions for the Daily tab
// Mirrors Excel "Числа Daily Weekly Monthly.xlsx" → Daily_Numbers sheet
// Layout matches Excel: plan and fact are SEPARATE ROWS
//
// Convention:
//   key ending "_p" = plan row (fact value = plan target from DB)
//   key ending "_f" = fact row (fact value = computed/Kommo)
//   Metrics without plan/fact split are single rows

import type { MetricDef, SectionDef } from "./metrics-config";

// ====================== TOTAL UE (Unit Economics) ======================
const totalUEMetrics: MetricDef[] = [
  { key: "ue_ltv", label: "LTV", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "ue_cac_p", label: "CAC", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "ue_cac_f", label: "CAC факт", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "ue_ltv_cac", label: "LTV/CAC", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "ue_leadsTotal", label: "Лиды тотал", hasPlan: false, hasFact: true, unit: "шт", factSource: "computed" },
  { key: "ue_leadsQual", label: "Лиды категории А и Б", hasPlan: false, hasFact: true, unit: "шт", factSource: "computed" },
  { key: "ue_budget", label: "Потраченный бюджет", hasPlan: false, hasFact: true, unit: "", factSource: "manual" },
  { key: "ue_revenue_p", label: "Выручка план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "ue_revenue_f", label: "Выручка факт", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "ue_conversion_p", label: "Конверсия % план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "ue_conversion_f", label: "Конверсия % факт", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
];

// ====================== MARKETING ======================
const marketingMetrics: MetricDef[] = [
  { key: "mkt_cac", label: "Маркетинг CAC", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "mkt_cpl", label: "CPL", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "mkt_leads", label: "Лиды #", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "mkt_leadsABC", label: "Лиды категории A, B, C", hasPlan: false, hasFact: true, unit: "", factSource: "kommo_leads" },
  { key: "mkt_nonQualLeads_p", label: "Неквал лиды # план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "mkt_nonQualLeads_f", label: "Неквал лиды # факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "mkt_budget_p", label: "Бюджет план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "mkt_budget_f", label: "Бюджет факт", hasPlan: false, hasFact: true, unit: "", factSource: "manual" },
];

// ====================== INFLUENCE MARKETING ======================
const influenceMetrics: MetricDef[] = [
  { key: "inf_budget", label: "Бюджет", hasPlan: false, hasFact: true, unit: "", factSource: "manual" },
  { key: "inf_cpl", label: "CPL", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "inf_leads", label: "Лиды", hasPlan: false, hasFact: true, unit: "шт", factSource: "manual" },
  { key: "inf_leadsABC", label: "Лиды категории A, B, C", hasPlan: false, hasFact: true, unit: "шт", factSource: "manual" },
  { key: "inf_cpql", label: "CPQL", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "inf_nonQualLeads", label: "Неквал лиды #", hasPlan: false, hasFact: true, unit: "шт", factSource: "manual" },
  { key: "inf_crLeadQual", label: "CR лид/квал", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "inf_sales", label: "Количество продаж", hasPlan: false, hasFact: true, unit: "шт", factSource: "manual" },
  { key: "inf_cac", label: "CAC", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "inf_crQualSale", label: "CR квал/продажа", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "inf_aov", label: "AOV", hasPlan: false, hasFact: true, unit: "", factSource: "manual" },
  { key: "inf_revenue", label: "Revenue", hasPlan: false, hasFact: true, unit: "", factSource: "manual" },
  { key: "inf_romi", label: "ROMI", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
];

// ====================== FB MARKETING ======================
const fbMetrics: MetricDef[] = [
  { key: "fb_budget", label: "Бюджет", hasPlan: false, hasFact: true, unit: "", factSource: "manual" },
  { key: "fb_cpl", label: "CPL", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "fb_leads", label: "Лиды", hasPlan: false, hasFact: true, unit: "шт", factSource: "manual" },
  { key: "fb_leadsABC", label: "Лиды категории A, B, C", hasPlan: false, hasFact: true, unit: "шт", factSource: "manual" },
  { key: "fb_cpql", label: "CPQL", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "fb_nonQualLeads", label: "Неквал лиды #", hasPlan: false, hasFact: true, unit: "шт", factSource: "manual" },
  { key: "fb_crLeadQual", label: "CR лид/квал", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "fb_sales", label: "Количество продаж", hasPlan: false, hasFact: true, unit: "шт", factSource: "manual" },
  { key: "fb_cac", label: "FB CAC", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "fb_crQualSale", label: "CR квал/продажа", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "fb_romi", label: "ROMI", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
];

// ====================== ПРОДАЖИ ТОТАЛ (header) ======================
const salesTotalMetrics: MetricDef[] = [
  { key: "st_salesPlusRenewals_p", label: "Продажи + Продления Total план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "st_salesPlusRenewals_f", label: "Продажи + Продления Total факт", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
];

// ====================== ПРОДАЖИ БУХ ======================
// Excel rows 48-66: each plan/fact is a separate row
const salesBuhMetrics: MetricDef[] = [
  { key: "buh_salesPlusRenewals_p", label: "Продажи Бух + Продления Бух Total план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "buh_salesPlusRenewals_f", label: "Продажи Бух + Продления Бух Total факт", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "buh_revenue_p", label: "Новая выручка Бух план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "buh_revenue_f", label: "Новая выручка Бух факт", hasPlan: false, hasFact: true, unit: "", factSource: "kommo_leads" },
  { key: "buh_komLeads_p", label: "Всего ком. Бух лидов план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "buh_komLeads_f", label: "Всего ком. Бух лидов факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "buh_totalLeads_p", label: "Всего лидов план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "buh_totalLeads_f", label: "Всего лидов факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "buh_sales_p", label: "Количество продаж Бух план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "buh_sales_f", label: "Количество продаж Бух факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "buh_prepayments", label: "Количество предоплат Бух", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "buh_ql2p_p", label: "QL2P Бух план %", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "buh_ql2p_f", label: "QL2P Бух факт %", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "buh_l2p_p", label: "L2P Total план %", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "buh_l2p_f", label: "L2P Total факт %", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "buh_avgCheck_p", label: "Средний чек Бух план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "buh_avgCheck_f", label: "Средний чек Бух факт", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "buh_planDone", label: "Выполнено плана %", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
];

// ====================== ПРОДАЖИ МЕД ======================
// Excel rows 67-81
const salesMedMetrics: MetricDef[] = [
  { key: "med_salesPlusRenewals_p", label: "Продажи Мед + Продления Мед Total план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "med_salesPlusRenewals_f", label: "Продажи Мед + Продления Мед Total факт", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "med_revenue_p", label: "Новая выручка Мед план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "med_revenue_f", label: "Новая выручка Мед факт", hasPlan: false, hasFact: true, unit: "", factSource: "kommo_leads" },
  { key: "med_komLeads_p", label: "Всего ком. Мед лидов план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "med_komLeads_f", label: "Всего ком. Мед лидов факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "med_sales_p", label: "Количество продаж Мед план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "med_sales_f", label: "Количество продаж Мед факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "med_prepayments", label: "Количество предоплат Мед", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "med_ql2p_p", label: "QL2P Мед план %", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "med_ql2p_f", label: "QL2P Мед факт %", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "med_avgCheck_p", label: "Средний чек Мед план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "med_avgCheck_f", label: "Средний чек Мед факт", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "med_planDone", label: "Выполнено плана %", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
];

// ====================== ЗВОНКИ ======================
// Excel rows 103-115: plan/fact separate
const callsMetrics: MetricDef[] = [
  { key: "calls_managersOnLine_p", label: "Менеджеров на линии план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "calls_managersOnLine_f", label: "Менеджеров на линии факт", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  { key: "calls_total_p", label: "Количество звонков план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "calls_total_f", label: "Количество звонков факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  { key: "calls_totalMinutes_p", label: "Всего на линии (минут) план", hasPlan: true, hasFact: false, unit: "мин", factSource: "manual" },
  { key: "calls_totalMinutes_f", label: "Всего на линии (минут) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "kommo_calls" },
  { key: "calls_avgWait_p", label: "Среднее время ожидания ответа (сек) план", hasPlan: true, hasFact: false, unit: "сек", factSource: "manual" },
  { key: "calls_avgWait_f", label: "Среднее время ожидания ответа (сек) факт", hasPlan: false, hasFact: true, unit: "сек", factSource: "manual" },
  { key: "calls_dialPercent_p", label: "% дозвона план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "calls_dialPercent_f", label: "% дозвона факт", hasPlan: false, hasFact: true, unit: "%", factSource: "kommo_calls" },
  { key: "calls_sla_p", label: "SLA (мин) план", hasPlan: true, hasFact: false, unit: "мин", factSource: "manual" },
  { key: "calls_sla_f", label: "SLA (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "manual" },
];

// ====================== ОКК ======================
// Excel rows 116-123: plan/fact separate
const okkMetrics: MetricDef[] = [
  { key: "okk_buh1_p", label: "ОКК Бух 1 план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "okk_buh1_f", label: "ОКК Бух 1 факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
  { key: "okk_buh2_p", label: "ОКК Бух 2 план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "okk_buh2_f", label: "ОКК Бух 2 факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
  { key: "okk_med_p", label: "ОКК Мед план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "okk_med_f", label: "ОКК Мед факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
  { key: "okk_avg_p", label: "ОКК средний % план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "okk_avg_f", label: "ОКК средний % факт", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
];

// ====================== ПРОДЛЕНИЯ ======================
// Excel rows 124-166
const renewalStreamDates = [
  "29.04", "27.05", "27.06", "28.07", "29.08", "29.09",
  "17.10", "10.11", "28.11", "8.12", "19.01", "9.02", "9.03",
];

const renewalMetrics: MetricDef[] = [
  { key: "ren_totalRevenue_p", label: "Общая выручка план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "ren_totalRevenue_f", label: "Общая выручка факт", hasPlan: false, hasFact: true, unit: "", factSource: "manual" },
  { key: "ren_totalToPay", label: "Всего к оплате по всем потокам", hasPlan: false, hasFact: true, unit: "", factSource: "manual" },
  ...renewalStreamDates.flatMap((d): MetricDef[] => [
    { key: `ren_${d}_plan`, label: `Выручка ${d} план`, hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
    { key: `ren_${d}_fact`, label: `Выручка ${d} факт`, hasPlan: false, hasFact: true, unit: "", factSource: "manual" },
    { key: `ren_${d}_toPay`, label: `Выручка ${d} к оплате`, hasPlan: false, hasFact: true, unit: "", factSource: "manual" },
  ]),
];

// ====================== B2B SECTIONS EXPORT ======================

export const b2bDailySections: SectionDef[] = [
  {
    key: "totalUE",
    title: "Total UE",
    icon: "TrendingUp",
    dbLine: "totalUE",
    perManager: false,
    metrics: totalUEMetrics,
  },
  {
    key: "marketing",
    title: "Marketing",
    icon: "Megaphone",
    dbLine: "marketing",
    perManager: false,
    metrics: marketingMetrics,
  },
  {
    key: "influence",
    title: "Influence Marketing",
    icon: "Users",
    dbLine: "influence",
    perManager: false,
    metrics: influenceMetrics,
  },
  {
    key: "fbMarketing",
    title: "FB Marketing",
    icon: "Globe",
    dbLine: "fbMarketing",
    perManager: false,
    metrics: fbMetrics,
  },
  {
    key: "salesTotal",
    title: "Продажи ТОТАЛ",
    icon: "DollarSign",
    dbLine: "salesTotal",
    perManager: false,
    metrics: salesTotalMetrics,
  },
  {
    key: "salesBuh",
    title: "Продажи Бух",
    icon: "DollarSign",
    dbLine: "salesBuh",
    perManager: true,
    metrics: salesBuhMetrics,
  },
  {
    key: "salesMed",
    title: "Продажи Мед",
    icon: "Heart",
    dbLine: "salesMed",
    perManager: true,
    metrics: salesMedMetrics,
  },
  {
    key: "b2bCalls",
    title: "Звонки",
    icon: "Phone",
    dbLine: "b2bCalls",
    perManager: true,
    metrics: callsMetrics,
  },
  {
    key: "okk",
    title: "ОКК",
    icon: "ClipboardCheck",
    dbLine: "okk",
    perManager: false,
    metrics: okkMetrics,
  },
  {
    key: "renewals",
    title: "Продления",
    icon: "RefreshCw",
    dbLine: "renewals",
    perManager: false,
    metrics: renewalMetrics,
  },
];
