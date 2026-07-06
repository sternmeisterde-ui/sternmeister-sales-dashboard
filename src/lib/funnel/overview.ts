/**
 * Обзорный слой Воронки (надстройка над cohort-conversion):
 *   • KPI-полоска (ТЗ §9.1)
 *   • Объединённая накопительная воронка «Новый лид → Гутшайн» (ТЗ §9.2)
 *
 * Это НЕ по-недельные когорты, а одна сводка за выбранный период. Переиспользует
 * расчёт из compute.ts (fetchQualifiedBaseLeads / fetchBeraterContext /
 * processLeadForConversion), поэтому стадии воронки согласованы с C1–C5.
 *
 * Определения (согласованы с заказчиком 2026-06-03):
 *  • Активный клиент = лид НЕ в статусе Закрыто(143)/Гутшайн-или-ТерминДЦ(142),
 *    считаем по обеим воронкам (Гос ИЛИ линкованный Бератер активен).
 *  • «Без свежего звонка» = нет звонка (call_in/out) за последние 7 дней.
 *  • Воронка — накопительная («дошёл до этапа», с инференсом для монотонности).
 *  • «Консультации» — два этапа: перед ДЦ (102183939 проведена) и перед АА (102183947).
 *  • Hot/Warm/Cold — заглушка до скоринга §8.
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import {
  BERATER_STATUSES,
  getBeraterStatusSets,
  getFirstLineStatusSets,
  type Vertical,
} from "@/lib/kommo/pipeline-config";
import { computeClients } from "./clients";
import { todayBerlinUTC } from "./cohort-math";
import {
  enrichDisqualifiedAt,
  fetchBeraterContext,
  fetchCloseReasonHistory,
  fetchQualifiedBaseLeads,
  fetchTargetEvents,
  getVerticalScope,
  languageBucketSql,
  managerAttributionSql,
  processLeadForConversion,
  unwrapRows,
  type BaseLead,
  type BeraterLead,
  type CloseReasonEvent,
  type ComputeOpts,
  type VerticalScope,
} from "./compute";
import type {
  OverviewFunnelStage,
  OverviewResponse,
} from "./api-types";

const FRESH_CALL_DAYS = 7;
const CLOSED_STATUSES = new Set([142, 143]); // won/termin + lost

// Wire-типы (OverviewKpi / OverviewFunnelStage / OverviewResponse) — в api-types.ts
// (client-safe), чтобы их могли импортить и фронтовые компоненты.

// ── Стадии (в порядке пути клиента) ─────────────────────────────────────────
// Полная лестница по запросу РОПа (2026-07-06): ВСЕ прогрессионные этапы обеих
// Kommo-воронок в их порядке. Служебные состояния (Неразобранное, База,
// Недозвон, отмены терминов, Отложенный старт, Апелляция, Закрыто) — не
// ступени пути и в накопительную воронку не входят.

const STAGE_DEFS = [
  { key: "new", label: "Новый лид" },
  { key: "qual", label: "Квал лид" },
  // ── Бух Гос ──
  { key: "in_progress", label: "Взято в работу" },
  { key: "contact", label: "Контакт установлен" },
  { key: "decision", label: "Принимает решение" },
  { key: "consult_gos", label: "Консультация проведена" },
  { key: "docs", label: "Документы в ДЦ" },
  { key: "term_dc", label: "Термин ДЦ" },
  // ── Бух Бератер ──
  { key: "received", label: "Принято от 1-й линии" },
  { key: "dovedenie", label: "Доведение" },
  { key: "consult_dc", label: "Конс. перед ДЦ" },
  { key: "consult_dc_done", label: "Конс. перед ДЦ проведена" },
  { key: "term_dc_done", label: "Термин ДЦ состоялся" },
  { key: "consult_aa", label: "Конс. перед АА" },
  { key: "consult_aa_done", label: "Конс. перед АА проведена" },
  { key: "term_aa", label: "Термин АА" },
  { key: "berater_review", label: "На рассмотрении бератера" },
  { key: "gutschein", label: "Гутшайн" },
] as const;

type StageKey = (typeof STAGE_DEFS)[number]["key"];

// Цепочка после «Квал лид» (для инференса глубины): порядок = STAGE_DEFS без
// new/qual. Достижение более глубокой ступени помечает все предыдущие.
const CHAIN_KEYS = STAGE_DEFS.slice(2).map((d) => d.key) as StageKey[];

// Гос- и Бератер-этапы лестницы: ступень → статусы-свидетельства выбранной
// вертикали (бух / мед / union). Вычисляется на запрос (vertical-aware).
interface StageStatusSets {
  gos: ReadonlyArray<[StageKey, readonly number[]]>;
  berater: ReadonlyArray<[StageKey, readonly number[]]>;
}

function getStageStatusSets(vertical?: Vertical): StageStatusSets {
  const fl = getFirstLineStatusSets(vertical);
  const br = getBeraterStatusSets(vertical);
  return {
    gos: [
      ["in_progress", [...fl.inProgress]],
      ["contact", [...fl.contactMade]],
      ["decision", [...fl.decisionMaking]],
      ["consult_gos", [...fl.consultDone]],
    ],
    berater: [
      ["received", [...br.receivedFromFirst]],
      ["dovedenie", [...br.dovedenie]],
      ["consult_dc", [...br.consultBeforeDC]],
      ["consult_dc_done", [...br.consultBeforeDCDone]],
      ["term_dc_done", [...br.termDCDone]],
      ["consult_aa", [...br.consultBeforeAA]],
      ["consult_aa_done", [...br.consultBeforeAADone]],
      // «Термин АА» — стадия убрана из бух-воронки ~2026-03 (history-only), у мед
      // её не было никогда: кластер = исторический on-stage (бух) + отменён/перенесён.
      ["term_aa", [
        ...br.termAACancelled,
        ...(vertical === "med" ? [] : [BERATER_STATUSES.TERM_AA]),
      ]],
      ["berater_review", [...br.beraterReview]],
    ],
  };
}

/** Достижение этапов + дата каждого этапа (для среднего времени перехода). */
interface LeadStages {
  reached: Record<StageKey, boolean>;
  /** Дата достижения этапа (null если только инференс / неизвестна). */
  at: Record<StageKey, Date | null>;
}

