/**
 * Доменные типы вкладки «Воронка». См. dev_docs/funnel/04-ПЛАН-РЕАЛИЗАЦИИ.md.
 * api-types.ts будет добавлен на этапе H (когда появится бэкенд).
 */

import type { DateRange } from "@/components/CalendarPicker";

// C1.1 / C2.1 — «чистые» варианты C1 / C2: та же цель, но из базы исключены
// лиды, закрытые с причиной «Игнор» (поле 879824 enum 744314). См. compute.ts
// IGNOR_ENUM_IDS / excludesIgnor.
export type ConversionId =
  | "C1"
  | "C1.1"
  | "C2"
  | "C2.1"
  | "C3"
  | "C4"
  | "C5";

export type MaturityFilter = "all" | "mature" | "immature";

export type ChartMode = "percent" | "volume";

export interface FunnelFiltersState {
  dateRange: DateRange;
  maturity: MaturityFilter;
  /** UTM-канал. Пустая строка = «Все». */
  source: string;
  /** Kommo responsible_user_id. Пустая строка = «Все». */
  responsibleUserId: string;
}

export interface FilterOption {
  value: string;
  label: string;
}

// ---------- Данные конверсий ----------

/** Метаданные одной конверсии. Конфиг — в lib/funnel/conversions.ts. */
export interface ConversionMeta {
  id: ConversionId;
  /** Полное название конверсии, например «Квал лид → Документы в ДЦ». */
  label: string;
  /** Окно зрелости в неделях. */
  maturityWeeks: number;
  /** Целевой уровень % (benchmark). На этапе K сохраняется в БД. */
  benchmark: number | null;
}

/** Раскладка по уровню языка для одной когорты. */
export interface LanguageBreakdown {
  a2: { count: number; pct: number | null };
  b1: { count: number; pct: number | null };
  b2: { count: number; pct: number | null };
  c1: { count: number; pct: number | null };
  unknown: { count: number; pct: number | null };
}

/** Одна когорта (неделя) внутри конверсии. */
export interface CohortWeek {
  /** ISO-неделя «KW 16». */
  isoLabel: string;
  /** Дата понедельника. */
  weekStart: Date;
  /** Дата воскресенья (включительно). */
  weekEnd: Date;
  /** Сколько лидов в базе когорты. */
  baseCount: number;
  /** Сколько дошли до цели. */
  targetCount: number;
  /** % конверсии (target / base * 100). Null если base = 0. */
  conversionPct: number | null;
  /** Зрелая ли когорта. */
  maturityState: "mature" | "immature";
  /** Дата, когда когорта станет зрелой (для tooltip). */
  maturityTargetAt: Date;
  /** Сколько дисквалифицировано в окне (для C1/C2/C5). */
  disqualifiedCount: number;
  /** % дисквалификации от базы + дисквала. */
  disqualificationPct: number | null;
  /** Раскладка по уровню языка. */
  languageLevels: LanguageBreakdown;
}

/** Сводка по конверсии (для карточки) — пересчитывается фронтом из cohorts. */
export interface ConversionSummary {
  /** Средний % конверсии по зрелым когортам. */
  matureAvgPct: number | null;
  /** Сумма базы по зрелым когортам. */
  matureBase: number;
  /** Кол-во зрелых когорт. */
  matureCount: number;
  /** Кол-во незрелых. */
  immatureCount: number;
  /** Всего когорт в выборке. */
  totalCount: number;
  /** Delta от benchmark в процентных пунктах. Null если benchmark не задан. */
  benchmarkDelta: number | null;
}
