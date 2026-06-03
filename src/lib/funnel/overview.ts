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
import { B2G_PIPELINES, BERATER_STATUSES } from "@/lib/kommo/pipeline-config";
import { computeClients } from "./clients";
import { todayBerlinUTC } from "./cohort-math";
import {
  enrichDisqualifiedAt,
  fetchBeraterContext,
  fetchCloseReasonHistory,
  fetchQualifiedBaseLeads,
  fetchTargetEvents,
  processLeadForConversion,
  unwrapRows,
  type BaseLead,
  type BeraterLead,
  type CloseReasonEvent,
  type ComputeOpts,
} from "./compute";
import type {
  OverviewFunnelStage,
  OverviewResponse,
} from "./api-types";

const BUH_GOS = B2G_PIPELINES.FIRST_LINE; // 10935879
const CONSULT_DC_DONE = BERATER_STATUSES.CONSULT_BEFORE_DC_DONE; // 102183939
const CONSULT_AA_DONE = BERATER_STATUSES.CONSULT_BEFORE_AA_DONE; // 102183947
const FRESH_CALL_DAYS = 7;
const CLOSED_STATUSES = new Set([142, 143]); // won/termin + lost

// Wire-типы (OverviewKpi / OverviewFunnelStage / OverviewResponse) — в api-types.ts
// (client-safe), чтобы их могли импортить и фронтовые компоненты.

// ── Стадии (в порядке пути клиента) ─────────────────────────────────────────

const STAGE_DEFS = [
  { key: "new", label: "Новый лид" },
  { key: "qual", label: "Квал лид" },
  { key: "docs", label: "Документы в ДЦ" },
  { key: "term_dc", label: "Термин ДЦ" },
  { key: "consult_dc", label: "Конс. перед ДЦ" },
  { key: "consult_aa", label: "Конс. перед АА" },
  { key: "gutschein", label: "Гутшайн" },
] as const;

type StageKey = (typeof STAGE_DEFS)[number]["key"];

/** Достижение этапов + дата каждого этапа (для среднего времени перехода). */
interface LeadStages {
  reached: Record<StageKey, boolean>;
  /** Дата достижения этапа (null если только инференс / неизвестна). */
  at: Record<StageKey, Date | null>;
}