export async function computeOverview(
  opts: ComputeOpts
): Promise<OverviewResponse> {
  const scope = getVerticalScope(opts.vertical);
  const stageSets = getStageStatusSets(opts.vertical);
  // 1. База квал-лидов первой линии (как у когорт: уважает period/source/responsible).
  //    Обрабатываем ВСЕ (включая дисквал) — вехи воронки считаем тем же
  //    drill-правилом, что карточки, поэтому их числа совпадают.
  // Квал-база + Hot/Warm/Cold (по предстоящим терминам) — независимы, в параллель.
  const [baseLeadsRaw, hotWarmCold] = await Promise.all([
    fetchQualifiedBaseLeads(opts),
    computeUpcomingReadiness(opts.lang ?? null, opts.vertical),
  ]);
  const leadIds = baseLeadsRaw.map((l) => l.leadId);

  // 2. Параллельно: «Новый лид» + история CFV 879824 + события Гос + Бератер
  //    + события промежуточных Гос-этапов (полная лестница воронки).
  const [newLeadCount, closeReasonHistory, targetEvents, beraterContext, extraGosEvents] =
    await Promise.all([
      fetchNewLeadCount(opts, scope.firstLineIds),
      leadIds.length
        ? fetchCloseReasonHistory(leadIds)
        : Promise.resolve(new Map<number, CloseReasonEvent[]>()),
      leadIds.length ? fetchTargetEvents(leadIds, scope) : Promise.resolve(new Map<string, Date>()),
      leadIds.length ? fetchBeraterContext(leadIds, scope) : Promise.resolve(new Map<number, BeraterLead[]>()),
      leadIds.length ? fetchExtraGosEvents(leadIds, scope.firstLineIds, stageSets) : Promise.resolve(new Map<string, Date>()),
    ]);

  // Точная дата дисквала из истории (как в computeCohorts) → вехи 1-в-1 с карточками.
  const baseLeads = baseLeadsRaw.map((lead) =>
    enrichDisqualifiedAt(lead, closeReasonHistory.get(lead.leadId))
  );

  // 3. По каждому лиду — достигнутые этапы (накопительно) + даты.
  const stages = baseLeads.map((lead) =>
    computeLeadStages(lead, targetEvents, beraterContext, extraGosEvents, stageSets, scope)
  );

  // 4. Квал лид = база минус дисквал (= «Лиды» в когортах, displayLeadCount).
  const qualCount = baseLeads.filter((l) => !l.isDisqualified).length;

  // 5. Активность клиента (не закрыт, только НЕ дисквал) + срок квал→Гутшайн.
  let activeCount = 0;
  const gutscheinDurationsDays: number[] = [];

  baseLeads.forEach((lead, i) => {
    if (stages[i].reached.gutschein) {
      const gutAt = stages[i].at.gutschein;
      if (gutAt) {
        const days = (gutAt.getTime() - lead.anchorAt.getTime()) / 86_400_000;
        if (days >= 0) gutscheinDurationsDays.push(days);
      }
    }
    if (lead.isDisqualified) return; // дисквал — не «активный клиент»
    const berater = beraterContext.get(lead.leadId) ?? [];
    const gosActive = !CLOSED_STATUSES.has(lead.currentStatusId);
    const beraterActive = berater.some(
      (b) => !CLOSED_STATUSES.has(b.currentStatusId)
    );
    if (gosActive || beraterActive) activeCount += 1;
  });

  // 6. «Без свежего звонка»: среди активных — у кого нет звонка за 7 дней.
  const noFreshCallCount = await countNoFreshCall(baseLeads, beraterContext);

  // 7. Сборка воронки: count[stage] + % перехода + среднее время.
  // Этапы цепочки считаем ТОЛЬКО по недисквалифицированным лидам — иначе
  // ранние этапы (Взято в работу и т.п.) превышают «Квал лид» (>100%),
  // т.к. дисквал исключён из квал-счёта, но его этапы до дисквала засчитаны.
  // ⚠ Поэтому Документы/Термин ДЦ/Гутшайн здесь могут быть чуть МЕНЬШЕ сумм
  // target в карточках C1/C2/C5 (карточки считают цели, достигнутые до
  // дисквала, и у ныне-дисквалифицированных лидов).
  const chainStages = stages.filter((_, i) => !baseLeads[i].isDisqualified);
  const funnel = buildFunnel(newLeadCount, qualCount, chainStages);

  // C5 KPI = Гутшайн / Квал (последний / второй этап воронки).
  const qualStage = funnel.find((s) => s.key === "qual")?.count ?? 0;
  const gutStage = funnel.find((s) => s.key === "gutschein")?.count ?? 0;
  const c5Pct = qualStage > 0 ? (gutStage / qualStage) * 100 : null;

  const avgDaysQualToGutschein =
    gutscheinDurationsDays.length > 0
      ? gutscheinDurationsDays.reduce((a, b) => a + b, 0) /
        gutscheinDurationsDays.length
      : null;

  return {
    kpi: {
      c5Pct,
      activeClients: activeCount,
      hotWarmCold, // разбивка клиентов с предстоящим термином (сегодня → +90 дн)
      avgDaysQualToGutschein,
      noFreshCallCount,
      freshCallThresholdDays: FRESH_CALL_DAYS,
    },
    funnel,
  };
}

