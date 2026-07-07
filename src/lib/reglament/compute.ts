/**
 * Вычисление регламентных метрик по интервалам этапов и касаниям.
 *
 * Правила ok — точные (совпали на 100% строк CSV интегратора):
 *   «Время на этапах»: ok = факт ≤ норматив.
 * Формула ФАКТА для «Рабочие дни»/«Часы» у интегратора содержит
 * невосстановленный вычет (вероятно, времени с касаниями) — мы считаем
 * честный elapsed в единицах норматива, т.е. слегка строже оригинала.
 * «Календарные дни» = дробный elapsed/24ч — совпадает с оригиналом точно.
 * См. dev_docs/specs/23a-СПРАВОЧНИК-НОРМАТИВОВ-РЕГЛАМЕНТА.md.
 */

import {
  STAGE_TIME_NORMS,
  TLT_GAP_NORMS,
  TOUCH_FROM_WHITELIST,
  touchRule,
  type FunnelKey,
  type NormUnit,
} from "@/lib/reglament/norms";
import { workDayGap, workDaysTouched } from "@/lib/reglament/working-time";
import type { StageInterval, Touch } from "@/lib/reglament/data";

// ─── Склейка этапов (как в Looker) ─────────────────────────────────
// Гос: «Новый лид» + «Взят в работу» отображаются и считаются ОДНИМ этапом
// «Новый лид / Взят в работу» (внутренний переход не является переходом).
// Бератер: «Принято от первой линии» + «Доведение» склеиваются только
// ярлыком («Принято / Доведение»), переходы между ними остаются строками.

export const GOS_COLLAPSE_GROUP: ReadonlySet<string> = new Set(["Новый лид", "Взято в работу"]);
export const GOS_COLLAPSE_LABEL = "Новый лид / Взят в работу";
const BERATER_LABEL_GROUP: ReadonlySet<string> = new Set(["Принято от первой линии", "Доведение"]);
const BERATER_LABEL = "Принято / Доведение";

export function displayStageLabel(funnel: FunnelKey, status: string): string {
  if (funnel === "gos" && GOS_COLLAPSE_GROUP.has(status)) return GOS_COLLAPSE_LABEL;
  if (funnel === "berater" && BERATER_LABEL_GROUP.has(status)) return BERATER_LABEL;
  return status;
}

/**
 * Схлопывает последовательные интервалы одной сделки:
 *  - повторный вход в ТОТ ЖЕ статус (re-entry в lead_status_changes) —
 *    всегда: у интегратора нет переходов «X → X», это одно пребывание;
 *  - Гос-группа «Новый лид»/«Взят в работу» — только при withIntake
 *    (для «Касаний»: внутренний переход группы не считается переходом).
 * Вход — интервалы одной сделки, отсортированные по enterMs.
 */
