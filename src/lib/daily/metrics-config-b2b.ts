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
// Keyed to Excel "Daily_Numbers" rows 47-67 / columns NC-OF:
//   R21=row50, R22=row51, R23=row52, R24=row53, R25=row54, R26=row55,
//   R27=row58, R28=row59, R29=row60, R30=row61, R31=row62,
//   R32=row65, R33=row66, R34=row67, + Продления (row126-127).
const salesBuhMetrics: MetricDef[] = [
  { key: "buh_salesPlusRenewals_p", label: "Продажи + Продления Total Бух план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "buh_salesPlusRenewals_f", label: "Продажи + Продления Total Бух факт", hasPlan: true, hasFact: true, unit: "", factSource: "computed" },
  { key: "buh_newRevenue_p", label: "Новая выручка Бух план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "buh_newRevenue_f", label: "Новая выручка Бух факт", hasPlan: true, hasFact: true, unit: "", factSource: "db" },
  // Продления Бух — Excel row126/127 "Общая выручка план/факт" внутри блока
  // "Продления" (rows 125-170), изначально суммировалось по датам окончания
  // платёжных планов. В дашборде — один агрегированный редактируемый ввод.
  { key: "buh_renewalsRevenue_p", label: "Продления Бух план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "buh_renewalsRevenue_f", label: "Продления Бух факт", hasPlan: true, hasFact: true, unit: "", factSource: "manual" },
  { key: "buh_komLeads_p", label: "Квал ком. Бух лидов план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "buh_komLeads_f", label: "Квал ком. Бух лидов факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "buh_sales_p", label: "Количество продаж Бух план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "buh_sales_f", label: "Количество продаж Бух факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "buh_prepayments", label: "Количество предоплат Бух", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
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
  { key: "med_newRevenue_f", label: "Новая выручка Мед факт", hasPlan: true, hasFact: true, unit: "", factSource: "db" },
  // Продления Мед — симметрично Бух (Excel row126/127 tracks обе стрима,
  // dashboard разбивает отдельно для per-stream прозрачности).
  { key: "med_renewalsRevenue_p", label: "Продления Мед план", hasPlan: true, hasFact: false, unit: "", factSource: "manual" },
  { key: "med_renewalsRevenue_f", label: "Продления Мед факт", hasPlan: true, hasFact: true, unit: "", factSource: "manual" },
  { key: "med_komLeads_p", label: "Квал ком. Мед лидов план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "med_komLeads_f", label: "Квал ком. Мед лидов факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "med_sales_p", label: "Количество продаж Мед план", hasPlan: true, hasFact: false, unit: "шт", factSource: "manual" },
  { key: "med_sales_f", label: "Количество продаж Мед факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "med_prepayments", label: "Количество предоплат Мед", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
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
  { key: "calls_total_f", label: "Количество звонков факт", hasPlan: false, hasFact: true, unit: "шт", factSource: "db" },
  { key: "calls_totalMinutes_p", label: "Всего на линии (минут) план", hasPlan: true, hasFact: false, unit: "мин", factSource: "manual" },
  { key: "calls_totalMinutes_f", label: "Всего на линии (минут) факт", hasPlan: false, hasFact: true, unit: "мин", factSource: "db" },
  { key: "calls_avgWait_p", label: "Среднее время ожидания ответа (сек) план", hasPlan: true, hasFact: false, unit: "сек", factSource: "manual" },
  // Факт ожидания — ручной ввод (source Callgear, пока не подключён).
  { key: "calls_avgWait_f", label: "Среднее время ожидания ответа (сек) факт", hasPlan: true, hasFact: false, unit: "сек", factSource: "manual" },
  { key: "calls_dialPercent_p", label: "% дозвона план", hasPlan: true, hasFact: false, unit: "%", factSource: "manual" },
  { key: "calls_dialPercent_f", label: "% дозвона факт", hasPlan: false, hasFact: true, unit: "%", factSource: "db" },
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

// Plan defaults. Non-cumulative keys (%, среднее, время) are passed through
// unchanged to the UI. Cumulative keys (leads per day, sales per day) would
// scale by the period divisor — those aren't listed here on purpose because
// the business value is "enter once per month, it'll split". Numbers are
// kept in sync with Excel Daily_Numbers defaults (rows 61/65/78/80, column
// NC = April 1 2026 daily baseline).
export const B2B_FIXED_PLAN_DEFAULTS: Record<string, number> = {
  // % / averages (non-cumulative, shown as-is in the UI)
  total_ql2p_p: 7.5,
  buh_ql2p_p: 7.5,       // Excel row61 = 0.075
  med_ql2p_p: 5,         // Excel row78 = 0.05
  buh_avgCheck_p: 900,   // Excel row65
  med_avgCheck_p: 500,   // Excel row80
  // Cumulative leads plans — stored as MONTHLY totals; getPlan divides by
  // planDivisor (daysInMonth / weeks / 1/12 yr) before rendering, so daily
  // view lands on Excel's per-day figures (16 Бух, 6.66 Мед for Apr 2026).
  buh_komLeads_p: 480,   // Excel row54 = 16/day × 30 days ≈ 480/month
  med_komLeads_p: 200,   // Excel row73 = 6.66/day × 30 ≈ 200/month
  // Звонки / ОКК (per ТЗ defaults)
  calls_avgWait_p: 35,
  calls_dialPercent_p: 65,
  calls_sla_p: 25,
  okk_buh1_p: 85,
  okk_buh2_p: 85,
  okk_med1_p: 85,
};
