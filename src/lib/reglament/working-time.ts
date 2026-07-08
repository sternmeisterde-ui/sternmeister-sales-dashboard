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

/**
 * Факт «времени на этапе» в рабочих днях — формула интегратора,
 * откалиброванная по 13 681 закрытой строке его CSV (совпадение факта 62.9%,
 * ok-решений 94.1% — лучший из ~30 проверенных кандидатов): календарные
 * берлинские дни, которых касается [start, end], МИНУС выходные (Сб и Вс)
 * внутри интервала, при этом ДЕНЬ ВХОДА считается всегда, даже если он
 * выходной. end < start → 0.
 */
export function workDaysTouched(start: Date, end: Date): number {
  if (end.getTime() < start.getTime()) return 0;
  const a = berlinDayNumber(start);
  const b = berlinDayNumber(end);
  let n = 0;
  for (let d = a; d <= b; d++) {
    const w = weekdayOfDayNumber(d);
    if (d !== a && (w === 0 || w === 6)) continue;
    n++;
  }
  return n;
}

// Календарные дни и часы для «Время на этапах» считаются дробным elapsed'ом
// прямо в compute.ts (формула, совпадающая с интегратором) — целочисленных
// хелперов здесь намеренно нет, чтобы никто не взял «похожую» функцию с
// другой семантикой.

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

// ─── Рабочие минуты (для SLA «Новый лид ≤ 25 минут») ────────────────

/** Рабочее окно дня, часы Berlin. Совпадает с окном вкладки «Активность». */
export const WORK_DAY_START_HOUR = 9;
export const WORK_DAY_END_HOUR = 20;

const HOUR_MS = 3_600_000;

/**
 * Рабочие миллисекунды между двумя UTC-инстантами: суммируется только время
 * внутри окна 09:00–20:00 Berlin, воскресенье нерабочее. DST-корректно —
 * границы окна каждого дня строятся через tzOffsetMinutes.
 */
export function workMsBetween(start: Date, end: Date): number {
  if (end.getTime() <= start.getTime()) return 0;
  let total = 0;
  let dayNum = berlinDayNumber(start);
  const lastDay = berlinDayNumber(end);
  for (; dayNum <= lastDay; dayNum++) {
    if (weekdayOfDayNumber(dayNum) === 0) continue; // воскресенье
    // 09:00 Berlin этого civil-дня как UTC: берём полдень дня как якорь
    // для смещения (полдень никогда не попадает на DST-переход).
    const noonUtcGuess = dayNum * DAY_MS + 12 * HOUR_MS;
    const offsetMs = tzOffsetMinutes(new Date(noonUtcGuess), "Europe/Berlin") * 60_000;
    const winStart = dayNum * DAY_MS + WORK_DAY_START_HOUR * HOUR_MS - offsetMs;
    const winEnd = dayNum * DAY_MS + WORK_DAY_END_HOUR * HOUR_MS - offsetMs;
    const s = Math.max(start.getTime(), winStart);
    const e = Math.min(end.getTime(), winEnd);
    if (e > s) total += e - s;
  }
  return total;
}
