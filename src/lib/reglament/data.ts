/**
 * Слой данных вкладки «Регламент»: интервалы пребывания сделок на этапах
 * (analytics.lead_status_changes) и касания (analytics.communications).
 *
 * Используется view'ами stage_time / tlt_gap / touches / summary.
 * Все timestamps — UTC (naive в БД); наружу отдаём миллисекунды epoch.
 */

import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";
import { FUNNEL_PIPELINES, type FunnelKey } from "@/lib/reglament/norms";

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function utcLiteral(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Naive-UTC строка из БД → epoch ms. Драйвер отдаёт raw-строки без TZ. */
function naiveUtcToMs(s: string): number {
  return new Date(s.replace(" ", "T") + "Z").getTime();
}

export interface StageInterval {
  leadId: number;
  funnel: FunnelKey;
  status: string;
  enterMs: number;
  /** null = сделка всё ещё на этапе. */
  exitMs: number | null;
  /** Этап, В который ушла сделка (для «Касаний»); null у открытых. */
  nextStatus: string | null;
  responsible: string;
}

export interface FetchIntervalsOpts {
  funnels: FunnelKey[];
  fromUtc: Date;
  toUtc: Date;
  /** Якорь периода: exit — по дате выхода (умолч.), enter — по дате входа. */
  anchor?: "exit" | "enter";
  /** Только эти статусы (напр. этапы с нормативами). */
  statuses?: readonly string[];
  /** Только закрытые интервалы (переходы) — для «Касаний». */
  closedOnly?: boolean;
  manager?: string | null;
  leadId?: number | null;
}

/**
 * Интервалы пребывания на этапах. «Выход» открытых = NOW() для anchor=exit
 * (открытый интервал попадает в период, если «сейчас» в периоде).
 * Ответственный — текущий менеджер сделки (leads_cohort), удалённые лиды
 * исключены.
 */
export async function fetchStageIntervals(opts: FetchIntervalsOpts): Promise<StageInterval[]> {
  const pipelines = opts.funnels.map((f) => `'${esc(FUNNEL_PIPELINES[f])}'`).join(", ");
  const fromLit = utcLiteral(opts.fromUtc);
  const toLit = utcLiteral(opts.toUtc);
  const anchor = opts.anchor ?? "exit";
  const anchorCond =
    anchor === "enter"
      ? `sc.event_at >= '${fromLit}' AND sc.event_at <= '${toLit}'`
      : `COALESCE(sc.next_event_at, NOW() AT TIME ZONE 'UTC') >= '${fromLit}'
         AND COALESCE(sc.next_event_at, NOW() AT TIME ZONE 'UTC') <= '${toLit}'`;
  const statusCond = opts.statuses?.length
    ? `AND sc.status IN (${opts.statuses.map((s) => `'${esc(s)}'`).join(", ")})`
    : "";
  const closedCond = opts.closedOnly ? "AND sc.next_event_at IS NOT NULL" : "";
  const managerCond = opts.manager ? `AND lc.manager = '${esc(opts.manager)}'` : "";
  const leadCond = opts.leadId ? `AND sc.lead_id = ${Math.floor(opts.leadId)}` : "";

  const query = `
    SELECT
      sc.lead_id,
      sc.pipeline,
      sc.status,
      to_char(sc.event_at, 'YYYY-MM-DD HH24:MI:SS') AS enter_utc,
      to_char(sc.next_event_at, 'YYYY-MM-DD HH24:MI:SS') AS exit_utc,
      -- Этап-приёмник: строка со временем входа = времени нашего выхода.
      -- next_status_id есть, но имени нет — берём по стыку событий.
      (
        SELECT sc2.status FROM analytics.lead_status_changes sc2
        WHERE sc2.lead_id = sc.lead_id AND sc2.event_at = sc.next_event_at
        LIMIT 1
      ) AS next_status,
      COALESCE(lc.manager, '—') AS responsible
    FROM analytics.lead_status_changes sc
    LEFT JOIN analytics.leads_cohort lc ON lc.lead_id = sc.lead_id
    WHERE sc.pipeline IN (${pipelines})
      AND ${anchorCond}
      AND COALESCE(lc.is_deleted, FALSE) = FALSE
      ${statusCond}
      ${closedCond}
      ${managerCond}
      ${leadCond}
    ORDER BY COALESCE(sc.next_event_at, NOW() AT TIME ZONE 'UTC') DESC
  `;
  const res = await analyticsDb.execute<{
    lead_id: string;
    pipeline: string;
    status: string;
    enter_utc: string;
    exit_utc: string | null;
    next_status: string | null;
    responsible: string;
  }>(sql.raw(query));

  return res.rows.map((r) => ({
    leadId: Number(r.lead_id),
    funnel: r.pipeline === FUNNEL_PIPELINES.gos ? ("gos" as const) : ("berater" as const),
    status: r.status,
    enterMs: naiveUtcToMs(r.enter_utc),
    exitMs: r.exit_utc ? naiveUtcToMs(r.exit_utc) : null,
    nextStatus: r.next_status,
    responsible: r.responsible,
  }));
}

export interface Touch {
  ms: number;
  type: "call" | "message";
}

/**
 * Касания (исходящие звонки + исходящие сообщения) по лидам в окне.
 * Дедуп Pattern A fanout — DISTINCT по communication_id внутри лида.
 */
export async function fetchTouches(
  leadIds: number[],
  fromMs: number,
  toMs: number,
  types: readonly string[] = ["call_out", "outgoing_chat_message"],
): Promise<Map<number, Touch[]>> {
  const map = new Map<number, Touch[]>();
  if (leadIds.length === 0) return map;
  const fromLit = utcLiteral(new Date(fromMs));
  const toLit = utcLiteral(new Date(toMs));
  const typeList = types.map((t) => `'${esc(t)}'`).join(", ");
  // Чанкуем IN-список: лидов может быть несколько тысяч.
  const CHUNK = 5000;
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const ids = leadIds.slice(i, i + CHUNK).join(", ");
    const query = `
      SELECT DISTINCT ON (communication_id, lead_id)
        lead_id,
        communication_type,
        to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS at_utc
      FROM analytics.communications
      WHERE lead_id IN (${ids})
        AND communication_type IN (${typeList})
        AND created_at >= '${fromLit}' AND created_at <= '${toLit}'
      ORDER BY communication_id, lead_id
    `;
    const res = await analyticsDb.execute<{
      lead_id: string;
      communication_type: string;
      at_utc: string;
    }>(sql.raw(query));
    for (const r of res.rows) {
      const k = Number(r.lead_id);
      const arr = map.get(k) ?? [];
      arr.push({
        ms: naiveUtcToMs(r.at_utc),
        type: r.communication_type === "outgoing_chat_message" ? "message" : "call",
      });
      map.set(k, arr);
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => a.ms - b.ms);
  return map;
}
