/**
 * Расчёт когорт C1–C5 поверх `analytics.*`. См. dev_docs/funnel/02 §6 и 03 §9.
 *
 * Подход (минимальный, без точной qualification_date):
 * - **База C1/C2/C5** = квал-лиды Бух Гос, anchor = lead.created_at
 *   (упрощение от cohort-conversion: там anchor = дата первой квал-транзиции).
 * - **База C3**     = успешные C2 + у линкованного Бератер-лида был статус
 *   «Конс. перед ДЦ» (102183935) или «Конс. перед ДЦ проведена» (102183939).
 * - **База C4**     = квал-лиды Бух Гос + у линкованного Бератер-лида был статус
 *   «Конс. АА» (102183943), «Конс. АА проведена» (102183947) или Гутшайн (142).
 *
 * - **C1 target** = «Документы отправлены в ДЦ» (101935919) OR Термин ДЦ (142 Гос).
 * - **C2 target** = Термин ДЦ (142 Гос).
 * - **C3 target** = «Термин ДЦ состоялся» (93886075) Бератер,
 *                   inferred: 102183943, 102183947, 142.
 * - **C4 target** = Гутшайн (142 Бератер).
 * - **C5 target** = Гутшайн (142 Бератер).
 *
 * Cross-pipeline для C3/C4/C5: через `lead_contact_links` (только активные).
 * Snapshot fallback для всех target-ов: если в `lead_status_changes` нет события,
 * но lead-снэпшот сейчас в целевом статусе — считаем (target_at = anchor / created_at).
 *
 * Окна зрелости: 4/6/8/12/16 нед для C1..C5.
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import {
  B2G_PIPELINES,
  FIRST_LINE_STATUSES,
  BERATER_STATUSES,
  QUAL_FIRST_LINE_STATUS_IDS,
} from "@/lib/kommo/pipeline-config";
import type { CohortsApiCohort, CohortsApiResponse } from "./api-types";
import type { ConversionId, MaturityFilter } from "./types";
import { CONVERSIONS, CONVERSION_ORDER } from "./conversions";
import {
  isoLabel,
  isoWeekEndBerlin,
  isoWeekStartBerlin,
  isMature,
  maturityTargetAt,
  todayBerlinUTC,
} from "./cohort-math";
import type { LanguageBucket } from "./score";

const BUH_GOS = B2G_PIPELINES.FIRST_LINE; // 10935879
const BERATER = B2G_PIPELINES.BERATER; // 12154099

/**
 * SQL-фрагмент WHERE для фильтра по уровню языка. Бакеты совпадают с
 * normalizeLanguageLevel: a2/b1/b2/c1 = начинается с уровня; unknown = NULL,
 * A1 или нераспознанное. Колонка `language_level` (Kommo CFV 869928).
 * Пусто, если bucket не задан. Применяется к `analytics.leads_cohort`.
 */
export function languageBucketSql(bucket: LanguageBucket | null | undefined) {
  switch (bucket) {
    case "a2":
      return sql` AND TRIM(language_level) ILIKE 'A2%'`;
    case "b1":
      return sql` AND TRIM(language_level) ILIKE 'B1%'`;
    case "b2":
      return sql` AND TRIM(language_level) ILIKE 'B2%'`;
    case "c1":
      return sql` AND (TRIM(language_level) ILIKE 'C1%' OR TRIM(language_level) ILIKE 'C2%')`;
    case "unknown":
      return sql` AND (language_level IS NULL OR NOT (
        TRIM(language_level) ILIKE 'A2%' OR TRIM(language_level) ILIKE 'B1%' OR
        TRIM(language_level) ILIKE 'B2%' OR TRIM(language_level) ILIKE 'C1%' OR
        TRIM(language_level) ILIKE 'C2%'))`;
    default:
      return sql``;
  }
}

// ── Целевые статусы C1/C2 (на Бух Гос) ──
const C1_TARGET_STATUSES = [
  FIRST_LINE_STATUSES.DOCS_SENT_DC,
  FIRST_LINE_STATUSES.WON, // inferred: дошёл до Термин ДЦ → документы были
];
const C2_TARGET_STATUSES = [FIRST_LINE_STATUSES.WON];

// ── Статусы на Бератер, которые нас интересуют для C3/C4/C5 ──
const C3_BASE_STATUSES = [
  BERATER_STATUSES.CONSULT_BEFORE_DC,
  BERATER_STATUSES.CONSULT_BEFORE_DC_DONE,
];
const C3_TARGET_STATUSES = [
  BERATER_STATUSES.TERM_DC_DONE, // 93886075 — основной target
  BERATER_STATUSES.CONSULT_BEFORE_AA, // inferred
  BERATER_STATUSES.CONSULT_BEFORE_AA_DONE,
  BERATER_STATUSES.WON, // inferred: Гутшайн ⇒ Термин ДЦ был
];
const C4_BASE_STATUSES = [
  BERATER_STATUSES.CONSULT_BEFORE_AA,
  BERATER_STATUSES.CONSULT_BEFORE_AA_DONE,
  BERATER_STATUSES.WON,
];
const C4_TARGET_STATUSES = [BERATER_STATUSES.WON];
const C5_TARGET_STATUSES = [BERATER_STATUSES.WON];

