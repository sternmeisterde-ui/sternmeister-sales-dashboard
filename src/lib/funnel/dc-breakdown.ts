/**
 * «Разбор когорты» для C3.1: из лидов с состоявшимся Термином ДЦ — раскладка
 * судьбы за весь период фильтра (продвинулись / остались / потеряны→закрыто/
 * отложен/апелляция) + список лидов по каждому ведру для drill.
 * Используется endpoint-ом /api/funnel/dc-breakdown.
 */

import {
  classifyDcToAaDetailed,
  fetchBeraterContext,
  fetchQualifiedBaseLeads,
  type ComputeOpts,
} from "./compute";
import { hydrateLeadDetails } from "./lead-list";
import type {
  DcBreakdownBucket,
  DcBreakdownResponse,
  DcBucketKey,
} from "./api-types";

const BUCKET_KEYS: DcBucketKey[] = [
  "forward",
  "stayed",
  "closed",
  "delayed",
  "appeal",
];
/** Сколько лидов на ведро гидрируем для drill (счётчик — по полному множеству). */
const DRILL_LIMIT = 25;

export async function computeDcBreakdown(
  opts: ComputeOpts
): Promise<DcBreakdownResponse> {
  const base = await fetchQualifiedBaseLeads(opts);
  const leadIds = base.map((l) => l.leadId);
  const ctx = leadIds.length
    ? await fetchBeraterContext(leadIds)
    : new Map();

  // Раскладываем по вёдрам (detailed). «none» (нет явного Термина ДЦ) — вне разбора.
  const idsByBucket: Record<DcBucketKey, number[]> = {
    forward: [],
    stayed: [],
    closed: [],
    delayed: [],
    appeal: [],
  };
  let total = 0;
  for (const lead of base) {
    const d = classifyDcToAaDetailed(lead, ctx);
    if (d === "none") continue;
    total += 1;
    idsByBucket[d].push(lead.leadId);
  }

  // Гидрируем только первые DRILL_LIMIT каждого ведра (имена/ссылки), сохраняя
  // исходный порядок (по anchor-возрастанию из base).
  const buckets = {} as Record<DcBucketKey, DcBreakdownBucket>;
  for (const k of BUCKET_KEYS) {
    const ids = idsByBucket[k];
    const slice = ids.slice(0, DRILL_LIMIT);
    const hydrated = slice.length ? await hydrateLeadDetails(slice) : [];
    const byId = new Map(hydrated.map((h) => [h.leadId, h]));
    const leads = slice
      .map((id) => byId.get(id))
      .filter((x): x is NonNullable<typeof x> => x !== undefined);
    buckets[k] = { count: ids.length, leads };
  }

  return { total, buckets };
}