export async function computeOverview(
  opts: ComputeOpts
): Promise<OverviewResponse> {
  // 1. База квал-лидов Бух Гос (как у когорт: уважает period/source/responsible).
  //    Обрабатываем ВСЕ (включая дисквал) — вехи воронки считаем тем же
  //    drill-правилом, что карточки, поэтому их числа совпадают.
  // Квал-база + Hot/Warm/Cold (по предстоящим терминам) — независимы, в параллель.
  const [baseLeadsRaw, hotWarmCold] = await Promise.all([
    fetchQualifiedBaseLeads(opts),
    computeUpcomingReadiness(),
  ]);
  const leadIds = baseLeadsRaw.map((l) => l.leadId);

  // 2. Параллельно: «Новый лид» + история CFV 879824 + события Гос + Бератер.
  const [newLeadCount, closeReasonHistory, targetEvents, beraterContext] =
    await Promise.all([
      fetchNewLeadCount(opts),
      leadIds.length
        ? fetchCloseReasonHistory(leadIds)
        : Promise.resolve(new Map<number, CloseReasonEvent[]>()),
      leadIds.length ? fetchTargetEvents(leadIds) : Promise.resolve(new Map<string, Date>()),
      leadIds.length ? fetchBeraterContext(leadIds) : Promise.resolve(new Map<number, BeraterLead[]>()),
    ]);

  // Точная дата дисквала из истории (как в computeCohorts) → вехи 1-в-1 с карточками.
  const baseLeads = baseLeadsRaw.map((lead) =>
    enrichDisqualifiedAt(lead, closeReasonHistory.get(lead.leadId))
  );

  // 3. По каждому лиду — достигнутые этапы (накопительно) + даты.
  const stages = baseLeads.map((lead) =>
    computeLeadStages(lead, targetEvents, beraterContext)
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
  const funnel = buildFunnel(newLeadCount, qualCount, stages);

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
async function computeUpcomingReadiness(): Promise<{
  hot: number;
  warm: number;
  cold: number;
}> {
  const today = todayBerlinUTC();
  const end = new Date(today);
  end.setUTCDate(today.getUTCDate() + 90);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const res = await computeClients({ terminFrom: fmt(today), terminTo: fmt(end) });
  // Активные клиенты, которых ещё «готовим» (выигравшие гутшайн — не здесь).
  return res.active.categories;
}

// ── Достижение этапов одним лидом ───────────────────────────────────────────

function computeLeadStages(
  lead: BaseLead,
  targetEvents: Map<string, Date>,
  beraterContext: Map<number, BeraterLead[]>
): LeadStages {
  const berater = beraterContext.get(lead.leadId) ?? [];

  // Главные вехи — то же drill-правило, что в lead-list/карточках: цель засчитана,
  // если достигнута ДО дисквала (или лид не дисквалифицирован). Поэтому счётчики
  //   Документы = C1 target, Термин ДЦ = C2 target, Гутшайн = C5 target
  // СОВПАДАЮТ с суммами target карточек/таблицы.
  const c1 = processLeadForConversion("C1", lead, targetEvents, beraterContext);
  const c2 = processLeadForConversion("C2", lead, targetEvents, beraterContext);
  const c5 = processLeadForConversion("C5", lead, targetEvents, beraterContext);
  const targetCounts = (r: { included: boolean; targetAt: Date | null }) =>
    r.included &&
    r.targetAt !== null &&
    (lead.disqualifiedAt === null || r.targetAt <= lead.disqualifiedAt);

  const docsAt = c1.targetAt;
  const termDcAt = c2.targetAt;
  const gutscheinAt = c5.targetAt;
  const docs = targetCounts(c1);
  const term_dc = targetCounts(c2);
  const gutschein = targetCounts(c5);

  // Берётер-консультации (сырые даты «проведена») — вспомогательные этапы МЕЖДУ
  // C2 и C5: Термин ДЦ (Гос-142, «назначен») по времени идёт ДО них. Зажимаем
  // между соседями (`&& term_dc`, `&& consult_dc`) + гутшайн-инференс →
  // монотонность docs ⊇ term_dc ⊇ consult_dc ⊇ consult_aa ⊇ gutschein.
  const consultDcAt = earliestBeraterEvent(berater, CONSULT_DC_DONE);
  const consultAaAt = earliestBeraterEvent(berater, CONSULT_AA_DONE);
  const consultAa0 = consultAaAt !== null || gutschein;
  const consultDc0 = consultDcAt !== null || consultAa0;
  const consult_dc = consultDc0 && term_dc;
  const consult_aa = consultAa0 && consult_dc;

  return {
    reached: { new: true, qual: true, docs, term_dc, consult_dc, consult_aa, gutschein },
    at: {
      new: lead.anchorAt,
      qual: lead.anchorAt, // anchor = created_at (упрощение, как у когорт)
      docs: docsAt,
      term_dc: termDcAt,
      consult_dc: consultDcAt,
      consult_aa: consultAaAt,
      gutschein: gutscheinAt,
    },
  };
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

// ── Сборка воронки ──────────────────────────────────────────────────────────

function buildFunnel(
  newLeadCount: number,
  qualCount: number,
  stages: LeadStages[]
): OverviewFunnelStage[] {
  // Счётчики достигнутых этапов среди квал-лидов.
  const counts: Record<StageKey, number> = {
    new: newLeadCount,
    qual: qualCount,
    docs: 0,
    consult_dc: 0,
    term_dc: 0,
    consult_aa: 0,
    gutschein: 0,
  };
  for (const s of stages) {
    if (s.reached.docs) counts.docs += 1;
    if (s.reached.consult_dc) counts.consult_dc += 1;
    if (s.reached.term_dc) counts.term_dc += 1;
    if (s.reached.consult_aa) counts.consult_aa += 1;
    if (s.reached.gutschein) counts.gutschein += 1;
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

// ── SQL: «Новый лид» — все Гос-лиды за период (top воронки) ──────────────────

async function fetchNewLeadCount(opts: ComputeOpts): Promise<number> {
  const rows = await analyticsDb.execute(sql`
    SELECT COUNT(*) AS n
    FROM analytics.leads_cohort
    WHERE pipeline_id = ${BUH_GOS}
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
