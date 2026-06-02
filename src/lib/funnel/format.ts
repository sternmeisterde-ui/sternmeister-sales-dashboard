/**
 * Утилиты форматирования чисел и процентов для вкладки «Воронка».
 * См. dev_docs/funnel/03-ОБЗОР-COHORT-CONVERSION.md §10.2.
 */

const RU = "ru-RU";

/** Процент с произвольным знаком после запятой. Null/NaN → «—». */
export function fmtPercent(
  value: number | null | undefined,
  fractionDigits = 1
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toLocaleString(RU, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}%`;
}

/** Целое число с пробелами разрядов. Null/NaN → «—». */
export function fmtCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString(RU, { maximumFractionDigits: 0 });
}

/** Дельта процентных пунктов: «+4,4%» / «-2,4%» / «—». */
export function fmtDeltaPp(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString(RU, {
    maximumFractionDigits: 1,
  })}%`;
}

/** Короткая дата «дд.мм». */
export function fmtShortDate(d: Date): string {
  return d.toLocaleDateString(RU, { day: "2-digit", month: "2-digit" });
}

/** Полный диапазон недели «дд.мм – дд.мм.гггг» по дате понедельника. */
export function fmtWeekRange(weekStart: Date): string {
  const end = new Date(weekStart);
  end.setUTCDate(end.getUTCDate() + 6);
  const startStr = fmtShortDate(weekStart);
  const endStr = end.toLocaleDateString(RU, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return `${startStr} – ${endStr}`;
}