export function collapseLead(intervals: StageInterval[], withIntake: boolean): StageInterval[] {
  const out: StageInterval[] = [];
  for (const iv of intervals) {
    const prev = out[out.length - 1];
    const contiguous = prev && prev.exitMs != null && prev.exitMs === iv.enterMs;
    const sameStatus = prev && prev.status === iv.status;
    const intakePair =
      withIntake &&
      prev &&
      iv.funnel === "gos" &&
      prev.funnel === "gos" &&
      GOS_COLLAPSE_GROUP.has(iv.status) &&
      GOS_COLLAPSE_GROUP.has(prev.status);
    if (contiguous && (sameStatus || intakePair)) {
      out[out.length - 1] = { ...prev!, exitMs: iv.exitMs, nextStatus: iv.nextStatus };
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

/** Группировка по лидам + сортировка + схлопывание. */
export function collapseAll(intervals: StageInterval[], opts?: { intake?: boolean }): StageInterval[] {
  const byLead = new Map<number, StageInterval[]>();
  for (const iv of intervals) {
    (byLead.get(iv.leadId) ?? byLead.set(iv.leadId, []).get(iv.leadId)!).push(iv);
  }
  const out: StageInterval[] = [];
  for (const arr of byLead.values()) {
    arr.sort((a, b) => a.enterMs - b.enterMs);
    out.push(...collapseLead(arr, opts?.intake ?? false));
  }
  return out;
}

// ─── «Время на этапах» ──────────────────────────────────────────────

export interface StageTimeRow {
  interval: StageInterval;
  unit: NormUnit;
  limit: number;
  fact: number;
  ok: boolean;
}

/** Факт пребывания в единицах норматива этапа; null — этап без норматива. */
export function computeStageTime(iv: StageInterval, nowMs: number): StageTimeRow | null {
  const norm = STAGE_TIME_NORMS[iv.funnel][iv.status];
  if (!norm) return null;
  const start = new Date(iv.enterMs);
  const end = new Date(iv.exitMs ?? nowMs);
  let fact: number;
  if (norm.unit === "hours") {
    fact = (end.getTime() - start.getTime()) / 3_600_000;
  } else if (norm.unit === "calendar_days") {
    fact = (end.getTime() - start.getTime()) / 86_400_000;
  } else {
    fact = workDaysTouched(start, end);
  }
  fact = Math.max(0, fact);
  return { interval: iv, unit: norm.unit, limit: norm.limit, fact, ok: fact <= norm.limit };
}

// ─── TLT-GAP ────────────────────────────────────────────────────────

export interface TltGapRow {
  interval: StageInterval;
  limit: number;
  gapFact: number;
  ok: boolean;
}

/**
 * Максимальный разрыв между касаниями на этапе, рабочие дни Пн–Сб.
 * Точки: вход → касания внутри интервала → выход (или «сейчас»).
 * Касание для TLT — исходящий И входящий звонок (лист «ПРАВКИ» xlsx:
 * входящие учитываются, без порога 30 сек); у Гос также сообщения,
 * у Бератера сообщения не считаются.
 */
export function computeTltGap(
  iv: StageInterval,
  touches: Touch[] | undefined,
  nowMs: number,
): TltGapRow | null {
  const limit = TLT_GAP_NORMS[iv.funnel][iv.status];
  if (limit == null) return null;
  const endMs = iv.exitMs ?? nowMs;
  const inside = (touches ?? [])
    .filter((t) => t.ms >= iv.enterMs && t.ms <= endMs)
    .filter((t) => (iv.funnel === "berater" ? t.type !== "message" : true))
    .map((t) => t.ms);
  const points = [iv.enterMs, ...inside, endMs];
  let gap = 0;
  for (let i = 1; i < points.length; i++) {
    gap = Math.max(gap, workDayGap(new Date(points[i - 1]), new Date(points[i])));
  }
  return { interval: iv, limit, gapFact: gap, ok: gap <= limit };
}

// ─── Мин.касания (переходы) ─────────────────────────────────────────

export interface TouchesRow {
  interval: StageInterval;
  calls: number;
  messages: number;
  minCalls: number;
  minMessages: number;
  ok: boolean;
}

/** Касания за пребывание на этапе «Из» к моменту перехода. Только закрытые
 *  интервалы (переход состоялся) и только «рабочие» из-этапы (whitelist).
 *  «Звонки» — только исходящие (нормативы «1 звонок» и «18 звонков Игнора»
 *  в документе РОПа — про исходящие вызовы); входящие участвуют лишь в TLT. */
export function computeTouches(iv: StageInterval, touches: Touch[] | undefined): TouchesRow | null {
  if (iv.exitMs == null || !iv.nextStatus) return null;
  const whitelist = TOUCH_FROM_WHITELIST[iv.funnel];
  if (whitelist && !whitelist.has(iv.status)) return null;
  const inside = (touches ?? []).filter((t) => t.ms >= iv.enterMs && t.ms <= iv.exitMs!);
  const calls = inside.filter((t) => t.type === "call").length;
  const messages = inside.filter((t) => t.type === "message").length;
  // Правило привязано к исходному (несклеенному) статусу «Из» — для
  // Гос-группы «Новый лид / Взято в работу» действует базовое ≥1 звонок.
  // Причина закрытия включает правило «Игнор → 18 звонков на НДЗ».
  const rule = touchRule(iv.funnel, iv.status, iv.nextStatus, iv.closeReason);
  const ok = calls >= rule.minCalls && messages >= rule.minMessages;
  return { interval: iv, calls, messages, minCalls: rule.minCalls, minMessages: rule.minMessages, ok };
}