// ── Hot/Warm/Cold: клиенты с предстоящим термином (сегодня → +90 дн) ─────────
// Готовность — про будущее, поэтому популяция НЕ зависит от фильтра периода
// воронки (он про дату создания). Реиспользуем computeClients + score.ts.
async function computeUpcomingReadiness(
  lang: ComputeOpts["lang"],
  vertical?: Vertical
): Promise<{
  hot: number;
  warm: number;
  cold: number;
}> {
  // Все активные клиенты с ПРЕДСТОЯЩИМ термином (termin_date/aa_termin_date ≥
  // сегодня), без верхней границы. terminTo=null → «с сегодня и дальше».
  const today = todayBerlinUTC();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const res = await computeClients({ terminFrom: fmt(today), terminTo: null, lang, vertical });
  // Активные клиенты, которых ещё «готовим» (выигравшие гутшайн — не здесь).
  return res.active.categories;
}

// ── Достижение этапов одним лидом ───────────────────────────────────────────

function computeLeadStages(
  lead: BaseLead,
  targetEvents: Map<string, Date>,
  beraterContext: Map<number, BeraterLead[]>,
  extraGosEvents: Map<string, Date>,
  stageSets: StageStatusSets,
  scope: VerticalScope
): LeadStages {
  const berater = beraterContext.get(lead.leadId) ?? [];

  const reached = Object.fromEntries(
    STAGE_DEFS.map((d) => [d.key, false])
  ) as Record<StageKey, boolean>;
  const at = Object.fromEntries(
    STAGE_DEFS.map((d) => [d.key, null])
  ) as Record<StageKey, Date | null>;

  reached.new = true;
  reached.qual = true;
  at.new = lead.anchorAt;
  at.qual = lead.anchorAt; // anchor = created_at (упрощение, как у когорт)

  // Главные вехи — то же drill-правило, что в lead-list/карточках: цель засчитана,
  // если достигнута ДО дисквала (или лид не дисквалифицирован). Поэтому счётчики
  //   Документы = C1 target, Термин ДЦ = C2 target, Гутшайн = C5 target
  // СОВПАДАЮТ с суммами target карточек/таблицы.
  const c1 = processLeadForConversion("C1", lead, targetEvents, beraterContext, scope);
  const c2 = processLeadForConversion("C2", lead, targetEvents, beraterContext, scope);
  const c5 = processLeadForConversion("C5", lead, targetEvents, beraterContext, scope);
  const targetCounts = (r: { included: boolean; targetAt: Date | null }) =>
    r.included &&
    r.targetAt !== null &&
    (lead.disqualifiedAt === null || r.targetAt <= lead.disqualifiedAt);

  reached.docs = targetCounts(c1);
  at.docs = c1.targetAt;
  reached.term_dc = targetCounts(c2);
  at.term_dc = c2.targetAt;
  reached.gutschein = targetCounts(c5);
  at.gutschein = c5.targetAt;

  // Промежуточные Гос-этапы: событие ≥ anchor (и до дисквала) ИЛИ snapshot
  // текущего статуса (дата неизвестна → в средние переходов не попадает).
  for (const [key, statusIds] of stageSets.gos) {
    let ev: Date | undefined;
    for (const statusId of statusIds) {
      const e = extraGosEvents.get(`${lead.leadId}|${statusId}`);
      if (e !== undefined && (ev === undefined || e < ev)) ev = e;
    }
    if (
      ev !== undefined &&
      ev.getTime() >= lead.anchorAt.getTime() &&
      (lead.disqualifiedAt === null || ev <= lead.disqualifiedAt)
    ) {
      reached[key] = true;
      at[key] = ev;
    } else if (statusIds.includes(lead.currentStatusId) && !lead.isDisqualified) {
      reached[key] = true;
    }
  }

  // Бератер-этапы: самое раннее событие (до дисквала) ИЛИ текущий статус
  // линкованного Бератер-лида (snapshot, дата неизвестна).
  for (const [key, statusIds] of stageSets.berater) {
    const ev = earliestBeraterEventAny(berater, statusIds);
    if (
      ev !== null &&
      (lead.disqualifiedAt === null || ev <= lead.disqualifiedAt)
    ) {
      reached[key] = true;
      at[key] = ev;
    } else if (
      !lead.isDisqualified &&
      berater.some((bl) => statusIds.includes(bl.currentStatusId))
    ) {
      reached[key] = true;
    }
  }

  // «Принято от 1-й линии» — доп. свидетельство: автопереход из «Термин ДЦ»
  // СОЗДАЁТ Бератер-сделку сразу в этом статусе, а событие смены статуса при
  // создании Kommo не пишет. Если клиент дальше ушёл в служебный статус
  // (Термин ДЦ отменён / Отложенный старт / Закрыто — не ступени лестницы),
  // событий по ступеням не остаётся вовсе и «Принято» терялось (аудит
  // 2026-07-06: 1375 засчитанных при 1588 реально линкованных). Факт создания
  // линкованной Бератер-сделки ПОСЛЕ anchor = принятие; дата = created_at.
  for (const bl of berater) {
    if (bl.createdAt.getTime() < lead.anchorAt.getTime()) continue; // сделка прошлого цикла
    if (lead.disqualifiedAt !== null && bl.createdAt > lead.disqualifiedAt) continue;
    if (!reached.received || (at.received !== null && bl.createdAt < at.received)) {
      reached.received = true;
      if (at.received === null || bl.createdAt < at.received) at.received = bl.createdAt;
    }
  }

  // Инференс глубины: воронка кумулятивная («дошёл до этапа»), статусы
  // логируются неравномерно — достижение более глубокой ступени помечает все
  // предыдущие. Монотонность гарантирована по построению.
  let depth = -1;
  CHAIN_KEYS.forEach((key, i) => {
    if (reached[key]) depth = i;
  });
  for (let i = 0; i < depth; i++) reached[CHAIN_KEYS[i]] = true;

  return { reached, at };
}

