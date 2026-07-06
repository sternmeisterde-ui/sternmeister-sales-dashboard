/**
 * Нормативы регламента B2G — восстановлены реверс-инжинирингом Looker-отчёта
 * «Sternmeister Госники V7» (CSV-выгрузки интегратора, 2026-07-06).
 *
 * Source of truth: dev_docs/specs/23a-СПРАВОЧНИК-НОРМАТИВОВ-РЕГЛАМЕНТА.md.
 * Пункты с пометкой 🟡 там — гипотезы; здесь они помечены комментарием.
 *
 * Скоуп — воронки Бух Гос / Бух Бератер (отчёт РОПа покрывает только их;
 * Мед-воронки появятся вместе со spec 21).
 */

export type FunnelKey = "gos" | "berater";

export const FUNNEL_PIPELINES: Record<FunnelKey, string> = {
  gos: "Бух Гос",
  berater: "Бух Бератер",
};

export const FUNNEL_LABELS: Record<FunnelKey, string> = {
  gos: "ГОСНИКИ",
  berater: "БЕРАТЕР",
};

export type NormUnit = "work_days" | "calendar_days" | "hours";

export const UNIT_LABELS: Record<NormUnit, string> = {
  work_days: "Рабочие дни",
  calendar_days: "Календарные дни",
  hours: "Часы",
};

export interface StageNorm {
  limit: number;
  unit: NormUnit;
}

/**
 * «Время на этапах»: максимум пребывания сделки на этапе.
 * Ключ — название статуса как в analytics.lead_status_changes.status.
 * Статусы без записи нормируются только в «Среднем времени» (без ok-флага).
 */
export const STAGE_TIME_NORMS: Record<FunnelKey, Record<string, StageNorm>> = {
  gos: {
    // Реальное имя статуса в Бух Гос — «Взято в работу» (sort 30);
    // статуса «Взят в работу» в этой воронке нет.
    "Взято в работу": { limit: 3, unit: "hours" },
    "Недозвон": { limit: 3, unit: "work_days" },
    "Контакт установлен": { limit: 3, unit: "work_days" },
    "Консультация проведена": { limit: 5, unit: "work_days" },
    "Документы отправлены в ДЦ": { limit: 3, unit: "work_days" },
    "Отложенный старт": { limit: 30, unit: "work_days" },
  },
  berater: {
    "Принято от первой линии": { limit: 28, unit: "calendar_days" },
    "На рассмотрении бератера": { limit: 28, unit: "calendar_days" },
    // Исторический этап (в текущей воронке отсутствует, есть в старых данных).
    "Взято в работу": { limit: 28, unit: "calendar_days" },
    "Недозвон": { limit: 3, unit: "work_days" },
    "Контакт установлен": { limit: 5, unit: "work_days" },
    "Консультация перед термином АА": { limit: 28, unit: "calendar_days" },
    "Консультация перед термином АА проведена": { limit: 28, unit: "calendar_days" },
    "Термин АА": { limit: 28, unit: "calendar_days" },
    "Термин АА отменен/перенесен": { limit: 28, unit: "calendar_days" },
    "Консультация перед термином ДЦ": { limit: 3, unit: "work_days" },
    "Консультация перед термином ДЦ проведена": { limit: 5, unit: "work_days" },
    "Термин ДЦ состоялся": { limit: 28, unit: "calendar_days" },
    "Термин ДЦ отменен/перенесен": { limit: 28, unit: "calendar_days" },
    "Апелляция": { limit: 28, unit: "calendar_days" },
    "Доведение": { limit: 28, unit: "calendar_days" },
    "Отложенный старт": { limit: 30, unit: "work_days" },
  },
};

/** TLT-GAP: максимальный разрыв между касаниями на этапе (рабочие дни, Пн–Сб). */
export const TLT_GAP_NORMS: Record<FunnelKey, Record<string, number>> = {
  gos: {
    "Контакт установлен": 1,
    "Недозвон": 1,
    "Документы отправлены в ДЦ": 3,
  },
  berater: {
    "Консультация перед термином ДЦ": 1,
    "Консультация перед термином ДЦ проведена": 1,
    "Консультация перед термином АА": 5,
    "Консультация перед термином АА проведена": 5,
    "На рассмотрении бератера": 5,
    "Термин АА отменен/перенесен": 5,
    "Термин ДЦ отменен/перенесен": 5,
    "Термин ДЦ состоялся": 5,
    "Апелляция": 8,
    "Отложенный старт": 20,
  },
};

