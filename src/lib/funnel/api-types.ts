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
