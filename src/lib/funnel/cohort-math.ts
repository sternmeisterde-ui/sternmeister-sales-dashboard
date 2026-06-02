/**
 * ISO-неделя в Europe/Berlin + расчёт зрелости когорты.
 *
 * Используется backend (route.ts) и frontend (для отрисовки исторических
 * данных пришедших с бэка). Все вычисления — pure functions.
 */

const TZ = "Europe/Berlin";

/** Сегодня в Europe/Berlin как UTC-Date (полночь). */
export function todayBerlinUTC(): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return new Date(
    Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day))
  );
}

/** Конвертирует timestamp в дату в Europe/Berlin (понедельник той недели). */
export function isoWeekStartBerlin(date: Date): Date {
  // Получаем компоненты даты в Berlin-tz.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  // Используем UTC-date с тем же year/month/day, корректируем к понедельнику.
  const localDay = new Date(
    Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day))
  );
  // ISO: понедельник = 1, воскресенье = 7.
  const dow = localDay.getUTCDay() || 7;
  const monday = new Date(localDay);
  monday.setUTCDate(localDay.getUTCDate() - (dow - 1));
  return monday;
}

/** Воскресенье включительно той же недели (UTC-midnight). */
export function isoWeekEndBerlin(monday: Date): Date {
  const end = new Date(monday);
  end.setUTCDate(monday.getUTCDate() + 6);
  return end;
}

/** ISO-год + неделя в формате (year, week). */
export function isoYearWeek(monday: Date): { year: number; week: number } {
  // Алгоритм ISO 8601: год = тот, к которому относится четверг этой недели.
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  // Первая неделя содержит 4 января.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const w1Mon = new Date(jan4);
  w1Mon.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const diffDays = Math.round(
    (monday.getTime() - w1Mon.getTime()) / 86_400_000
  );
  const week = Math.floor(diffDays / 7) + 1;
  return { year, week };
}

/** Метка «KW 16». */
export function isoLabel(monday: Date): string {
  const { week } = isoYearWeek(monday);
  return `KW ${String(week).padStart(2, "0")}`;
}

/** Дата, когда когорта станет зрелой (= week_end + N*7 дней). */
export function maturityTargetAt(
  weekEnd: Date,
  maturityWeeks: number
): Date {
  const t = new Date(weekEnd);
  t.setUTCDate(weekEnd.getUTCDate() + maturityWeeks * 7);
  return t;
}

/** true если когорта зрелая на момент `now`. */
export function isMature(
  weekEnd: Date,
  maturityWeeks: number,
  now: Date = todayBerlinUTC()
): boolean {
  return now >= maturityTargetAt(weekEnd, maturityWeeks);
}

/** Итерация по неделям [from..to] (понедельники, включительно). */
export function* iterWeeks(from: Date, to: Date): Generator<Date> {
  const start = isoWeekStartBerlin(from);
  const end = isoWeekStartBerlin(to);
  const cur = new Date(start);
  while (cur <= end) {
    yield new Date(cur);
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
}
