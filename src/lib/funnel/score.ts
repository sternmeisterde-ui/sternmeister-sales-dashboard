/**
 * Скоринг «готовности» клиента к ближайшему термину (ТЗ §8), перевешенный на
 * ВОВЛЕЧЁННОСТЬ по калибровке (2026-06-22). Бот и менеджер — РАЗДЕЛЬНО.
 *
 * КАЛИБРОВКА по сделкам Бератера, ЗАКРЫТЫМ с 2026-04-01 (бот-эра; до апреля бота
 * не было — старые сделки = шум): won=97 / lost=321. Сильнейшие дискриминаторы
 * гутшайна — САМ ФАКТ ролевки: с менеджером (была у 25% won vs 7% lost, 3.6×) и с
 * ботом (19% vs 5%, 3.8×). Значения (язык +6, качество ±0, ОКК +3) различают слабо.
 * Поэтому главные веса — у факта менеджерской ролевки и у КОЛИЧЕСТВА бот-ролевок
 * (берём кол-во, как в berater-dashboard), а качество-факторы малы.
 *
 * Бот и менеджер — РАЗНЫЕ сущности, считаем РАЗДЕЛЬНО (НЕ склеиваем в один сигнал):
 * — менеджер: «ролевка проведена» (бинарно, любая сторона) 20% + качество
 *   (актуальная сторона, +10 за консультацию) 10%
 * — бот: «кол-во ролевок» (0/40/60/80/100 по числу) 25% + качество (readiness) 5%
 * Бот-факторы активны только при заданном BERATER_BOT_DATABASE_URL (иначе count=null
 * → фактор исключается, не штрафует).
 *
 * СТАДИЙНАЯ УСЛОВНОСТЬ: качество менеджерской ролевки берём по актуальной стороне
 * (ДЦ-фаза→ДЦ, АА-фаза→АА); неактуальная не штрафует. Но «ролевка проведена» —
 * по ЛЮБОЙ стороне (факт практики важнее, чем на какой стадии).
 *
 * Прочее: язык 15 + ОКК сделки 5 + стадия CRM 5 + активность 5.
 * (ОКК консультаций убран 2026-06-25 — слабый предиктор, дублировал ОКК сделки.)
 * Σ весов = 1.00. Знаменатель = сумма весов ПРИСУТСТВУЮЩИХ факторов (нет данных →
 * фактор исключается; «менеджер проведена» и «язык» есть всегда). «Кол-во бота» —
 * ШТРАФУЮЩИЙ фактор (решение юзера 2026-07-06): 0 тренировок = 0 баллов при
 * полном весе 25%, НЕ исключается — клиент без бот-практики получает балл ниже.
 * Исключается только если бот вообще не сконфигурен (BERATER_BOT_DATABASE_URL
 * не задан → count=null).
 *
 * ⚠ Это РАНЖИРОВАНИЕ по готовности/вовлечённости, не точный предиктор гутшайна.
 * Категории Hot≥75/Warm≥50/Cold<50. Score объясним (breakdown), §8.
 */

export type LanguageBucket = "a1" | "a2" | "b1" | "b2" | "c1";
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
  /** Была ли проведена ХОТЬ ОДНА ролевка с менеджером (любая сторона ДЦ/АА).
   *  Для фактора «ролевка проведена» — факт практики, независимо от стадии. */
  hasManagerRoleplay: boolean;
  /** Дней с последнего касания или null. */
  daysSinceLastTouch: number | null;
  /** Тренировок с ботом ролевок, или null если неизвестно. */
  botRoleplayCount: number | null;
  /** Последняя самооценка готовности ботом (overall_readiness) или null. */
  botReadiness: string | null;
  /** Проведена ли консультация (для бонуса +10 к готовности ролевок, §4.2). */
  consultationDone: boolean;
  /** Средний ОКК по всем звонкам сделки (0..100) или null. */
  dealOkk: number | null;
  /** Стадия в CRM → 0..100 (ближе к Гутшайну = выше) или null. */
  crmStageScore: number | null;
}

// B2/C1/C2 = 100, B1 = 80, A2 = 50. Минимум уровня — A2: «не указан» → A2 (50).
// A1 = «не квал по языку» (отдельно, ниже A2) = 0.
const LANGUAGE_SCORE: Record<LanguageBucket, number> = {
  c1: 100,
  b2: 100,
  b1: 80,
  a2: 50,
  a1: 0,
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

  // Бот и менеджер РАЗДЕЛЬНО (калибровка: факт менеджерской 3.6×, бот 3.8×). Главные
  // веса — факт менеджерской ролевки (бинарно) и КОЛИЧЕСТВО бот-ролевок (градуировано
  // по числу, как в berater-dashboard). Качество-факторы — слабые (±0..+6) → малый вес.
  // bot_count — ШТРАФУЮЩИЙ (решение юзера 2026-07-06): 0 тренировок = value 0 при
  // полном весе, фактор НЕ скипается — «не тренировался с ботом» опускает балл.
  // Исключение только при не-сконфигуренном боте (botRoleplayCount=null).
  const factors: ScoreFactor[] = [
    { key: "bot_count", label: "Кол-во ролевок с ботом", weight: 0.25, value: botCount ?? 0, present: input.botRoleplayCount !== null },
    { key: "mgr_done", label: "Ролевка с менеджером проведена", weight: 0.2, value: input.hasManagerRoleplay ? 100 : 0, present: true },
    { key: "language", label: "Язык", weight: 0.15, value: LANGUAGE_SCORE[input.languageBucket], present: true },
    { key: "roleplay", label: `Качество ролевок с менеджером (${sideLabel})`, weight: 0.1, value: roleplay, present: input.activeAvg !== null },
    { key: "bot_quality", label: "Качество ролевок с ботом", weight: 0.05, value: botQuality ?? 0, present: botQuality !== null },
    { key: "deal_okk", label: "ОКК по сделке", weight: 0.05, value: input.dealOkk ?? 0, present: input.dealOkk !== null },
    { key: "crm_stage", label: "Стадия CRM", weight: 0.05, value: input.crmStageScore ?? 0, present: input.crmStageScore !== null },
    { key: "activity", label: "Активность 7 дней", weight: 0.05, value: activity ?? 0, present: activity !== null },
  ];

  // Знаменатель — только присутствующие факторы. Отсутствующие данные (нет ОКК/
  // касаний/бот-тренировок) НЕ тянут score вниз — фактор исключается из нормировки.
  // Всегда присутствуют «Менеджер проведена» (0 если ролевки не было — штраф за
  // невовлечённость) и «Язык»; «кол-во бота» — только при наличии тренировок (бонус).
  const counted = factors.filter((f) => f.present);
  const denom = counted.reduce((s, f) => s + f.weight, 0);
  const acc = counted.reduce((s, f) => s + f.weight * f.value, 0);
  const score = denom > 0 ? Math.round(acc / denom) : 0;
  return { score, category: categorize(score), factors };
}