function earliestBeraterEvent(
  beraterLeads: BeraterLead[],
  statusId: number
): Date | null {
  let min: Date | null = null;
  for (const bl of beraterLeads) {
    const ev = bl.events.get(statusId);
    if (ev !== undefined && (min === null || ev < min)) min = ev;
  }
  return min;
}

/** Самое раннее событие среди НЕСКОЛЬКИХ статусов (кластер вехи). */
function earliestBeraterEventAny(
  beraterLeads: BeraterLead[],
  statusIds: readonly number[]
): Date | null {
  let min: Date | null = null;
  for (const sid of statusIds) {
    const ev = earliestBeraterEvent(beraterLeads, sid);
    if (ev !== null && (min === null || ev < min)) min = ev;
  }
  return min;
}

// ── Сборка воронки ──────────────────────────────────────────────────────────

function buildFunnel(
  newLeadCount: number,
  qualCount: number,
  stages: LeadStages[]
): OverviewFunnelStage[] {
  // Счётчики достигнутых этапов среди квал-лидов.
  const counts = Object.fromEntries(
    STAGE_DEFS.map((d) => [d.key, 0])
  ) as Record<StageKey, number>;
  counts.new = newLeadCount;
  counts.qual = qualCount;
  for (const s of stages) {
    for (const key of CHAIN_KEYS) {
      if (s.reached[key]) counts[key] += 1;
    }
  }

  return STAGE_DEFS.map((def, idx) => {
    const prev = idx > 0 ? STAGE_DEFS[idx - 1] : null;
    const count = counts[def.key];
    const prevCount = prev ? counts[prev.key] : null;
    const transitionPctFromPrev =
      prevCount && prevCount > 0 ? (count / prevCount) * 100 : null;

    // Среднее время перехода: по лидам, достигшим текущего этапа, у которых
    // известны даты обоих этапов. Для «Новый→Квал» времени нет (anchor=created).
    let avgDaysFromPrev: number | null = null;
    if (prev && prev.key !== "new") {
      const diffs: number[] = [];
      for (const s of stages) {
        if (!s.reached[def.key]) continue;
        const a = s.at[prev.key];
        const b = s.at[def.key];
        if (a && b) {
          const d = (b.getTime() - a.getTime()) / 86_400_000;
          if (d >= 0) diffs.push(d);
        }
      }
      if (diffs.length > 0) {
        avgDaysFromPrev = diffs.reduce((x, y) => x + y, 0) / diffs.length;
      }
    }

    return {
      key: def.key,
      label: def.label,
      count,
      transitionPctFromPrev,
      avgDaysFromPrev,
    };
  });
}

