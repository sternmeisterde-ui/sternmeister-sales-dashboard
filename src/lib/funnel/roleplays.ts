/**
 * Чтение клиентских оценок ролевок из `analytics.client_roleplays` для Funnel.
 *
 * Источник наполняется ETL-шагом `sync-client-roleplays` (зеркало D2
 * client_evaluations из ОКК). Здесь — только чтение + агрегаты «готовности»
 * клиента по сторонам ДЦ (dc) / АА (aa), как требует ТЗ §7.4 / §8.
 *
 * Готовность НЕ предиктор гутшайна (калибровка ОКК AUC~0.51) — это индикатор
 * подготовленности клиента. См. dev_docs/funnel/02-ЧТО-СДЕЛАНО-ЧТО-НУЖНО.md §3.4.
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { unwrapRows } from "./compute";

export interface RoleplayAttempt {
  attempt: number | null;
  score5: number | null;
  scorePercent: number | null;
  at: string | null; // ISO/text дата звонка-ролевки
}

export interface SideReadiness {
  attempts: RoleplayAttempt[]; // по возрастанию попытки/времени — для динамики 2→3→4
  count: number;
  latestScore5: number | null; // последняя оценка (свежесть)
  avgScore5: number | null; // средняя (для §8 готовности)
  bestScore5: number | null; // лучшая
}

export interface LeadRoleplays {
  leadId: number;
  dc: SideReadiness; // ролевки ДЦ
  aa: SideReadiness; // ролевки АА
}

type RoleplayRow = {
  lead_id: string | number;
  side: string;
  attempt: number | null;
  score_5: number | null;
  score_percent: number | null;
  roleplay_at: string | null;
};

function emptySide(): SideReadiness {
  return { attempts: [], count: 0, latestScore5: null, avgScore5: null, bestScore5: null };
}

function emptyLead(leadId: number): LeadRoleplays {
  return { leadId, dc: emptySide(), aa: emptySide() };
}

/**
 * Ролевки для набора лидов. Возвращает Map (только лиды, у которых есть ролевки).
 * lead_ids приводятся к целым и валидируются — IN-список безопасен.
 */
export async function getRoleplaysForLeads(
  leadIds: number[],
): Promise<Map<number, LeadRoleplays>> {
  const ids = Array.from(
    new Set(leadIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)),
  );
  const out = new Map<number, LeadRoleplays>();
  if (ids.length === 0) return out;

  const rows = unwrapRows<RoleplayRow>(
    await analyticsDb.execute(sql`
      SELECT lead_id, side, attempt, score_5, score_percent,
             roleplay_at::text AS roleplay_at
      FROM analytics.client_roleplays
      WHERE lead_id IN (${sql.raw(ids.join(","))})
      ORDER BY lead_id, side, attempt NULLS LAST, roleplay_at
    `),
  );

  for (const r of rows) {
    const leadId = Number(r.lead_id);
    let entry = out.get(leadId);
    if (!entry) {
      entry = emptyLead(leadId);
      out.set(leadId, entry);
    }
    const side = r.side === "aa" ? entry.aa : entry.dc;
    side.attempts.push({
      attempt: r.attempt,
      score5: r.score_5,
      scorePercent: r.score_percent,
      at: r.roleplay_at,
    });
  }

  for (const entry of out.values()) {
    finalizeSide(entry.dc);
    finalizeSide(entry.aa);
  }
  return out;
}

/** Удобный однолидовый враппер — всегда возвращает объект (пустой, если ролевок нет). */
export async function getLeadRoleplays(leadId: number): Promise<LeadRoleplays> {
  const map = await getRoleplaysForLeads([leadId]);
  return map.get(leadId) ?? emptyLead(leadId);
}

/** Считает агрегаты по уже собранным (упорядоченным) попыткам стороны. */
function finalizeSide(side: SideReadiness): void {
  side.count = side.attempts.length;
  const scored = side.attempts
    .map((a) => a.score5)
    .filter((s): s is number => s != null);
  if (scored.length > 0) {
    side.bestScore5 = Math.max(...scored);
    side.avgScore5 =
      Math.round((scored.reduce((s, v) => s + v, 0) / scored.length) * 100) / 100;
    // attempts упорядочены по возрастанию попытки/времени → последняя оценённая = свежая
    for (let i = side.attempts.length - 1; i >= 0; i--) {
      if (side.attempts[i].score5 != null) {
        side.latestScore5 = side.attempts[i].score5;
        break;
      }
    }
  }
}
