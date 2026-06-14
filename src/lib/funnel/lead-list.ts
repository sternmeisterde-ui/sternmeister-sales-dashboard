/**
 * Drill-down: список лидов конкретной (конверсия, неделя) с метрикой base|target.
 * Используется endpoint-ом /api/funnel/cohorts/{conversionId}/{weekStart}/leads.
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import {
  classifyDcToAa,
  excludesIgnor,
  fetchBeraterContext,
  fetchQualifiedBaseLeads,
  fetchTargetEvents,
  processLeadForConversion,
  unwrapRows,
  type ComputeOpts,
} from "./compute";
import { isoWeekStartBerlin } from "./cohort-math";
import type { ConversionId } from "./types";

const KOMMO_BASE = "https://sternmeister.kommo.com/leads/detail";

export interface DrillLead {
  leadId: number;
  /** Имя клиента (из contacts) или fallback. */
  name: string;
  kommoUrl: string;
  /** Текущий статус Гос-лида (для подсказки в попапе). */
  currentStatus: string | null;
}

export interface DrillResponse {
  conversionId: ConversionId;
  weekStartIso: string;
  metric: "base" | "target";
  count: number;
  leads: DrillLead[];
}

interface ListOpts extends ComputeOpts {
  conversionId: ConversionId;
  weekStartIso: string;
  metric: "base" | "target";
  /** Сколько максимум вернуть (default 25). Остальные — в `count`. */
  limit?: number;
}

export async function computeCohortLeads(
  opts: ListOpts
): Promise<DrillResponse> {
  // Запрошенная неделя = UTC-полночь её ISO-понедельника (как weekStartIso,
  // приходящий из computeCohorts: isoDate(isoWeekStartBerlin(...))).
  const weekStart = new Date(`${opts.weekStartIso}T00:00:00Z`);
  if (Number.isNaN(weekStart.getTime())) {
    throw new Error(`invalid weekStartIso: ${opts.weekStartIso}`);
  }
  const requestedMondayMs = weekStart.getTime();

  // Узкое окно для SQL (perf): ISO-неделя ±1 день — Berlin-неделя сдвинута
  // относительно UTC на 1-2ч, точную принадлежность проверяем ниже через
  // isoWeekStartBerlin. КРИТИЧНО зажимаем окно в пользовательский [from, to]:
  // computeCohorts считает только лиды внутри фильтра, поэтому последняя
  // (текущая) неделя обрезается по `to`. Без зажатия drill тянул полную неделю
  // (включая «сегодняшние» лиды) и показывал БОЛЬШЕ, чем таблица.
  const weekLo = new Date(weekStart);
  weekLo.setUTCDate(weekStart.getUTCDate() - 1);
  const weekHi = new Date(weekStart);
  weekHi.setUTCDate(weekStart.getUTCDate() + 8);
  const lo = weekLo > opts.from ? weekLo : opts.from; // max(weekLo, from)
  const hi = weekHi < opts.to ? weekHi : opts.to; // min(weekHi, to)
  const narrowedOpts = { ...opts, from: lo, to: hi };

  const fetched = await fetchQualifiedBaseLeads(narrowedOpts);
  // Точная принадлежность к запрошенной Berlin ISO-неделе — как группировка в
  // computeCohorts; отсекает «соседние» недели, попавшие в окно ±1 день.
  const baseLeads = fetched.filter(
    (l) => isoWeekStartBerlin(l.anchorAt).getTime() === requestedMondayMs
  );

  const leadIds = baseLeads.map((l) => l.leadId);
  const targetEvents = leadIds.length
    ? await fetchTargetEvents(leadIds)
    : new Map<string, Date>();
  // Бератер-контекст нужен только cross-pipeline конверсиям.
  const needsBerater =
    opts.conversionId === "C3" ||
    opts.conversionId === "C3.1" ||
    opts.conversionId === "C4" ||
    opts.conversionId === "C5";
  const beraterContext =
    leadIds.length && needsBerater
      ? await fetchBeraterContext(leadIds)
      : new Map();

  // Точно повторяем per-metric логику computeCohorts:
  //  • ignor (C1.1/C2.1) — полностью вне расчёта;
  //  • base («Лиды») = НЕ дисквалифицирован И included (= displayLeadCount);
  //  • target («Факт») = included И достиг цели, причём цель засчитывается даже
  //    дисквалифицированному лиду, если он дошёл ДО дисквалификации
  //    (target_at ≤ disqualified_at) — это _target_counts() в computeCohorts.
  const matchingIds: number[] = [];
  for (const lead of baseLeads) {
    if (excludesIgnor(opts.conversionId) && lead.isIgnor) continue;

    // C3.1 — отдельная логика (success/failure без Гос-дисквала):
    //  • metric "base"   = все с ДЦ (success | failure)
    //  • metric "target" = только success (продвинулись)
    if (opts.conversionId === "C3.1") {
      const state = classifyDcToAa(lead, beraterContext);
      if (opts.metric === "target") {
        if (state !== "success") continue;
      } else {
        if (state !== "success" && state !== "failure") continue;
      }
      matchingIds.push(lead.leadId);
      continue;
    }

    const result = processLeadForConversion(
      opts.conversionId,
      lead,
      targetEvents,
      beraterContext
    );

    if (opts.metric === "target") {
      if (!result.included || result.targetAt === null) continue;
      const targetCounts =
        lead.disqualifiedAt === null ||
        result.targetAt <= lead.disqualifiedAt;
      if (!targetCounts) continue;
    } else {
      if (lead.isDisqualified) continue;
      if (!result.included) continue;
    }
    matchingIds.push(lead.leadId);
  }

  const totalCount = matchingIds.length;
  if (totalCount === 0) {
    return {
      conversionId: opts.conversionId,
      weekStartIso: opts.weekStartIso,
      metric: opts.metric,
      count: 0,
      leads: [],
    };
  }

  const limit = opts.limit ?? 25;
  const sliceIds = matchingIds.slice(0, limit);
  const hydrated = await hydrateLeadDetails(sliceIds);

  // Сохраняем исходный порядок (по anchor возрастанию из matchingIds).
  const byId = new Map(hydrated.map((h) => [h.leadId, h]));
  const ordered = sliceIds
    .map((id) => byId.get(id))
    .filter((x): x is DrillLead => x !== undefined);

  return {
    conversionId: opts.conversionId,
    weekStartIso: opts.weekStartIso,
    metric: opts.metric,
    count: totalCount,
    leads: ordered,
  };
}

