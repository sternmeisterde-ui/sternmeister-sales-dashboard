/**
 * Скоринг «готовности» клиента к ближайшему термину (ТЗ §8).
 *
 * ВАЖНО: это **«готовность»** (индикатор подготовленности/коучинга), НЕ предиктор
 * гутшайна — калибровка ОКК (n=36) показала AUC~0.51 (см. 02-доку §3.4).
 *
 * СТАДИЙНАЯ УСЛОВНОСТЬ: готовность считаем по той ролевке, что актуальна на
 * текущей стадии. ДЦ-фаза → смотрим ролевку ДЦ; АА-фаза (ДЦ-термин пройден) →
 * ролевку АА. Неактуальная сторона НЕ штрафует (исключена из знаменателя) —
 * иначе клиент на стадии ДЦ терял бы 20% за «отсутствие» АА-ролевки.
 *
 * Если на актуальной стадии ролевки НЕТ — это реальный пробел (клиент не
 * подготовлен) → вклад 0, а не исключение.
 *
 * Фактор «Ролевки с ботом» (10%) — тренировки клиента с ботом (репо berater_bot).
 * Это ОТДЕЛЬНАЯ сущность от звонковых ролевок с менеджером (их качество даёт
 * фактор «Готовность ролевок», их оценки — колонки ДЦ/АА). Не склеиваем: бот меряет
 * количество подготовки, звонковые — качество. Больше тренировок → выше готовность
 * (как roleplay-коэффициент в berater-dashboard).
 *
 * Отложены вне-MVP факторы (исключены из знаменателя): ОКК-агрегаты (§8 даёт 15%)
 * и «Стадия CRM» (5%). Знаменатель = язык 20 + ролевки 35 + активность 5 +
 * ролевки-с-ботом 10 = 0.70.
 *
 * Score всегда с breakdown — правило §8 «должен быть объяснимым».
 */

export type LanguageBucket = "a2" | "b1" | "b2" | "c1" | "unknown";
export type ReadinessCategory = "hot" | "warm" | "cold";

export interface ScoreFactor {
  key: string;
  label: string;
  weight: number;
  /** 0..100 — вклад фактора. Нет данных на актуальной стадии → 0. */
  value: number;
  present: boolean;
}

export interface ReadinessScore {
  score: number;
  category: ReadinessCategory;
  factors: ScoreFactor[];
}

export interface ReadinessInput {
  languageBucket: LanguageBucket;
  /** Актуальная сторона по стадии клиента. */
  activeSide: "dc" | "aa";
  /** Средняя оценка ролевок актуальной стороны (1..5) или null. */
  activeAvg: number | null;
  /** Дней с последнего касания или null. */
  daysSinceLastTouch: number | null;
  /** Тренировок с ботом ролевок, или null если неизвестно. */
  botRoleplayCount: number | null;
}

// §8: B2/C1/C2 = 100, B1 = 80, A2 = 50, A1 = 10, unknown = 30 (a1→a2, c2→c1).
const LANGUAGE_SCORE: Record<LanguageBucket, number> = {
  b2: 100,
  c1: 100,
  b1: 80,
  a2: 50,
  unknown: 30,
};

function activityScore(days: number | null): number | null {
  if (days === null) return null;
  if (days <= 7) return 100;
  if (days <= 14) return 60;
  if (days <= 30) return 30;
  return 0;
}

// Кол-во тренировок с ботом → 0..100 (кривая вовлечённости, как roleplay-коэф
// в berater-dashboard: 0 / 1–2 / 3–4 / 5+).
function botCountScore(count: number | null): number | null {
  if (count === null) return null;
  if (count <= 0) return 0;
  if (count <= 1) return 40;
  if (count <= 2) return 60;
  if (count <= 4) return 80;
  return 100;
}

function categorize(score: number): ReadinessCategory {
  if (score >= 75) return "hot";
  if (score >= 50) return "warm";
  return "cold";
}

export function computeReadiness(input: ReadinessInput): ReadinessScore {
  const roleplay =
    input.activeAvg === null ? 0 : Math.min(100, Math.max(0, input.activeAvg * 20));
  const activity = activityScore(input.daysSinceLastTouch);
  const botCount = botCountScore(input.botRoleplayCount);
  const sideLabel = input.activeSide === "dc" ? "ДЦ" : "АА";

  const factors: ScoreFactor[] = [
    { key: "language", label: "Язык", weight: 0.2, value: LANGUAGE_SCORE[input.languageBucket], present: true },
    { key: "roleplay", label: `Готовность ролевок ${sideLabel}`, weight: 0.35, value: roleplay, present: input.activeAvg !== null },
    { key: "bot_roleplays", label: "Ролевки с ботом", weight: 0.1, value: botCount ?? 0, present: botCount !== null },
    { key: "activity", label: "Активность 7 дней", weight: 0.05, value: activity ?? 0, present: activity !== null },
  ];

  const denom = factors.reduce((s, f) => s + f.weight, 0);
  const acc = factors.reduce((s, f) => s + f.weight * f.value, 0);
  const score = Math.round(acc / denom);
  return { score, category: categorize(score), factors };
}
