/**
 * Wire-типы для /api/funnel/*. Используются backend (route.ts) и frontend
 * (FunnelTab.tsx) для строгой типизации payload-ов.
 *
 * Daty приходят в ISO string (т. к. JSON не умеет Date). На фронте парсим в Date.
 */

import type { ConversionId } from "./types";

export interface CohortsApiCohort {
  conversionId: ConversionId;
  /** ISO date (YYYY-MM-DD) — понедельник недели когорты. */
  weekStartIso: string;
  /** ISO date (YYYY-MM-DD) — воскресенье включительно. */
  weekEndIso: string;
  /** «KW 16». */
  isoLabel: string;
  baseCount: number;
  targetCount: number;
  /** % конверсии. null если base = 0. */
  conversionPct: number | null;
  maturityState: "mature" | "immature";
  /** ISO timestamp — когда когорта станет зрелой. */
  maturityTargetAtIso: string;
  disqualifiedCount: number;
  /** % дисквалификации от базы (которая уже включает дисквалифицированных). null если base=0. */
  disqualificationPct: number | null;
  /** Раскладка лидов когорты по уровню языка. */
  languageLevels: {
    a2: { count: number; pct: number | null };
    b1: { count: number; pct: number | null };
    b2: { count: number; pct: number | null };
    c1: { count: number; pct: number | null };
    unknown: { count: number; pct: number | null };
  };
}

export interface CohortsApiResponse {
  cohorts: CohortsApiCohort[];
  /** ISO timestamp — когда последний раз ETL что-то обновил. null если неизвестно. */
  lastSyncAtIso: string | null;
  /** ID конверсий, которые НЕ удалось посчитать (например, C3/C4 пока на моках). */
  unsupportedConversionIds: ConversionId[];
  /** Сохранённые в БД целевые уровни (этап K). Перекрывают дефолты из CONVERSIONS. */
  benchmarks: Partial<Record<ConversionId, number | null>>;
}

// ---------- Обзор: KPI-полоска (§9.1) + объединённая воронка (§9.2) ----------

export interface OverviewKpi {
  /** Главная сквозная конверсия Квал→Гутшайн, %. */
  c5Pct: number | null;
  /** Активных клиентов (не закрыты, обе воронки). */
  activeClients: number;
  /** Заглушка до скоринга §8 — null значит «ещё нет». */
  hotWarmCold: { hot: number; warm: number; cold: number } | null;
  /** Средний срок квал-лид → Гутшайн, дней (по дошедшим). */
  avgDaysQualToGutschein: number | null;
  /** Активных клиентов без звонка за порог дней. */
  noFreshCallCount: number;
  /** Порог «свежести» звонка (дней). */
  freshCallThresholdDays: number;
}

export interface OverviewFunnelStage {
  key: string;
  label: string;
  /** Сколько клиентов дошло до этапа (накопительно). */
  count: number;
  /** % перехода с предыдущего этапа. null для первого. */
  transitionPctFromPrev: number | null;
  /** Среднее время перехода с предыдущего этапа, дней. null если неизвестно. */
  avgDaysFromPrev: number | null;
}

export interface OverviewResponse {
  kpi: OverviewKpi;
  funnel: OverviewFunnelStage[];
}

// ---------- Разбор когорты C3.1 (куда делись лиды после Термина ДЦ) ----------

/** Вёдра судьбы лида после «Термин ДЦ состоялся». */
export type DcBucketKey = "forward" | "stayed" | "closed" | "delayed" | "appeal";

/** Лид в drill ведра (форма совместима с LeadDrillPopover.DrillLead). */
export interface DcBreakdownLead {
  leadId: number;
  name: string;
  kommoUrl: string;
  currentStatus: string | null;
}

export interface DcBreakdownBucket {
  /** Полное число лидов в ведре (может быть больше длины leads). */
  count: number;
  /** Первые N лидов для drill (cap на бэке). */
  leads: DcBreakdownLead[];
}

export interface DcBreakdownResponse {
  /** Всего лидов с состоявшимся Термином ДЦ (= 100% разбора). */
  total: number;
  buckets: Record<DcBucketKey, DcBreakdownBucket>;
}
