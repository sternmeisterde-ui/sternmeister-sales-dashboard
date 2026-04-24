// B2B (Коммерция) Daily — спецификация: docs/daily-commerce-spec.md
//
// Convention (updated 2026-04-24):
//   Все метрики с "План" в названии — EDITABLE (hasPlan:true). Если пользователь
//   не ввёл — показывается computed-значение (см. getB2BFact fallback).
//   Выручка _f тоже редактируемая — пользователь может перекрыть SQL-факт
//   ручным значением если нужно.

import type { MetricDef, SectionDef } from "./metrics-config";

// ====================== 1. ПРОДАЖИ ТОТАЛ (R5–R19) ======================
const salesTotalMetrics: MetricDef[] = [
  { key: "total_revenueTotal_p", label: "Выручка Total план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "total_revenueTotal_f", label: "Выручка Total факт", hasPlan: true, hasFact: true, unit: "", factSource: "computed" },
  { key: "total_newRevenue_p", label: "Новая выручка план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "total_newRevenue_f", label: "Новая выручка факт", hasPlan: true, hasFact: true, unit: "", factSource: "computed" },
  { key: "total_komLeads_p", label: "Всего ком. лидов план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "total_komLeads_f", label: "Всего ком. лидов факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "computed" },
  { key: "total_sales_p", label: "Количество продаж план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "total_sales_f", label: "Количество продаж факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "computed" },
  { key: "total_prepayments", label: "Количество предоплат", hasPlan: false, hasFact: true, unit: "шт", factSource: "computed" },
  { key: "total_ql2p_p", label: "QL2P план %", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "total_ql2p_f", label: "QL2P факт %", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "total_avgCheck_p", label: "Средний чек план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "total_avgCheck_f", label: "Средний чек факт", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "total_planDoneTotal", label: "Выполнено плана TOTAL", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "total_planDoneNew", label: "Выполнено плана NEW", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
];

// ====================== 2. ПРОДАЖИ БУХ (R21–R35) ======================
const salesBuhMetrics: MetricDef[] = [
  { key: "buh_salesPlusRenewals_p", label: "Продажи + Продления Total Бух план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "buh_salesPlusRenewals_f", label: "Продажи + Продления Total Бух факт", hasPlan: true, hasFact: true, unit: "", factSource: "computed" },
  { key: "buh_newRevenue_p", label: "Новая выручка Бух план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "buh_newRevenue_f", label: "Новая выручка Бух факт", hasPlan: true, hasFact: true, unit: "", factSource: "kommo_leads" },
  { key: "buh_komLeads_p", label: "Квал ком. Бух лидов план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "buh_komLeads_f", label: "Квал ком. Бух лидов факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "buh_sales_p", label: "Количество продаж Бух план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "buh_sales_f", label: "Количество продаж Бух факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "buh_prepayments", label: "Количество предоплат Бух", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "buh_ql2p_p", label: "QL2P Бух план %", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "buh_ql2p_f", label: "QL2P Бух факт %", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "buh_avgCheck_p", label: "Средний чек Бух план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "buh_avgCheck_f", label: "Средний чек Бух факт", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "buh_planDoneTotal", label: "Выполнено плана TOTAL БУХ", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "buh_planDoneNew", label: "Выполнено плана NEW БУХ", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
];

// ====================== 3. ПРОДАЖИ МЕД (R37–R51) ======================
const salesMedMetrics: MetricDef[] = [
  { key: "med_salesPlusRenewals_p", label: "Продажи + Продления Total Мед план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "med_salesPlusRenewals_f", label: "Продажи + Продления Total Мед факт", hasPlan: true, hasFact: true, unit: "", factSource: "computed" },
  { key: "med_newRevenue_p", label: "Новая выручка Мед план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "med_newRevenue_f", label: "Новая выручка Мед факт", hasPlan: true, hasFact: true, unit: "", factSource: "kommo_leads" },
  { key: "med_komLeads_p", label: "Квал ком. Мед лидов план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "med_komLeads_f", label: "Квал ком. Мед лидов факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "med_sales_p", label: "Количество продаж Мед план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "med_sales_f", label: "Количество продаж Мед факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "med_prepayments", label: "Количество предоплат Мед", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_leads" },
  { key: "med_ql2p_p", label: "QL2P Мед план %", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "med_ql2p_f", label: "QL2P Мед факт %", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "med_avgCheck_p", label: "Средний чек Мед план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "med_avgCheck_f", label: "Средний чек Мед факт", hasPlan: false, hasFact: true, unit: "", factSource: "computed" },
  { key: "med_planDoneTotal", label: "Выполнено плана TOTAL МЕД", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
  { key: "med_planDoneNew", label: "Выполнено плана NEW МЕД", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
];

// ====================== 4. ЗВОНКИ + ОКК (R53–R72) ======================
const callsMetrics: MetricDef[] = [
  { key: "calls_managersOnLine_p", label: "Менеджеров на линии план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  // Факт: unique managers on_line в период из manager_schedule.
  { key: "calls_managersOnLine_f", label: "Менеджеров на линии факт", hasPlan: false, hasFact: true, unit: "", factSource: "db" },
  { key: "calls_total_p", label: "Количество звонков план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "calls_total_f", label: "Количество звонков факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "kommo_calls" },
  { key: "calls_totalMinutes_p", label: "Всего на линии (минут) план", hasPlan: true, hasFact: false, unit: "мин", factSource: "manual" },
  { key: "calls_totalMinutes_f", label: "Всего на линии (минут) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "kommo_calls" },
  { key: "calls_avgWait_p", label: "Среднее время ожидания ответа (сек) план", hasPlan: true, hasFact: false, unit: "сек", factSource: "manual" },
  // Факт ожидания — ручной ввод (source Callgear, пока не подключён).
  { key: "calls_avgWait_f", label: "Среднее время ожидания ответа (сек) факт", hasPlan: true, hasFact: false, unit: "сек", factSource: "manual" },
  { key: "calls_dialPercent_p", label: "% дозвона план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "calls_dialPercent_f", label: "% дозвона факт", hasPlan: false, hasFact: true, unit: "%", factSource: "kommo_calls" },
  { key: "calls_sla_p", label: "SLA (мин) план", hasPlan: true, hasFact: false, unit: "мин", factSource: "manual" },
  { key: "calls_sla_f", label: "SLA (мин) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "calls_frozenLeads_f", label: "Замороженные лиды (без первого звонка)", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "okk_buh1_p", label: "ОКК Бух 1 план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "okk_buh1_f", label: "ОКК Бух 1 факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
  { key: "okk_buh2_p", label: "ОКК Бух 2 план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "okk_buh2_f", label: "ОКК Бух 2 факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
  { key: "okk_med1_p", label: "ОКК Мед 1 план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "okk_med1_f", label: "ОКК Мед 1 факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
  { key: "okk_avg_p", label: "ОКК средний % план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "okk_avg_f", label: "ОКК средний % факт", hasPlan: false, hasFact: true, unit: "%", factSource: "computed" },
];

export const b2bDailySections: SectionDef[] = [
  { key: "salesTotal", title: "Продажи ТОТАЛ", icon: "DollarSign",     dbLine: "salesTotal", perManager: false, metrics: salesTotalMetrics },
  { key: "salesBuh",   title: "Продажи Бух",   icon: "DollarSign",     dbLine: "salesBuh",   perManager: true,  metrics: salesBuhMetrics },
  { key: "salesMed",   title: "Продажи Мед",   icon: "Heart",          dbLine: "salesMed",   perManager: true,  metrics: salesMedMetrics },
  { key: "calls",      title: "Звонки",        icon: "Phone",          dbLine: "calls",      perManager: true,  metrics: callsMetrics },
];

export const B2B_FIXED_PLAN_DEFAULTS: Record<string, number> = {
  total_ql2p_p: 8,
  buh_ql2p_p: 8,
  calls_avgWait_p: 35,
  calls_dialPercent_p: 65,
  calls_sla_p: 25,
  okk_buh1_p: 85,
  okk_buh2_p: 85,
  okk_med1_p: 85,
};
