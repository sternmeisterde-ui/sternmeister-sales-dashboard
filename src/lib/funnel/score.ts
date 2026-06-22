/**
 * Скоринг «готовности» клиента к ближайшему термину (ТЗ §8), перевешенный на
 * ВОВЛЕЧЁННОСТЬ по калибровке (2026-06-22).
 *
 * КАЛИБРОВКА по сделкам Бератера, ЗАКРЫТЫМ с 2026-04-01 (бот-эра; до апреля бота
 * не было — старые сделки исключены как шум): won=97 / lost=321. Сильнейший
 * дискриминатор гутшайна — САМ ФАКТ ролевки (менеджер ИЛИ бот): была у 38% won
 * против 10% lost (3.8×). Значения же (язык +6, качество ролевок ±0, ОКК +3) почти
 * не различают won/lost. Поэтому главный фактор — бинарная «вовлечённость», а
 * качество-факторы имеют малый вес.
 *
 * ⚠ Это РАНЖИРОВАНИЕ по готовности/вовлечённости, а не точный предиктор гутшайна:
 * даже вовлечённость покрывает лишь часть выигранных, исход решают и факторы вне
 * наших данных. Score объясним (breakdown), категории Hot≥75/Warm≥50/Cold<50.
 *
 * СТАДИЙНАЯ УСЛОВНОСТЬ: качество менеджерской ролевки берём по актуальной стороне
 * (ДЦ-фаза→ДЦ, АА-фаза→АА); неактуальная сторона не штрафует (исключена). Бот и
 * менеджер — РАЗНЫЕ сущности, не склеиваем (бот меряет объём подготовки, звонковые
 * — качество); оба входят и в «вовлечённость» (был факт), и отдельными факторами.
 *
 * Факторы (Σ весов = 1.00): вовлечённость (была ролевка менеджер|бот) 30 + ролевки
 * с менеджером (качество, актуальная сторона, +10 за консультацию) 15 + язык 15 +
 * кол-во ролевок с ботом 10 + ОКК консультаций 10 + качество бота 5 + ОКК сделки 5
 * + стадия CRM 5 + активность 5. Знаменатель = сумма весов ПРИСУТСТВУЮЩИХ факторов
 * (нет данных → фактор исключается из нормировки; вовлечённость и язык есть всегда).
 * bot_count учитывается только при count>0 (нулевой бот «вовлечённость» уже учла).
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

  // Вовлечённость — сильнейший дискриминатор гутшайна (калибровка: 38% won vs 10%
  // lost, 3.8×): была ли у клиента ХОТЬ КАКАЯ-ТО ролевка — с менеджером ИЛИ с ботом.
  // botRoleplayCount=null когда бот не сконфигурён → учитываем только менеджера.
  const engaged = input.activeAvg !== null || (input.botRoleplayCount ?? 0) > 0;

  // Веса откалиброваны по бот-эре (сделки, закрытые с 2026-04-01): факт ролевки
  // различает won/lost в 3.8×, значения (язык/качество/ОКК) — слабо (±0..+6). Отсюда
  // главный вес — бинарная «вовлечённость», качество-факторы малы.
  const factors: ScoreFactor[] = [
    { key: "engagement", label: "Прошёл ролевки (менеджер/бот)", weight: 0.3, value: engaged ? 100 : 0, present: true },
    { key: "roleplay", label: `Ролевки с менеджером (${sideLabel})`, weight: 0.15, value: roleplay, present: input.activeAvg !== null },
    { key: "language", label: "Язык", weight: 0.15, value: LANGUAGE_SCORE[input.languageBucket], present: true },
    { key: "bot_count", label: "Кол-во ролевок с ботом", weight: 0.1, value: botCount ?? 0, present: (input.botRoleplayCount ?? 0) > 0 },
    { key: "consult_okk", label: "ОКК консультаций", weight: 0.1, value: input.consultOkk ?? 0, present: input.consultOkk !== null },
    { key: "bot_quality", label: "Качество ролевок с ботом", weight: 0.05, value: botQuality ?? 0, present: botQuality !== null },
    { key: "deal_okk", label: "ОКК по сделке", weight: 0.05, value: input.dealOkk ?? 0, present: input.dealOkk !== null },
    { key: "crm_stage", label: "Стадия CRM", weight: 0.05, value: input.crmStageScore ?? 0, present: input.crmStageScore !== null },
    { key: "activity", label: "Активность 7 дней", weight: 0.05, value: activity ?? 0, present: activity !== null },
  ];

  // Знаменатель — только присутствующие факторы. Отсутствующие данные (нет ОКК/бота/
  // касаний) НЕ тянут score вниз — фактор исключается из нормировки. «Вовлечённость»
  // и «Язык» присутствуют всегда (вовлечённость=0 при отсутствии ролевок — реальный
  // штраф, т.к. это сильнейший предиктор).
  const counted = factors.filter((f) => f.present);
  const denom = counted.reduce((s, f) => s + f.weight, 0);
  const acc = counted.reduce((s, f) => s + f.weight * f.value, 0);
  const score = denom > 0 ? Math.round(acc / denom) : 0;
  return { score, category: categorize(score), factors };
}
