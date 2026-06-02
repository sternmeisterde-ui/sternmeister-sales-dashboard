/**
 * Генератор моков для вкладки «Воронка». Используется до этапа H (реальный backend).
 * Все цифры синтетические, но структура совпадает с тем, что вернёт API.
 */

import type {
  ConversionId,
  CohortWeek,
  ConversionSummary,
  LanguageBreakdown,
} from "./types";
import { CONVERSION_ORDER, CONVERSIONS } from "./conversions";

/** Простой детерминированный «шум» от seed. */
function seedNoise(seed: number, idx: number): number {
  const x = Math.sin(seed * 9301 + idx * 49297) * 233280;
  return x - Math.floor(x);
}

/** Дата ISO-понедельника (UTC) для заданного года/недели. */
function isoMondayUTC(year: number, week: number): Date {
  // 4 января всегда в W1 (по ISO).
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const w1Mon = new Date(jan4);
  w1Mon.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const mon = new Date(w1Mon);
  mon.setUTCDate(w1Mon.getUTCDate() + (week - 1) * 7);
  return mon;
}

/** Сегодня в Europe/Berlin (без часового пояса в локали). */
function todayBerlin(): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return new Date(
    Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day))
  );
}

/**
 * Параметры профиля конверсии — чтобы карточки получились разной формы (как на скрине).
 */
const PROFILES: Record<
  ConversionId,
  { mean: number; jitter: number; baseRange: [number, number] }
> = {
  C1: { mean: 33, jitter: 8, baseRange: [100, 230] },
  C2: { mean: 31, jitter: 8, baseRange: [100, 230] },
  C3: { mean: 38, jitter: 12, baseRange: [12, 35] },
  C4: { mean: 46, jitter: 10, baseRange: [4, 18] },
  C5: { mean: 4, jitter: 3, baseRange: [100, 230] },
};

export function generateMockCohorts(
  conversionId: ConversionId,
  weekCount = 25
): CohortWeek[] {
  const meta = CONVERSIONS[conversionId];
  const profile = PROFILES[conversionId];
  const today = todayBerlin();
  // Последняя из weekCount недель — текущая (или прошлая, если сегодня понедельник).
  const out: CohortWeek[] = [];

  const seed = conversionId.charCodeAt(1); // C1→49, ..., C5→53

  for (let i = 0; i < weekCount; i++) {
    // Начинаем weekCount-1 недель назад.
    const offsetWeeks = weekCount - 1 - i;
    const weekStart = new Date(today);
    weekStart.setUTCDate(weekStart.getUTCDate() - offsetWeeks * 7);
    // Снэппинг к понедельнику (понедельник = 1, воскресенье = 0 → 7).
    const dow = weekStart.getUTCDay() || 7;
    weekStart.setUTCDate(weekStart.getUTCDate() - (dow - 1));
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 6);

    // ISO-неделя (грубое приближение для меток — для моков ок).
    const isoWeek = Math.ceil(
      ((weekStart.getTime() - Date.UTC(weekStart.getUTCFullYear(), 0, 1)) /
        86400000 +
        1) /
        7
    );

    const noise = seedNoise(seed, i) * 2 - 1; // [-1..1]
    const baseNoise = seedNoise(seed + 1, i);
    const base =
      profile.baseRange[0] +
      Math.round(baseNoise * (profile.baseRange[1] - profile.baseRange[0]));

    const pct = Math.max(
      0,
      Math.min(100, profile.mean + noise * profile.jitter)
    );
    const target = Math.round((base * pct) / 100);
    const conversionPct = base > 0 ? (target / base) * 100 : null;

    const maturityTargetAt = new Date(weekEnd);
    maturityTargetAt.setUTCDate(
      maturityTargetAt.getUTCDate() + meta.maturityWeeks * 7
    );
    const maturityState = maturityTargetAt <= today ? "mature" : "immature";

    const disqualifiedCount = Math.round(base * 0.06 * seedNoise(seed + 2, i));
    const denom = base + disqualifiedCount;
    const disqualificationPct = denom > 0 ? (disqualifiedCount / denom) * 100 : null;

    out.push({
      isoLabel: `KW ${String(isoWeek).padStart(2, "0")}`,
      weekStart,
      weekEnd,
      baseCount: base,
      targetCount: target,
      conversionPct,
      maturityState,
      maturityTargetAt,
      disqualifiedCount,
      disqualificationPct,
      languageLevels: mockLanguageBreakdown(base, seed, i),
    });
  }

  return out;
}

function mockLanguageBreakdown(
  total: number,
  seed: number,
  idx: number
): LanguageBreakdown {
  // Псевдо-распределение: A2 ~25%, B1 ~35%, B2 ~20%, C1 ~7%, unknown ~13%.
  const buckets: Array<[keyof LanguageBreakdown, number]> = [
    ["a2", 0.25],
    ["b1", 0.35],
    ["b2", 0.2],
    ["c1", 0.07],
    ["unknown", 0.13],
  ];
  // Лёгкий шум на seed.
  const result = {} as LanguageBreakdown;
  let assigned = 0;
  for (const [key, ratio] of buckets) {
    const noisy = ratio * (0.85 + 0.3 * seedNoise(seed + 7, idx + key.length));
    const count = Math.min(
      total - assigned,
      Math.max(0, Math.round(total * noisy))
    );
    assigned += count;
    result[key] = {
      count,
      pct: total > 0 ? (count / total) * 100 : null,
    };
  }
  return result;
}

export function generateAllMockCohorts(): Record<ConversionId, CohortWeek[]> {
  const out = {} as Record<ConversionId, CohortWeek[]>;
  for (const id of CONVERSION_ORDER) {
    out[id] = generateMockCohorts(id);
  }
  return out;
}

/**
 * Сводка по конверсии. См. 03 §4.2.
 * basis = только зрелые когорты; если зрелых нет — все когорты (избегаем «—»).
 */
export function summarizeConversion(
  cohorts: CohortWeek[],
  benchmark: number | null
): ConversionSummary {
  const mature = cohorts.filter((c) => c.maturityState === "mature");
  const basis = mature.length > 0 ? mature : cohorts;
  const baseSum = basis.reduce((acc, c) => acc + c.baseCount, 0);
  const targetSum = basis.reduce((acc, c) => acc + c.targetCount, 0);
  const matureAvgPct = baseSum > 0 ? (targetSum / baseSum) * 100 : null;
  return {
    matureAvgPct,
    matureBase: baseSum,
    matureCount: mature.length,
    immatureCount: cohorts.length - mature.length,
    totalCount: cohorts.length,
    benchmarkDelta:
      matureAvgPct !== null && benchmark !== null
        ? matureAvgPct - benchmark
        : null,
  };
}
