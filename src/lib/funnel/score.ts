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
 * Факторы (сумма весов = 1.00): язык 20 + ролевки с менеджером (актуальная
 * сторона, +10 за факт консультации) 35 + ролевки с ботом: количество 10 +
 * качество 10 + ОКК консультаций 10 + ОКК по сделке 5 + стадия CRM 5 + активность 5.
 * Ролевки с менеджером (качество) и с ботом (количество+качество) — РАЗНЫЕ сущности,
 * оба в скоринге. Знаменатель — сумма ВЕСОВ ПРИСУТСТВУЮЩИХ факторов (нет данных →
 * фактор исключается, score нормируется по остатку; ролевка с менеджером —
 * обязательная: её отсутствие штрафует). ОКК — средний балл звонков из D2 (0..100),
 * качество бота — из overall_readiness, стадия CRM — близость к Гутшайну.
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
  /** true = вес учитывается в знаменателе ДАЖE при отсутствии данных (реальный
   *  пробол штрафует, а не исключается). Для готовности ролевок (§8). */
  mandatory?: boolean;
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
  /** Последняя самооценка готовности ботом (overall_readiness) или null. */
  botReadiness: string | null;
  /** Проведена ли консультация (для бонуса +10 к готовности ролевок, §4.2). */
  consultationDone: boolean;
  /** Средний ОКК консультационных звонков (0..100) или null. */
  consultOkk: number | null;
  /** Средний ОКК по всем звонкам сделки (0..100) или null. */
  dealOkk: number | null;
  /** Стадия в CRM → 0..100 (ближе к Гутшайну = выше) или null. */
  crmStageScore: number | null;
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

// Самооценка готовности ботом (overall_readiness) → 0..100.
// «недостаточно данных»/неизвестно → null (фактор исключается).
function botQualityScore(readiness: string | null): number | null {
  if (!readiness) return null;
  const r = readiness.toLowerCase();
  if (r.includes("почти")) return 66; // «почти готов»
  if (r.includes("нужна") || r.includes("подготов")) return 33; // «нужна подготовка»
  if (r.includes("готов")) return 100; // «готов»
  return null; // «недостаточно данных» и пр.
}

function categorize(score: number): ReadinessCategory {
  if (score >= 75) return "hot";
  if (score >= 50) return "warm";
  return "cold";
}

export function computeReadiness(input: ReadinessInput): ReadinessScore {
  // Готовность ролевок актуальной стороны + бонус +10 за факт консультации (§4.2, cap 100).
  const roleplay =
    input.activeAvg === null
      ? 0
      : Math.min(100, Math.max(0, input.activeAvg * 20) + (input.consultationDone ? 10 : 0));
  const activity = activityScore(input.daysSinceLastTouch);
  const botCount = botCountScore(input.botRoleplayCount);
  const botQuality = botQualityScore(input.botReadiness);
  const sideLabel = input.activeSide === "dc" ? "ДЦ" : "АА";

  const factors: ScoreFactor[] = [
    { key: "language", label: "Язык", weight: 0.2, value: LANGUAGE_SCORE[input.languageBucket], present: true },
    { key: "roleplay", label: `Ролевки с менеджером (${sideLabel})`, weight: 0.35, value: roleplay, present: input.activeAvg !== null, mandatory: true },
    { key: "bot_count", label: "Кол-во ролевок с ботом", weight: 0.1, value: botCount ?? 0, present: botCount !== null },
    { key: "bot_quality", label: "Качество ролевок с ботом", weight: 0.1, value: botQuality ?? 0, present: botQuality !== null },
    { key: "consult_okk", label: "ОКК консультаций", weight: 0.1, value: input.consultOkk ?? 0, present: input.consultOkk !== null },
    { key: "deal_okk", label: "ОКК по сделке", weight: 0.05, value: input.dealOkk ?? 0, present: input.dealOkk !== null },
    { key: "crm_stage", label: "Стадия CRM", weight: 0.05, value: input.crmStageScore ?? 0, present: input.crmStageScore !== null },
    { key: "activity", label: "Активность 7 дней", weight: 0.05, value: activity ?? 0, present: activity !== null },
  ];

  // Знаменатель — присутствующие факторы + обязательные (пробел в которых штрафует).
  // Отсутствующие данные (нет ОКК/бота/касаний) НЕ тянут score вниз — фактор просто
  // исключается из нормировки.
  const counted = factors.filter((f) => f.present || f.mandatory);
  const denom = counted.reduce((s, f) => s + f.weight, 0);
  const acc = counted.reduce((s, f) => s + f.weight * f.value, 0);
  const score = denom > 0 ? Math.round(acc / denom) : 0;
  return { score, category: categorize(score), factors };
}