// ── SQL: события промежуточных Гос-этапов (полная лестница воронки) ──────────
// fetchTargetEvents тянет только C1/C2-цели; здесь добираем «Взято в работу» /
// «Контакт установлен» / «Принимает решение» / «Консультация проведена».
// Ключ карты: `${leadId}|${statusId}` → earliest event_at.

async function fetchExtraGosEvents(
  leadIds: number[],
  firstLineIds: number[],
  stageSets: StageStatusSets
): Promise<Map<string, Date>> {
  const statusIds = stageSets.gos.flatMap(([, ids]) => ids);
  const rows = await analyticsDb.execute(sql`
    SELECT lead_id AS "leadId", status_id AS "statusId", MIN(event_at) AS "eventAt"
    FROM analytics.lead_status_changes
    WHERE lead_id IN (${sql.raw(leadIds.join(","))})
      AND pipeline_id IN (${sql.raw(firstLineIds.join(","))})
      AND status_id IN (${sql.raw(statusIds.join(","))})
    GROUP BY lead_id, status_id
  `);
  const m = new Map<string, Date>();
  for (const r of unwrapRows<{
    leadId: string | number;
    statusId: string | number;
    eventAt: string | Date;
  }>(rows)) {
    m.set(
      `${Number(r.leadId)}|${Number(r.statusId)}`,
      r.eventAt instanceof Date ? r.eventAt : new Date(r.eventAt)
    );
  }
  return m;
}