// ── C3.1 «Термин ДЦ → дошёл до АА» (на Бератере) ──
// Определение РОПа: база — лиды с явным «Термин ДЦ состоялся»; считаем долю
// «продвинувшихся дальше».
//  • forward (продвинулись) = реальный АА-этап. «Термин АА отменён/перенесён»
//    (93860883) и «Термин АА (на этапе)» (93860879) НЕ считаются продвижением.
//    «Отложенный старт» (95515895) — считается (РОП отметил его в фильтре).
//  • потеря = всё, что НЕ forward: застрял на ДЦ / сразу в «Закрыто» (143) /
//    «Термин АА отменён». Знаменатель = ВСЕ с ДЦ (застрявшие тоже в нём).
const DC_DONE_STATUS = BERATER_STATUSES.TERM_DC_DONE; // 93886075
const C31_FORWARD_STATUSES = [
  BERATER_STATUSES.CONSULT_BEFORE_AA, // 102183943
  BERATER_STATUSES.CONSULT_BEFORE_AA_DONE, // 102183947
  BERATER_STATUSES.BERATER_REVIEW, // 93860887 — пост-АА
  BERATER_STATUSES.DELAYED_START, // 95515895 — РОП считает продвижением
  BERATER_STATUSES.APPEAL, // 93860891 — апелляция = АА пройден
  BERATER_STATUSES.WON, // 142 — Гутшайн
];
const C31_CLOSED_STATUS = BERATER_STATUSES.LOST; // 143 — «Закрыто и не реализовано»
const C31_AA_CANCELLED_STATUS = BERATER_STATUSES.TERM_AA_CANCELLED; // 93860883 — НЕ продвижение

const ALL_BERATER_RELEVANT_STATUSES = [
  ...new Set([
    ...C3_BASE_STATUSES,
    ...C3_TARGET_STATUSES,
    ...C4_BASE_STATUSES,
    ...C4_TARGET_STATUSES,
    ...C5_TARGET_STATUSES,
    // C3.1
    DC_DONE_STATUS,
    ...C31_FORWARD_STATUSES,
    C31_CLOSED_STATUS,
    C31_AA_CANCELLED_STATUS,
  ]),
];

export interface ComputeOpts {
  from: Date;
  to: Date;
  maturity: MaturityFilter;
  source: string | null;
  responsibleUserId: number | null;
  /** Фильтр по уровню языка (бакет). null/undefined = без фильтра. */
  lang?: LanguageBucket | null;
}

export interface BaseLead {
  leadId: number;
  /** Anchor = lead.created_at (как qualification_at в cohort-conversion). */
  anchorAt: Date;
  responsibleUserId: number | null;
  utmSource: string | null;
  currentStatusId: number;
  /** True если в моменте lead дисквалифицирован (non_qual_enum_id ∈ NEQVAL). */
  isDisqualified: boolean;
  /** True если причина закрытия — «Игнор» (non_qual_enum_id ∈ IGNOR). Для C1.1/C2.1. */
  isIgnor: boolean;
  /** Дата дисквалификации: точная (из истории CFV 879824) или приближение через updated_at. */
  disqualifiedAt: Date | null;
  /** Нормализованный уровень языка: a2/b1/b2/c1/unknown. */
  languageBucket: "a2" | "b1" | "b2" | "c1" | "unknown";
}

/** Дисквалифицирующие enum_id (из src/lib/kommo/metrics.ts NEQVAL_ENUM_IDS). */
const NEQVAL_ENUM_IDS = new Set<number>([
  744486, 744876, 747530, 747532, 747534, 747536,
]);

/**
 * enum_id поля 879824, который трактуем как «тема Игнор» для под-конверсий
 * C1.1/C2.1. Только базовый «Игнор» (744314) — клиент пропал ДО продвижения
 * по этапам. Варианты «Игнор после отправки документов/термина» НЕ включаем:
 * там лид уже дошёл до цели C1/C2, исключение спрятало бы реальную конверсию.
 * «Игнор» НЕ пересекается с NEQVAL — это разные значения одного select-поля.
 */
const IGNOR_ENUM_IDS = new Set<number>([744314]);

/** Под-конверсии, у которых из базы вычитаются «игнор»-лиды (C1.1/C2.1). */
export function excludesIgnor(id: ConversionId): boolean {
  return id === "C1.1" || id === "C2.1";
}

function normalizeLanguageLevel(
  raw: string | null
): "a2" | "b1" | "b2" | "c1" | "unknown" {
  if (!raw) return "unknown";
  const m = raw.trim().match(/^[A-C][12]/i);
  if (!m) return "unknown";
  const lvl = m[0].toUpperCase();
  if (lvl === "A2") return "a2";
  if (lvl === "B1") return "b1";
  if (lvl === "B2") return "b2";
  if (lvl === "C1" || lvl === "C2") return "c1"; // C2 кладём в C1 bucket
  return "unknown"; // A1 → unknown
}

export interface BeraterLead {
  leadId: number;
  currentStatusId: number;
  createdAt: Date;
  /** Ответственный Бератер-сделки (бератер/доведение). null если неизвестен. */
  responsibleUserId: number | null;
  /** statusId → earliest event_at для этого Бератер-лида. */
  events: Map<number, Date>;
}

