/**
 * Конфиг 5 конверсий. См. dev_docs/funnel/03-ОБЗОР-COHORT-CONVERSION.md §1.
 * Окна зрелости совпадают с cohort-conversion/config/conversions.json.
 */

import type { ConversionId, ConversionMeta } from "./types";

export const CONVERSION_ORDER: ConversionId[] = [
  "C1",
  "C1.1",
  "C2",
  "C2.1",
  "C3",
  "C4",
  "C5",
];

export const CONVERSIONS: Record<ConversionId, ConversionMeta> = {
  C1: {
    id: "C1",
    label: "Квал лид → Документы в ДЦ",
    maturityWeeks: 4,
    benchmark: 40,
  },
  // C1.1 — то же, что C1, но из базы исключены лиды с причиной «Игнор».
  // benchmark null: цель чистой конверсии РОП задаёт сам (сохраняется в БД).
  "C1.1": {
    id: "C1.1",
    label: "Квал лид → Документы в ДЦ (без «Игнор»)",
    maturityWeeks: 4,
    benchmark: null,
  },
  C2: {
    id: "C2",
    label: "Квал лид → Термин ДЦ",
    maturityWeeks: 6,
    benchmark: 35,
  },
  // C2.1 — то же, что C2, но из базы исключены лиды с причиной «Игнор».
  "C2.1": {
    id: "C2.1",
    label: "Квал лид → Термин ДЦ (без «Игнор»)",
    maturityWeeks: 6,
    benchmark: null,
  },
  C3: {
    id: "C3",
    label: "Конс. перед ДЦ → Термин ДЦ состоялся",
    maturityWeeks: 8,
    benchmark: null,
  },
  C4: {
    id: "C4",
    label: "Конс. перед АА → Гутшайн одобрен",
    maturityWeeks: 12,
    benchmark: null,
  },
  C5: {
    id: "C5",
    label: "Квал лид → Гутшайн",
    maturityWeeks: 16,
    benchmark: 5,
  },
};

/**
 * Семантика «качественной» колонки. См. 03 §9.2.
 * C1/C2/C5 → «Квал %» (сколько лидов НЕ дисквалифицировано)
 * C3/C4   → «Отсев»  (сколько НЕ дошли)
 */
export function usesQualificationRetention(id: ConversionId): boolean {
  return id !== "C3" && id !== "C4";
}

export function qualityColumnLabel(id: ConversionId): string {
  return usesQualificationRetention(id) ? "Квал %" : "Отсев";
}