// ── SQL: «Новый лид» — все Гос-лиды за период (top воронки) ──────────────────

async function fetchNewLeadCount(opts: ComputeOpts, firstLineIds: number[]): Promise<number> {
  const scope = getVerticalScope(opts.vertical);
  const rows = await analyticsDb.execute(sql`
    SELECT COUNT(*) AS n
    FROM analytics.leads_cohort
    WHERE pipeline_id IN (${sql.raw(firstLineIds.join(","))})
      AND exclude_from_analytics = FALSE
      AND is_deleted = FALSE
      AND created_at >= ${opts.from.toISOString()}
      AND created_at <  ${opts.to.toISOString()}
      ${opts.source ? sql`AND utm_source = ${opts.source}` : sql``}
      ${managerAttributionSql(opts.responsibleUserId, scope.beraterIds)}
      ${languageBucketSql(opts.lang)}
  `);
  const data = unwrapRows<{ n: string | number }>(rows);
  return data.length ? Number(data[0].n) : 0;
}

// ── «Без свежего звонка»: активные клиенты без звонка за FRESH_CALL_DAYS ──────

async function countNoFreshCall(
  baseLeads: BaseLead[],
  beraterContext: Map<number, BeraterLead[]>
): Promise<number> {
  // Активные клиенты (не дисквал, Гос или Бератер не закрыты) + все их lead_id.
  const activeClients: { gosLeadId: number; allLeadIds: number[] }[] = [];
  for (const lead of baseLeads) {
    if (lead.isDisqualified) continue;
    const berater = beraterContext.get(lead.leadId) ?? [];
    const gosActive = !CLOSED_STATUSES.has(lead.currentStatusId);
    const beraterActive = berater.some((b) => !CLOSED_STATUSES.has(b.currentStatusId));
    if (gosActive || beraterActive) {
      activeClients.push({
        gosLeadId: lead.leadId,
        allLeadIds: [lead.leadId, ...berater.map((b) => b.leadId)],
      });
    }
  }
  if (activeClients.length === 0) return 0;

  // Последний звонок по каждому lead_id из communications.
  const allIds = Array.from(new Set(activeClients.flatMap((c) => c.allLeadIds)));
  const rows = await analyticsDb.execute(sql`
    SELECT lead_id AS "leadId", MAX(created_at) AS "lastCall"
    FROM analytics.communications
    WHERE lead_id IN (${sql.raw(allIds.join(","))})
      AND communication_type IN ('call_out', 'call_in')
    GROUP BY lead_id
  `);
  const lastCallByLead = new Map<number, Date>();
  for (const r of unwrapRows<{ leadId: string | number; lastCall: string | Date }>(rows)) {
    lastCallByLead.set(
      Number(r.leadId),
      r.lastCall instanceof Date ? r.lastCall : new Date(r.lastCall)
    );
  }

  const cutoff = Date.now() - FRESH_CALL_DAYS * 86_400_000;
  let noFresh = 0;
  for (const client of activeClients) {
    const fresh = client.allLeadIds.some((id) => {
      const last = lastCallByLead.get(id);
      return last !== undefined && last.getTime() >= cutoff;
    });
    if (!fresh) noFresh += 1;
  }
  return noFresh;
}
