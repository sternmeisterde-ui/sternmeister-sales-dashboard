/**
 * Рабочее время для регламентных метрик (вкладка «Регламент», ТЗ 23).
 *
 * «Рабочие дни» у интегратора = Пн–Сб (только воскресенье нерабочее) —
 * определено калибровкой по CSV-выгрузке «Время на этапах»: пребывание
 * 28 июн (вс) → 6 июл даёт факт 7 (при Пн–Пт было бы 6).
 *
 * Формула факта: число рабочих (Пн–Сб) берлинских календарных дней,
 * которых КАСАЕТСЯ интервал [start, end], т.е. включая день входа
 * (если он рабочий) и день выхода. Для интервала внутри одного рабочего
 * дня факт = 1, внутри воскресенья = 0.
 */

import { tzOffsetMinutes } from "@/lib/utils/date";

const DAY_MS = 86_400_000;

/** Берлинский civil-день UTC-инстанта как число дней с эпохи (для арифметики). */
function berlinDayNumber(instant: Date): number {
  const offset = tzOffsetMinutes(instant, "Europe/Berlin");
  return Math.floor((instant.getTime() + offset * 60_000) / DAY_MS);
}

/** День недели берлинского civil-дня: 0=вс … 6=сб (эпоха 1970-01-01 — четверг). */
function weekdayOfDayNumber(dayNum: number): number {
  return (((dayNum + 4) % 7) + 7) % 7;
}

/** Кол-во воскресений среди дней [a..b] включительно (a ≤ b, номера дней). */
function sundaysInRange(a: number, b: number): number {
  if (b < a) return 0;
  // Первое воскресенье ≥ a
  const wa = weekdayOfDayNumber(a);
  const firstSunday = a + ((7 - wa) % 7);
  if (firstSunday > b) return 0;
  return Math.floor((b - firstSunday) / 7) + 1;
}

/**
 * Факт «времени на этапе» в рабочих днях (Пн–Сб): число рабочих берлинских
 * дней, которых касается [start, end]. end < start → 0.
 */
export function workDaysTouched(start: Date, end: Date): number {
  if (end.getTime() < start.getTime()) return 0;
  const a = berlinDayNumber(start);
  const b = berlinDayNumber(end);
  const total = b - a + 1;
  return total - sundaysInRange(a, b);
}

/** Календарные дни: разница берлинских civil-дней (день выхода − день входа). */
export function calendarDaysBetween(start: Date, end: Date): number {
  if (end.getTime() < start.getTime()) return 0;
  return berlinDayNumber(end) - berlinDayNumber(start);
}

/** Часы: прошедшее время в целых часах (floor). Для норматива «Часы». */
export function hoursBetween(start: Date, end: Date): number {
  if (end.getTime() < start.getTime()) return 0;
  return Math.floor((end.getTime() - start.getTime()) / 3_600_000);
}

/**
 * Разрыв между касаниями (TLT-GAP) в рабочих днях: как workDaysTouched, но
 * соседние касания в один день дают 0 (разрыва нет), «на следующий рабочий
 * день» → 1 и т.д. = число рабочих дней СТРОГО между началом и концом + 0/1
 * за смену дня. Реализуем как workDaysTouched − 1 (минимум 0): интервал в
 * пределах одного дня касается 1 рабочего дня → gap 0.
 */
export function workDayGap(start: Date, end: Date): number {
  const touched = workDaysTouched(start, end);
  return Math.max(0, touched - 1);
}
