/**
 * Нормативы регламента B2G.
 *
 * Источники (по убыванию авторитетности):
 *  1. ✅ Документ РОПа «Госники: критерии автопроверки регламента»
 *     (dev_docs/specs/looker/…xlsx, листы «Госники Март»/«Бератер Март» +
 *     лист «ПРАВКИ») — получен 2026-07-07;
 *  2. реверс-инжиниринг CSV-выгрузок Looker-отчёта интегратора (2026-07-06).
 * Разбор и сверка: dev_docs/specs/23a-СПРАВОЧНИК-НОРМАТИВОВ-РЕГЛАМЕНТА.md.
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

/** TLT-GAP: максимальный разрыв между касаниями на этапе (рабочие дни, Пн–Сб).
 *  Касание для TLT — исходящий ИЛИ входящий звонок (+сообщения у Гос):
 *  лист «ПРАВКИ» xlsx: «убрать в расчёте gap по входящим 30 секунд» —
 *  входящие учитываются без порога длительности. */
export const TLT_GAP_NORMS: Record<FunnelKey, Record<string, number>> = {
  gos: {
    "Новый лид": 1,
    "Взято в работу": 1,
    "Контакт установлен": 1,
    "Недозвон": 1,
    "Консультация проведена": 3,
    "Документы отправлены в ДЦ": 3,
  },
  berater: {
    "Принято от первой линии": 1,
    "Доведение": 1,
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
 * Мин.касания (проверка на переходе между этапами) — ✅ по документу РОПа:
 *  - базовое правило: ≥ 1 звонок за пребывание на этапе «Из»;
 *  - «Консультация проведена» и «Документы отправлены в ДЦ» (Гос):
 *    ≥ 1 звонок И ≥ 1 исходящее сообщение;
 *  - закрытие с причиной, содержащей «Игнор» (Гос): «если лид ушёл с этапа
 *    НДЗ в закрыто по причине ИГНОР — минимум 18 звонков на этапе НДЗ»;
 *  - правка РОПа: для дошедших до успеха касания проверяются только на
 *    фактически посещённых этапах — модель per-пребывание обеспечивает
 *    это автоматически.
 * У Бератера сообщения не считаются вовсе.
 */
export const TOUCH_MIN_CALLS_DEFAULT = 1;
export const TOUCH_STAGES_REQUIRING_MESSAGE: Record<FunnelKey, ReadonlySet<string>> = {
  gos: new Set(["Консультация проведена", "Документы отправлены в ДЦ"]),
  berater: new Set(),
};
export const CLOSED_LOST_STATUS = "Закрыто и не реализовано";
// ✅ Документ РОПа: минимум 18 звонков (данные интегратора не противоречат:
// в них зазор 15–26 пуст — все false ≤ 14, все true ≥ 27).
export const TOUCH_IGNORE_MIN_CALLS = 18;
export const TOUCH_IGNORE_FROM_STATUS = "Недозвон";

/**
 * «Мин.касания» проверяются только для переходов ИЗ «рабочих» этапов
 * (где менеджер обязан коснуться клиента) — по строке «Минимальное
 * количество касаний» документа РОПа. У Бератера ограничения нет.
 */
export const TOUCH_FROM_WHITELIST: Record<FunnelKey, ReadonlySet<string> | null> = {
  gos: new Set([
    "Новый лид",
    "Взято в работу",
    "Недозвон",
    "Контакт установлен",
    "Консультация проведена",
    "Документы отправлены в ДЦ",
    "Отложенный старт",
  ]),
  berater: null,
};

export function touchRule(
  funnel: FunnelKey,
  fromStatus: string,
  toStatus: string,
  /** Причина закрытия сделки (расшифровка неквал-enum / loss_reason). */
  closeReason?: string | null,
): {
  minCalls: number;
  minMessages: number;
} {
  if (
    funnel === "gos" &&
    fromStatus === TOUCH_IGNORE_FROM_STATUS &&
    toStatus === CLOSED_LOST_STATUS &&
    (closeReason ?? "").toLowerCase().includes("игнор")
  ) {
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

/**
 * ✅ SLA по документу РОПа: сделка должна покинуть этап «Новый лид» за
 * ≤ 25 минут (строка «Время нахождения на этапах: Новый лид — 25 минут» +
 * лист «ПРАВКИ»: «показатель sla — 25 мин», «из Бератера SLA исключаем»,
 * «ИСКЛЮЧИТЬ НЕКВАЛ ЯЗЫК ИЗ РАСЧЁТА sla»).
 * Минуты — рабочие (окно 09:00–20:00 Berlin, воскресенье нерабочее):
 * календарные 25 минут ронял бы все ночные лиды, что противоречит 100%
 * на скринах. Сводный % интегратора всё равно не воспроизводится ни одной
 * из четырёх проверенных формул — считаем по документу и не гонимся за
 * их реализацией.
 */
export const NEW_LEAD_STATUS = "Новый лид";
export const NEW_LEAD_SLA_WORK_MINUTES = 25;
/** Подстрока причины неквала, исключающая лид из расчёта SLA. */
export const SLA_EXCLUDE_REASON_SUBSTRING = "язык";

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
