/**
 * Drill-down: список лидов конкретной (конверсия, неделя) с метрикой base|target.
 * Используется endpoint-ом /api/funnel/cohorts/{conversionId}/{weekStart}/leads.
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import {
  fetchBeraterContext,
  fetchQualifiedBaseLeads,
  fetchTargetEvents,
  processLeadForConversion,
  unwrapRows,
  type ComputeOpts,
} from "./compute";
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
  // Сужаем from/to до бордеров запрошенной ISO-недели — иначе тянем тысячи
  // лидов за весь период из ComputeOpts и потом фильтруем до одной недели.
  // Для drill-down это лишняя работа: запрос интересует ТОЛЬКО эта неделя.
  const weekStart = new Date(`${opts.weekStartIso}T00:00:00Z`);
  if (Number.isNaN(weekStart.getTime())) {
    throw new Error(`invalid weekStartIso: ${opts.weekStartIso}`);
  }
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 7);
  const narrowedOpts = { ...opts, from: weekStart, to: weekEnd };

  const baseLeads = await fetchQualifiedBaseLeads(narrowedOpts);
  const leadIds = baseLeads.map((l) => l.leadId);
  const targetEvents = leadIds.length
    ? await fetchTargetEvents(leadIds)
    : new Map<string, Date>();
  // Бератер-контекст нужен только cross-pipeline конверсиям.
  const needsBerater =
    opts.conversionId === "C3" ||
    opts.conversionId === "C4" ||
    opts.conversionId === "C5";
  const beraterContext =
    leadIds.length && needsBerater
      ? await fetchBeraterContext(leadIds)
      : new Map();

  const matchingIds: number[] = [];
  for (const lead of baseLeads) {
    // Currently-disqualified → не в base и не в target (соответствует
    // displayLeadCount() cohort-conversion: "Лиды" = base - disqualified).
    if (lead.isDisqualified) continue;

    const result = processLeadForConversion(
      opts.conversionId,
      lead,
      targetEvents,
      beraterContext
    );
    if (!result.included) continue;
    if (opts.metric === "target") {
      if (result.targetAt === null) continue;
      if (
        lead.disqualifiedAt !== null &&
        result.targetAt > lead.disqualifiedAt
      ) {
        continue;
      }
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

/** По массиву lead_id вытягивает имя контакта (active link) + текущий статус. */
async function hydrateLeadDetails(leadIds: number[]): Promise<DrillLead[]> {
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