/**
 * Мин.касания (проверка на переходе между этапами):
 *  - базовое правило: ≥ 1 звонок за пребывание на этапе «Из»;
 *  - из «Документы отправлены в ДЦ» (Гос): ≥ 1 звонок И ≥ 1 сообщение;
 *  - переходы в «Игнор» (Гос): высокий порог звонков. Точная граница
 *    неизвестна (данные: false ≤ 18, true ≥ 25) — 🟡 берём 20.
 * У Бератера сообщения не считаются вовсе.
 */
export const TOUCH_MIN_CALLS_DEFAULT = 1;
export const TOUCH_STAGES_REQUIRING_MESSAGE: Record<FunnelKey, ReadonlySet<string>> = {
  gos: new Set(["Документы отправлены в ДЦ"]),
  berater: new Set(),
};
export const TOUCH_IGNORE_STATUS = "Игнор";
export const TOUCH_IGNORE_MIN_CALLS = 20; // 🟡 гипотеза, граница в [19..25]

/**
 * «Мин.касания» проверяются только для переходов ИЗ «рабочих» этапов
 * (где менеджер обязан коснуться клиента). В эталоне интегратора нет
 * переходов из База / Принимает решение / Консультация проведена /
 * терминальных. У Бератера ограничения нет (все нетерминальные).
 */
export const TOUCH_FROM_WHITELIST: Record<FunnelKey, ReadonlySet<string> | null> = {
  gos: new Set([
    "Новый лид",
    "Взято в работу",
    "Недозвон",
    "Контакт установлен",
    "Документы отправлены в ДЦ",
    "Отложенный старт",
  ]),
  berater: null,
};

export function touchRule(funnel: FunnelKey, fromStatus: string, toStatus: string): {
  minCalls: number;
  minMessages: number;
} {
  if (funnel === "gos" && toStatus === TOUCH_IGNORE_STATUS) {
    return { minCalls: TOUCH_IGNORE_MIN_CALLS, minMessages: 0 };
  }
  const needsMessage = TOUCH_STAGES_REQUIRING_MESSAGE[funnel].has(fromStatus);
  return { minCalls: TOUCH_MIN_CALLS_DEFAULT, minMessages: needsMessage ? 1 : 0 };
}

/**
 * Канонический порядок этапов для пивотов/списков (порядок движения по
 * воронке, как в Looker «Среднее время на этапах»). Статусы вне списка
 * добавляются в конец по алфавиту.
 */
export const STAGE_ORDER: Record<FunnelKey, readonly string[]> = {
  gos: [
    "База",
    "Новый лид",
    "Взято в работу",
    "Недозвон",
    "Контакт установлен",
    "Принимает решение",
    "Консультация проведена",
    "Документы отправлены в ДЦ",
    "Отложенный старт",
  ],
  berater: [
    "Принято от первой линии",
    "На рассмотрении бератера",
    "Взято в работу",
    "Недозвон",
    "Контакт установлен",
    "Консультация перед термином АА",
    "Консультация перед термином АА проведена",
    "Термин АА",
    "Термин АА отменен/перенесен",
    "Апелляция",
    "Консультация перед термином ДЦ",
    "Консультация перед термином ДЦ проведена",
    "Термин ДЦ состоялся",
    "Термин ДЦ отменен/перенесен",
    "Доведение",
    "Отложенный старт",
  ],
};

export function orderStages(funnel: FunnelKey, statuses: Iterable<string>): string[] {
  const known = STAGE_ORDER[funnel];
  const set = new Set(statuses);
  const ordered = known.filter((s) => set.has(s));
  const extra = [...set].filter((s) => !known.includes(s)).sort();
  return [...ordered, ...extra];
}

// ─── Цвета сводной таблицы ──────────────────────────────────────────
// ≤70 красный, 71–80 жёлтый, ≥81 зелёный; имя менеджера красное при итоге <75.

export const COLOR_RED_MAX = 70;
export const COLOR_YELLOW_MAX = 80;
export const NAME_RED_BELOW = 75;

export type MetricColor = "red" | "yellow" | "green";

export function metricColor(pct: number): MetricColor {
  if (pct <= COLOR_RED_MAX) return "red";
  if (pct <= COLOR_YELLOW_MAX) return "yellow";
  return "green";
}