/** По массиву lead_id вытягивает имя контакта (active link) + текущий статус.
 *  Экспортируется для переиспользования в dc-breakdown.ts. */
export async function hydrateLeadDetails(leadIds: number[]): Promise<DrillLead[]> {
  if (leadIds.length === 0) return [];
  const idsIn = leadIds.join(",");
  // Берём по одному (первому по lead_id) контакту на лид через DISTINCT ON.
  const rows = await analyticsDb.execute(sql`
    SELECT
      l.lead_id        AS "leadId",
      l.status         AS "status",
      cn.name          AS "contactName"
    FROM analytics.leads_cohort AS l
    LEFT JOIN LATERAL (
      SELECT c.name
      FROM analytics.lead_contact_links lcl
      JOIN analytics.contacts c ON c.contact_id = lcl.contact_id
      WHERE lcl.lead_id = l.lead_id
        AND lcl.is_active = TRUE
        AND c.name IS NOT NULL
      ORDER BY lcl.first_seen_at ASC
      LIMIT 1
    ) AS cn ON TRUE
    WHERE l.lead_id IN (${sql.raw(idsIn)})
  `);
  const data = unwrapRows<{
    leadId: string | number;
    status: string | null;
    contactName: string | null;
  }>(rows);
  return data.map((r) => {
    const id = Number(r.leadId);
    return {
      leadId: id,
      name: r.contactName?.trim() || `Лид #${id}`,
      kommoUrl: `${KOMMO_BASE}/${id}`,
      currentStatus: r.status,
    };
  });
}