interface AggBucket {
  weekStart: Date;
  base: number;
  target: number;
  disqualified: number;
  langA2: number;
  langB1: number;
  langB2: number;
  langC1: number;
  langUnknown: number;
}

async function fetchBenchmarks(): Promise<
  Partial<Record<ConversionId, number | null>>
> {
  const rows = await analyticsDb.execute(sql`
    SELECT conversion_id AS "conversionId", conversion_pct AS "conversionPct"
    FROM analytics.funnel_target_levels
  `);
  const data = unwrapRows<{
    conversionId: string;
    conversionPct: number | string | null;
  }>(rows);
  const out: Partial<Record<ConversionId, number | null>> = {};
  for (const r of data) {
    const id = r.conversionId as ConversionId;
    out[id] = r.conversionPct === null ? null : Number(r.conversionPct);
  }
  return out;
}

export async function computeCohorts(
  opts: ComputeOpts
): Promise<CohortsApiResponse> {
  // ── 1. Квал-лиды + benchmarks параллельно (benchmarks не зависит от leadIds). ──
  const [baseLeadsRaw, benchmarks] = await Promise.all([
    fetchQualifiedBaseLeads(opts),
    fetchBenchmarks(),
  ]);
  const leadIds = baseLeadsRaw.map((l) => l.leadId);

  // ── 1b–3. Все три дочерних запроса не зависят друг от друга → в параллель.
  // Раньше шли последовательно ~5s; параллельно ~2s.
  const [closeReasonHistory, targetEvents, beraterContext] = leadIds.length
    ? await Promise.all([
        fetchCloseReasonHistory(leadIds),
        fetchTargetEvents(leadIds),
        fetchBeraterContext(leadIds),
      ])
    : [
        new Map<number, CloseReasonEvent[]>(),
        new Map<string, Date>(),
        new Map<number, BeraterLead[]>(),
      ];

  // Обогащаем disqualified_at точной датой из истории если есть.
  const baseLeads = baseLeadsRaw.map((lead) =>
    enrichDisqualifiedAt(lead, closeReasonHistory.get(lead.leadId))
  );

  // ── 4. Группировка по неделям + per-conversion агрегация ──
  // Cache (weekStart, weekKey) per lead — раньше пересчитывалось 5 раз
  // (по разу на каждую конверсию). На 7к лидов = 35к лишних вызовов
  // isoWeekStartBerlin + Date->string.
  const leadCohortCache = baseLeads.map((lead) => {
    const weekStart = isoWeekStartBerlin(lead.anchorAt);
    return { lead, weekStart, weekKey: isoDate(weekStart) };
  });

  const cohorts: CohortsApiCohort[] = [];
  const now = todayBerlinUTC();

  // Per-conversion (week → bucket) — заполним в одном проходе по лидам.
  const cohortMapsByConv = new Map<ConversionId, Map<string, AggBucket>>();
  for (const id of CONVERSION_ORDER) {
    cohortMapsByConv.set(id, new Map<string, AggBucket>());
  }

  // Один проход по лидам, вычисляем результаты для всех конверсий сразу.
  // C1.1/C2.1 переиспользуют результат C1/C2 (та же логика, разница лишь в
  // excludesIgnor() фильтре). Раньше processLeadForConversion вызывался
  // 7 раз/лид — теперь 5.
  for (const { lead, weekStart, weekKey } of leadCohortCache) {
    const r1 = processLeadForConversion(
      "C1",
      lead,
      targetEvents,
      beraterContext
    );
    const r2 = processLeadForConversion(
      "C2",
      lead,
      targetEvents,
      beraterContext
    );
    const r3 = processLeadForConversion(
      "C3",
      lead,
      targetEvents,
      beraterContext
    );
    const r4 = processLeadForConversion(
      "C4",
      lead,
      targetEvents,
      beraterContext
    );
    const r5 = processLeadForConversion(
      "C5",
      lead,
      targetEvents,
      beraterContext
    );
    // C3.1 здесь НЕ участвует — у неё своя 3-состояний логика в цикле ниже
    // (ветка `if (conversionId === "C3.1")` делает continue до этого доступа).
    const resultsByConv: Record<
      Exclude<ConversionId, "C3.1">,
      { included: boolean; targetAt: Date | null }
    > = {
      C1: r1,
      "C1.1": r1,
      C2: r2,
      "C2.1": r2,
      C3: r3,
      C4: r4,
      C5: r5,
    };

    for (const conversionId of CONVERSION_ORDER) {
      // C1.1/C2.1: «игнор»-лиды полностью вне расчёта — ни в базе, ни в цели,
      // ни в дисквале.
      if (excludesIgnor(conversionId) && lead.isIgnor) continue;

      const cohortMap = cohortMapsByConv.get(conversionId)!;
      let bucket = cohortMap.get(weekKey);
      if (!bucket) {
        bucket = {
          weekStart,
          base: 0,
          target: 0,
          disqualified: 0,
          langA2: 0,
          langB1: 0,
          langB2: 0,
          langC1: 0,
          langUnknown: 0,
        };
        cohortMap.set(weekKey, bucket);
      }

      // C3.1 — отдельная логика, БЕЗ Гос-дисквала: база = ВСЕ с ДЦ (success +
      // failure), факт = success. Из знаменателя исключаем только `none` (нет
      // ДЦ). Застрявшие на ДЦ входят в базу как потеря. «Отсев» (=база−факт) =
      // все потери (застрял / закрыто / Термин АА отменён).
      if (conversionId === "C3.1") {
        const state = classifyDcToAa(lead, beraterContext);
        if (state === "none") continue;
        bucket.base += 1;
        if (lead.languageBucket === "a2") bucket.langA2 += 1;
        else if (lead.languageBucket === "b1") bucket.langB1 += 1;
        else if (lead.languageBucket === "b2") bucket.langB2 += 1;
        else if (lead.languageBucket === "c1") bucket.langC1 += 1;
        else bucket.langUnknown += 1;
        if (state === "success") bucket.target += 1;
        continue;
      }

      const result = resultsByConv[conversionId];

      // Target учитывается если дошёл до цели И (не дисквалифицирован ИЛИ
      // target_at ≤ disq_at). Это _target_counts() cohort-conversion qualification.py.
      if (result.included && result.targetAt !== null) {
        const targetCounts =
          lead.disqualifiedAt === null ||
          result.targetAt <= lead.disqualifiedAt;
        if (targetCounts) bucket.target += 1;
      }

      // Currently-disqualified → в disqualified, НЕ в base. Соответствует
      // displayLeadCount() cohort-conversion: "Лиды" = base - disq (C1/C2/C5).
      // Но target выше уже посчитан если дошёл до цели до дисквала.
      if (lead.isDisqualified) {
        bucket.disqualified += 1;
        continue;
      }

      if (!result.included) continue;

      bucket.base += 1;
      if (lead.languageBucket === "a2") bucket.langA2 += 1;
      else if (lead.languageBucket === "b1") bucket.langB1 += 1;
      else if (lead.languageBucket === "b2") bucket.langB2 += 1;
      else if (lead.languageBucket === "c1") bucket.langC1 += 1;
      else bucket.langUnknown += 1;
    }
  }

  for (const conversionId of CONVERSION_ORDER) {
    const meta = CONVERSIONS[conversionId];
    const cohortMap = cohortMapsByConv.get(conversionId)!;

    for (const [, bucket] of cohortMap) {
      const weekEnd = isoWeekEndBerlin(bucket.weekStart);
      const mature = isMature(weekEnd, meta.maturityWeeks, now);
      if (opts.maturity === "mature" && !mature) continue;
      if (opts.maturity === "immature" && mature) continue;
      const pct =
        bucket.base > 0 ? (bucket.target / bucket.base) * 100 : null;
      // base и disqualified — НЕпересекающиеся множества (дисквал не в base).
      // disqualification_pct = disqualified / (base + disqualified) * 100
      // — это «Квал %» в обратной форме: 100 - disq_pct = квал.
      const denom = bucket.base + bucket.disqualified;
      const disqPct = denom > 0 ? (bucket.disqualified / denom) * 100 : null;
      cohorts.push({
        conversionId,
        weekStartIso: isoDate(bucket.weekStart),
        weekEndIso: isoDate(weekEnd),
        isoLabel: isoLabel(bucket.weekStart),
        baseCount: bucket.base,
        targetCount: bucket.target,
        conversionPct: pct,
        maturityState: mature ? "mature" : "immature",
        maturityTargetAtIso: maturityTargetAt(
          weekEnd,
          meta.maturityWeeks
        ).toISOString(),
        disqualifiedCount: bucket.disqualified,
        disqualificationPct: disqPct,
        languageLevels: buildLanguageBreakdown(bucket),
      });
    }
  }

  cohorts.sort(
    (a, b) =>
      a.conversionId.localeCompare(b.conversionId) ||
      a.weekStartIso.localeCompare(b.weekStartIso)
  );

  // Время последнего ETL-обновления когорты — берём NOW (моковая «синхро только что»).
  const lastSyncAt = new Date();

  return {
    cohorts,
    lastSyncAtIso: lastSyncAt.toISOString(),
    unsupportedConversionIds: [],
    benchmarks,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-conversion: входит ли лид в базу
// ──────────────────────────────────────────────────────────────────────────

/**
 * За одно вычисление возвращает: включён ли лид в базу конверсии + targetAt.
 * Точно реплицирует cohort-conversion's domain/cohorts.py с temporal-ordering:
 * - C1/C2: target_at должен быть после anchor_at (=lead.created_at)
 * - C3: C2-target должен быть валиден (target_at ≤ disqualified_at) +
 *   Бератер достиг CONSULT_BEFORE_DC/DONE ПОСЛЕ C2-target + цель ПОСЛЕ этого
 * - C4: Бератер достиг CONSULT_BEFORE_AA/DONE/WON ПОСЛЕ anchor + цель ПОСЛЕ этого
 * - C5: цель в Бератер WON ПОСЛЕ anchor
 */
export function processLeadForConversion(
  conversionId: ConversionId,
  lead: BaseLead,
  targetEvents: Map<string, Date>,
  beraterContext: Map<number, BeraterLead[]>
): { included: boolean; targetAt: Date | null } {
  const anchorAt = lead.anchorAt;

  // C1.1 — та же цель, что C1 (вычитание «игнор»-лидов делает вызывающий код).
  if (conversionId === "C1" || conversionId === "C1.1") {
    const targetAt = pickEarliestGosTargetAfter(
      lead,
      targetEvents,
      C1_TARGET_STATUSES,
      anchorAt
    );
    return { included: true, targetAt };
  }

  // C2.1 — та же цель, что C2.
  if (conversionId === "C2" || conversionId === "C2.1") {
    const targetAt = pickEarliestGosTargetAfter(
      lead,
      targetEvents,
      C2_TARGET_STATUSES,
      anchorAt
    );
    return { included: true, targetAt };
  }

  const berater = beraterContext.get(lead.leadId) ?? [];

  if (conversionId === "C3") {
    // База — успешный C2 (target_at ≤ disqualified_at)
    const c2TargetAt = pickEarliestGosTargetAfter(
      lead,
      targetEvents,
      C2_TARGET_STATUSES,
      anchorAt
    );
    if (c2TargetAt === null) return { included: false, targetAt: null };
    if (
      lead.disqualifiedAt !== null &&
      c2TargetAt > lead.disqualifiedAt
    ) {
      return { included: false, targetAt: null };
    }
    // Бератер достиг CONSULT_BEFORE_DC / DONE после C2-target
    const baseRequiredAt = earliestBeraterEventAfter(
      berater,
      C3_BASE_STATUSES,
      c2TargetAt
    );
    if (baseRequiredAt === null) return { included: false, targetAt: null };
    const targetAt = earliestBeraterEventAfter(
      berater,
      C3_TARGET_STATUSES,
      baseRequiredAt
    );
    return { included: true, targetAt };
  }

  if (conversionId === "C4") {
    // Бератер достиг CONSULT_BEFORE_AA / DONE / WON после anchor
    const baseRequiredAt = earliestBeraterEventAfter(
      berater,
      C4_BASE_STATUSES,
      anchorAt
    );
    if (baseRequiredAt === null) return { included: false, targetAt: null };
    const targetAt = earliestBeraterEventAfter(
      berater,
      C4_TARGET_STATUSES,
      baseRequiredAt
    );
    return { included: true, targetAt };
  }

  if (conversionId === "C5") {
    // Все квал-лиды Гос, target = earliest Бератер WON после anchor
    const targetAt = earliestBeraterEventAfter(
      berater,
      C5_TARGET_STATUSES,
      anchorAt
    );
    return { included: true, targetAt };
  }

  return { included: false, targetAt: null };
}

// ──────────────────────────────────────────────────────────────────────────
// C3.1: классификация судьбы лида ПОСЛЕ «Термин ДЦ состоялся»
// ──────────────────────────────────────────────────────────────────────────

export type DcToAaState = "success" | "failure" | "none";
export type DcToAaDetail =
  | "forward"
  | "closed"
  | "aa_cancelled"
  | "stuck"
  | "none";

/**
 * ДЕТАЛЬНАЯ судьба Гос-лида после «Термин ДЦ состоялся» — для панели «Разбор
 * когорты» (РОП: «куда подевались»). Работает по линкованным Бератер-лидам.
 *
 *  - `none`         — у Бератера нет явного «Термин ДЦ состоялся» (93886075)
 *                     после якоря → лид вне базы C3.1.
 *  - `forward`      — продвинулся в АА (C31_FORWARD: консультации АА, на
 *                     рассмотрении, отложенный старт, апелляция, Гутшайн).
 *  - `closed`       — сразу в «Закрыто и не реализовано» (143) без АА.
 *  - `aa_cancelled` — «Термин АА отменён/перенесён» (93860883) — НЕ продвижение
 *                     (по РОПу), но и не «застрял на ДЦ». Обычно ~0 лидов.
 *  - `stuck`        — ДЦ был, движения дальше нет → застрял на «Термин ДЦ».
 *
 * Приоритет: forward → closed → aa_cancelled → stuck. forward первым, т.к.
 * измеряем «дошёл ли до АА» (даже если потом отвалился — всё равно «дошёл»).
 */
export function classifyDcToAaDetailed(
  lead: BaseLead,
  beraterContext: Map<number, BeraterLead[]>
): DcToAaDetail {
  const berater = beraterContext.get(lead.leadId) ?? [];
  const dcAt = earliestBeraterEventAfter(
    berater,
    [DC_DONE_STATUS],
    lead.anchorAt
  );
  if (dcAt === null) return "none";
  if (earliestBeraterEventAfter(berater, C31_FORWARD_STATUSES, dcAt) !== null) {
    return "forward";
  }
  if (earliestBeraterEventAfter(berater, [C31_CLOSED_STATUS], dcAt) !== null) {
    return "closed";
  }
  if (
    earliestBeraterEventAfter(berater, [C31_AA_CANCELLED_STATUS], dcAt) !== null
  ) {
    return "aa_cancelled";
  }
  return "stuck";
}

/**
 * C3.1: success/failure — ПРОИЗВОДНОЕ от detailed (единый источник истины).
 * forward → success; всё прочее (closed/aa_cancelled/stuck) → failure.
 * «Застрявшие на ДЦ» теперь В ЗНАМЕНАТЕЛЕ (потеря), а не исключаются — по
 * определению РОПа: отрицательный исход = застрял на ДЦ ИЛИ сразу в «Закрыто».
 */
export function classifyDcToAa(
  lead: BaseLead,
  beraterContext: Map<number, BeraterLead[]>
): DcToAaState {
  const d = classifyDcToAaDetailed(lead, beraterContext);
  if (d === "none") return "none";
  return d === "forward" ? "success" : "failure";
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers — все требуют not_before constraint для temporal correctness
// ──────────────────────────────────────────────────────────────────────────

/**
 * Earliest event_at >= notBefore среди targetStatuses на Бух Гос. Если событий нет,
 * но lead в моменте в одном из targetStatuses — snapshot fallback (target_at = notBefore).
 */
function pickEarliestGosTargetAfter(
  lead: BaseLead,
  events: Map<string, Date>,
  targetStatuses: readonly number[],
  notBefore: Date
): Date | null {
  let earliest: Date | null = null;
  for (const statusId of targetStatuses) {
    const key = `${lead.leadId}|${BUH_GOS}|${statusId}`;
    const ev = events.get(key);
    if (
      ev !== undefined &&
      ev.getTime() >= notBefore.getTime() &&
      (earliest === null || ev < earliest)
    ) {
      earliest = ev;
    }
  }
  if (earliest) return earliest;
  // Snapshot fallback: lead currently в target → target_at = notBefore (anchor).
  if (targetStatuses.includes(lead.currentStatusId)) {
    return notBefore;
  }
  return null;
}

/**
 * Earliest event_at >= notBefore среди statuses у всех линкованных Бератер-лидов.
 * НЕТ snapshot fallback — без события невозможно определить дату транзиции,
 * cohort-conversion работает аналогично.
 */
function earliestBeraterEventAfter(
  beraterLeads: BeraterLead[],
  statuses: readonly number[],
  notBefore: Date
): Date | null {
  let earliest: Date | null = null;
  const nb = notBefore.getTime();
  for (const bl of beraterLeads) {
    for (const s of statuses) {
      const ev = bl.events.get(s);
      if (
        ev !== undefined &&
        ev.getTime() >= nb &&
        (earliest === null || ev < earliest)
      ) {
        earliest = ev;
      }
    }
  }
  return earliest;
}

// ──────────────────────────────────────────────────────────────────────────
// SQL: квал-лиды Бух Гос
// ──────────────────────────────────────────────────────────────────────────

export async function fetchQualifiedBaseLeads(
  opts: ComputeOpts
): Promise<BaseLead[]> {
  // База = лиды Бух Гос со статусом из QUAL_FIRST_LINE (исключая UNSORTED/BASE).
  // НЕ фильтруем по non_qual_enum_id — дисквалифицированные нужны в знаменателе,
  // флаг is_disqualified трекаем по snapshot non_qual_enum_id.
  const qualStatusIn = QUAL_FIRST_LINE_STATUS_IDS.join(",");

  // Anchor = lead.created_at (как у cohort-conversion qualification_at:
  // qualification_at = lead.created_at if is_current_buh_gos_pool ...).
  // exclude_from_analytics — лиды с этим флагом полностью выпадают.
  const rows = await analyticsDb.execute(sql`
    SELECT
      lead_id                 AS "leadId",
      created_at              AS "anchorAt",
      responsible_user_id     AS "responsibleUserId",
      utm_source              AS "utmSource",
      status_id               AS "statusId",
      non_qual_enum_id        AS "nonQualEnumId",
      language_level          AS "languageLevel",
      updated_at              AS "updatedAt"
    FROM analytics.leads_cohort
    WHERE pipeline_id = ${BUH_GOS}
      AND status_id IN (${sql.raw(qualStatusIn)})
      AND exclude_from_analytics = FALSE
      AND is_deleted = FALSE
      AND created_at >= ${opts.from.toISOString()}
      AND created_at <  ${opts.to.toISOString()}
      ${opts.source ? sql`AND utm_source = ${opts.source}` : sql``}
      ${
        opts.responsibleUserId !== null
          ? sql`AND responsible_user_id = ${opts.responsibleUserId}`
          : sql``
      }
      ${languageBucketSql(opts.lang)}
  `);

  const data = unwrapRows<{
    leadId: string | number;
    anchorAt: string | Date;
    responsibleUserId: string | number | null;
    utmSource: string | null;
    statusId: string | number;
    nonQualEnumId: string | number | null;
    languageLevel: string | null;
    updatedAt: string | Date | null;
  }>(rows);
  return data.map((r) => {
    const nonQualEnumId =
      r.nonQualEnumId === null ? null : Number(r.nonQualEnumId);
    const isDisqualified =
      nonQualEnumId !== null && NEQVAL_ENUM_IDS.has(nonQualEnumId);
    const isIgnor =
      nonQualEnumId !== null && IGNOR_ENUM_IDS.has(nonQualEnumId);
    const updatedAt =
      r.updatedAt === null
        ? null
        : r.updatedAt instanceof Date
          ? r.updatedAt
          : new Date(r.updatedAt);
    return {
      leadId: Number(r.leadId),
      anchorAt:
        r.anchorAt instanceof Date ? r.anchorAt : new Date(r.anchorAt),
      responsibleUserId:
        r.responsibleUserId === null ? null : Number(r.responsibleUserId),
      utmSource: r.utmSource,
      currentStatusId: Number(r.statusId),
      isDisqualified,
      isIgnor,
      // Приближение: если currently disqualified — берём updated_at как
      // приблизительную дату. enrichDisqualifiedAt() заменит на точную из
      // истории CFV 879824 если она есть.
      disqualifiedAt: isDisqualified ? updatedAt : null,
      languageBucket: normalizeLanguageLevel(r.languageLevel),
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// SQL: события на Бух Гос для C1/C2 целей
// ──────────────────────────────────────────────────────────────────────────

export async function fetchTargetEvents(
  leadIds: number[]
): Promise<Map<string, Date>> {
  const targetStatusIds = [
    ...new Set([...C1_TARGET_STATUSES, ...C2_TARGET_STATUSES]),
  ];
  const leadIdsIn = leadIds.join(",");
  const targetStatusIn = targetStatusIds.join(",");
  const rows = await analyticsDb.execute(sql`
    SELECT
      lead_id      AS "leadId",
      pipeline_id  AS "pipelineId",
      status_id    AS "statusId",
      MIN(event_at) AS "eventAt"
    FROM analytics.lead_status_changes
    WHERE lead_id IN (${sql.raw(leadIdsIn)})
      AND pipeline_id = ${BUH_GOS}
      AND status_id IN (${sql.raw(targetStatusIn)})
    GROUP BY lead_id, pipeline_id, status_id
  `);
  const data = unwrapRows<{
    leadId: string | number;
    pipelineId: string | number;
    statusId: string | number;
    eventAt: string | Date;
  }>(rows);
  const m = new Map<string, Date>();
  for (const r of data) {
    const k = `${Number(r.leadId)}|${Number(r.pipelineId)}|${Number(r.statusId)}`;
    m.set(k, r.eventAt instanceof Date ? r.eventAt : new Date(r.eventAt));
  }
  return m;
}

// ──────────────────────────────────────────────────────────────────────────
// SQL: контекст Бератер для C3/C4/C5
// ──────────────────────────────────────────────────────────────────────────

/**
 * Для каждого base lead находим все линкованные Бератер-лиды (через
 * lead_contact_links → leads_cohort.pipeline_id=12154099) и собираем для них
 * snapshot (current status + created_at) + историю событий по релевантным статусам.
 */
export async function fetchBeraterContext(
  baseLeadIds: number[]
): Promise<Map<number, BeraterLead[]>> {
  const idsIn = baseLeadIds.join(",");

  // 1. Линкованные Бератер-лиды (для каждого base — список их snapshot).
  const linkRows = unwrapRows<{
    baseLeadId: string | number;
    leadId: string | number;
    statusId: string | number;
    createdAt: string | Date;
    responsibleUserId: string | number | null;
  }>(
    await analyticsDb.execute(sql`
      SELECT DISTINCT
        base_lcl.lead_id          AS "baseLeadId",
        berater.lead_id           AS "leadId",
        berater.status_id         AS "statusId",
        berater.created_at        AS "createdAt",
        berater.responsible_user_id AS "responsibleUserId"
      FROM analytics.lead_contact_links AS base_lcl
      INNER JOIN analytics.lead_contact_links AS berater_lcl
        ON berater_lcl.contact_id = base_lcl.contact_id
       AND berater_lcl.is_active = TRUE
       AND berater_lcl.lead_id <> base_lcl.lead_id
      INNER JOIN analytics.leads_cohort AS berater
        ON berater.lead_id = berater_lcl.lead_id
       AND berater.pipeline_id = ${BERATER}
      WHERE base_lcl.lead_id IN (${sql.raw(idsIn)})
        AND base_lcl.is_active = TRUE
      ORDER BY base_lcl.lead_id, berater.lead_id
    `)
  );

  if (linkRows.length === 0) return new Map();

  // 2. Релевантные статус-события для всех найденных Бератер-лидов.
  const beraterLeadIds = Array.from(
    new Set(linkRows.map((r) => Number(r.leadId)))
  );
  const beraterIdsIn = beraterLeadIds.join(",");
  const beraterStatusesIn = ALL_BERATER_RELEVANT_STATUSES.join(",");

  const eventRows = unwrapRows<{
    leadId: string | number;
    statusId: string | number;
    eventAt: string | Date;
  }>(
    await analyticsDb.execute(sql`
      SELECT
        lead_id      AS "leadId",
        status_id    AS "statusId",
        MIN(event_at) AS "eventAt"
      FROM analytics.lead_status_changes
      WHERE lead_id IN (${sql.raw(beraterIdsIn)})
        AND pipeline_id = ${BERATER}
        AND status_id IN (${sql.raw(beraterStatusesIn)})
      GROUP BY lead_id, status_id
    `)
  );

  // 3. Build per-Бератер-лид map событий.
  const eventsPerLead = new Map<number, Map<number, Date>>();
  for (const ev of eventRows) {
    const lid = Number(ev.leadId);
    const sid = Number(ev.statusId);
    let m = eventsPerLead.get(lid);
    if (!m) {
      m = new Map();
      eventsPerLead.set(lid, m);
    }
    const at = ev.eventAt instanceof Date ? ev.eventAt : new Date(ev.eventAt);
    m.set(sid, at);
  }

  // 4. Сборка результата: base → Бератер-лиды.
  const result = new Map<number, BeraterLead[]>();
  for (const row of linkRows) {
    const baseLid = Number(row.baseLeadId);
    const beraterLid = Number(row.leadId);
    const beraterLead: BeraterLead = {
      leadId: beraterLid,
      currentStatusId: Number(row.statusId),
      createdAt:
        row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
      responsibleUserId:
        row.responsibleUserId === null ? null : Number(row.responsibleUserId),
      events: eventsPerLead.get(beraterLid) ?? new Map(),
    };
    const arr = result.get(baseLid);
    if (arr) arr.push(beraterLead);
    else result.set(baseLid, [beraterLead]);
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Utils
// ──────────────────────────────────────────────────────────────────────────

export function buildLanguageBreakdown(bucket: AggBucket): {
  a2: { count: number; pct: number | null };
  b1: { count: number; pct: number | null };
  b2: { count: number; pct: number | null };
  c1: { count: number; pct: number | null };
  unknown: { count: number; pct: number | null };
} {
  const total = bucket.base;
  const cell = (count: number) => ({
    count,
    pct: total > 0 ? (count / total) * 100 : null,
  });
  return {
    a2: cell(bucket.langA2),
    b1: cell(bucket.langB1),
    b2: cell(bucket.langB2),
    c1: cell(bucket.langC1),
    unknown: cell(bucket.langUnknown),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// SQL + helper: история CFV 879824 для точного disqualified_at
// ──────────────────────────────────────────────────────────────────────────

export interface CloseReasonEvent {
  eventAt: Date;
  enumIdAfter: number | null;
}

/** Fetches close_reason history per lead, sorted by event_at ASC. */
export async function fetchCloseReasonHistory(
  leadIds: number[]
): Promise<Map<number, CloseReasonEvent[]>> {
  const idsIn = leadIds.join(",");
  const rows = await analyticsDb.execute(sql`
    SELECT
      lead_id        AS "leadId",
      event_at       AS "eventAt",
      enum_id_after  AS "enumIdAfter"
    FROM analytics.lead_close_reason_changes
    WHERE lead_id IN (${sql.raw(idsIn)})
    ORDER BY lead_id, event_at ASC, event_id ASC
  `);
  const data = unwrapRows<{
    leadId: string | number;
    eventAt: string | Date;
    enumIdAfter: string | number | null;
  }>(rows);
  const m = new Map<number, CloseReasonEvent[]>();
  for (const r of data) {
    const lid = Number(r.leadId);
    const arr = m.get(lid) ?? [];
    arr.push({
      eventAt: r.eventAt instanceof Date ? r.eventAt : new Date(r.eventAt),
      enumIdAfter: r.enumIdAfter === null ? null : Number(r.enumIdAfter),
    });
    m.set(lid, arr);
  }
  return m;
}

/**
 * Реплицирует cohort-conversion's `_current_disqualification_started_at`:
 * проходим события сортированно, отслеживаем "когда началась текущая
 * непрерывная серия дисквала". Если последний переход — в non-NEQVAL, серия
 * сбрасывается. Возвращаем дату начала ТЕКУЩЕЙ дисквал-серии (или null).
 */
function historicalDisqualifiedSince(
  events: CloseReasonEvent[] | undefined
): Date | null {
  if (!events || events.length === 0) return null;
  let disqualifiedSince: Date | null = null;
  for (const ev of events) {
    if (ev.enumIdAfter !== null && NEQVAL_ENUM_IDS.has(ev.enumIdAfter)) {
      if (disqualifiedSince === null) disqualifiedSince = ev.eventAt;
    } else {
      disqualifiedSince = null;
    }
  }
  return disqualifiedSince;
}

/**
 * Обогащает lead'у точной датой дисквала (если есть в истории CFV).
 * Логика cohort-conversion qualification.py:
 *   - есть исторический event → disqualified_at = историческая дата (exact)
 *   - иначе если currently disqualified → updated_at (приближение)
 *   - иначе → null
 */
export function enrichDisqualifiedAt(
  lead: BaseLead,
  events: CloseReasonEvent[] | undefined
): BaseLead {
  if (!lead.isDisqualified) {
    // Не дисквалифицирован сейчас — может быть исторически был, но потом
    // снят. Cohort-conversion в таком случае ставит disqualified_at = None.
    return { ...lead, disqualifiedAt: null };
  }
  const historical = historicalDisqualifiedSince(events);
  if (historical !== null) {
    return { ...lead, disqualifiedAt: historical };
  }
  // Истории нет — остаётся snapshot-приближение через updated_at.
  return lead;
}

export function unwrapRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const r = (result as { rows: unknown }).rows;
    if (Array.isArray(r)) return r as T[];
  }
  return [];
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
