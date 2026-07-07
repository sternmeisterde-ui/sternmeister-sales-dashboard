/**
 * Слой данных вкладки «Регламент»: интервалы пребывания сделок на этапах
 * (analytics.lead_status_changes) и касания (analytics.communications).
 *
 * Используется view'ами stage_time / tlt_gap / touches / summary.
 * Все timestamps — UTC (naive в БД); наружу отдаём миллисекунды epoch.
 */

import { analyticsDb } from "@/lib/db/analytics";
import { db } from "@/lib/db";
import { masterManagers } from "@/lib/db/schema-existing";
import { eq, sql } from "drizzle-orm";
import { NAME_ALIASES } from "@/lib/daily/name-aliases";
import { FUNNEL_PIPELINES, type FunnelKey } from "@/lib/reglament/norms";

/** Экранирование строки для raw-SQL литерала (одинарные кавычки). */
export function esc(s: string): string {
  return s.replace(/'/g, "''");
}

/** Date → naive-UTC литерал (с миллисекундами: границы берлинских суток
 *  приходят как 23:59:59.999 — усечение до секунд теряло последнюю секунду). */
export function utcLiteral(d: Date): string {
  return d.toISOString().slice(0, 23).replace("T", " ");
}

/** Naive-UTC строка из БД → epoch ms. Драйвер отдаёт raw-строки без TZ. */
export function naiveUtcToMs(s: string): number {
  return new Date(s.replace(" ", "T") + "Z").getTime();
}

/** Epoch ms → строка "YYYY-MM-DD HH:MM:SS" в Berlin (контракт fmtBerlin в UI). */
export function berlinStr(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin", hour12: false });
  return `${date} ${time}`;
}

/** Kommo-инвариант: status_id 142 = won, 143 = lost — терминальные слоты
 *  любой воронки (в Бух Гос won называется «Термин ДЦ», в Бух Бератер —
 *  «Гутшайн одобрен»). Фильтруем по id, а не по переименовываемым именам. */
export const TERMINAL_STATUS_IDS = [142, 143] as const;

/**
 * Ростер менеджеров b2g для фильтрации вкладки «Регламент».
 *
 * Вкладка показывает ТОЛЬКО людей из master_managers (department='b2g',
 * включая деактивированных): без этого в сводку лезут сервисные аккаунты
 * Kommo («Кураторы», «Виктор»), b2b-менеджеры с единичными передачами
 * сделок и давно ушедшие люди, чьи просроченные задачи висят месяцами.
 *
 * Матчинг двухступенчатый, потому что имена дрейфуют:
 *  - по kommo_user_id (lc.responsible_user_id ↔ master.kommoUserId) —
 *    ловит смену фамилии («Валерия Казеннова» = «Валерия Новикова») и
 *    короткие master-имена («Дмитрий» = Kommo «Дмитрий Слидзюк»);
 *  - по имени (master-имя + алиасы NAME_ALIASES + фактические
 *    analytics-написания тех же uid) — для строк без uid (задачи).
 * canonicalByName переводит любые варианты в master-имя — дубли одного
 * человека под разными написаниями склеиваются.
 */
export interface B2gRoster {
  ids: Set<number>;
  names: Set<string>;
  canonicalByName: Map<string, string>;
}

export async function fetchB2gRoster(): Promise<B2gRoster> {
  const masters = await db
    .select({ name: masterManagers.name, kommoUserId: masterManagers.kommoUserId })
    .from(masterManagers)
    .where(eq(masterManagers.department, "b2g"));
  const ids = new Set<number>();
  const names = new Set<string>();
  const canonicalByName = new Map<string, string>();
  const masterById = new Map<number, string>();
  for (const m of masters) {
    names.add(m.name);
    canonicalByName.set(m.name, m.name);
    for (const alias of NAME_ALIASES[m.name] ?? []) {
      names.add(alias);
      canonicalByName.set(alias, m.name);
    }
    if (m.kommoUserId != null) {
      ids.add(m.kommoUserId);
      masterById.set(m.kommoUserId, m.name);
    }
  }
  if (ids.size > 0) {
    // Фактические Kommo-написания имён этих же людей из зеркала лидов.
    const res = await analyticsDb.execute<{ manager: string; uid: string }>(
      sql.raw(
        `SELECT DISTINCT manager, responsible_user_id AS uid
         FROM analytics.leads_cohort
         WHERE responsible_user_id IN (${[...ids].join(",")}) AND manager IS NOT NULL`,
      ),
    );
    for (const r of res.rows) {
      names.add(r.manager);
      const canon = masterById.get(Number(r.uid));
      if (canon && !canonicalByName.has(r.manager)) canonicalByName.set(r.manager, canon);
    }
  }
  return { ids, names, canonicalByName };
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
  /** Причина закрытия сделки (расшифровка неквал-enum или loss_reason) —
   *  для правила «Игнор → 18 звонков» и исключения «неквал язык» из SLA. */
  closeReason: string | null;
  /** Kommo user id ответственного — для матчинга с master_managers. */
  responsibleUserId: number | null;
}

export interface FetchIntervalsOpts {
  funnels: FunnelKey[];
  fromUtc: Date;
  toUtc: Date;
  /** Якорь периода: exit — по дате выхода (умолч.), enter — по дате входа. */
  anchor?: "exit" | "enter";
  /** Только закрытые интервалы (переходы) — для «Касаний». */
  closedOnly?: boolean;
  /** Все варианты написания выбранного менеджера (канон + Kommo-дрейф). */
  managerNames?: readonly string[] | null;
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
  const closedCond = opts.closedOnly ? "AND sc.next_event_at IS NOT NULL" : "";
  const managerCond = opts.managerNames?.length
    ? `AND lc.manager IN (${opts.managerNames.map((m) => `'${esc(m)}'`).join(", ")})`
    : "";
  const leadCond = opts.leadId ? `AND sc.lead_id = ${Math.floor(opts.leadId)}` : "";
  const terminalIds = TERMINAL_STATUS_IDS.join(", ");

  const query = `
    SELECT
      sc.lead_id,
      sc.pipeline,
      sc.status,
      to_char(sc.event_at, 'YYYY-MM-DD HH24:MI:SS') AS enter_utc,
      to_char(sc.next_event_at, 'YYYY-MM-DD HH24:MI:SS') AS exit_utc,
      -- Этап-приёмник: строка со временем входа = времени нашего выхода.
      -- Матчим и по next_status_id (когда он есть): при двух сменах статуса
      -- в одну секунду голый стык по event_at недетерминирован (LIMIT 1
      -- вернул бы произвольную из двух строк и чужое правило касаний).
      (
        SELECT sc2.status FROM analytics.lead_status_changes sc2
        WHERE sc2.lead_id = sc.lead_id AND sc2.event_at = sc.next_event_at
          AND (sc.next_status_id IS NULL OR sc2.status_id = sc.next_status_id)
        LIMIT 1
      ) AS next_status,
      COALESCE(lc.manager, '—') AS responsible,
      lc.responsible_user_id,
      COALESCE(re.value, lc.loss_reason) AS close_reason
    FROM analytics.lead_status_changes sc
    LEFT JOIN analytics.leads_cohort lc ON lc.lead_id = sc.lead_id
    LEFT JOIN analytics.refusal_enums re ON re.enum_id = lc.non_qual_enum_id
    WHERE sc.pipeline IN (${pipelines})
      AND ${anchorCond}
      AND COALESCE(lc.is_deleted, FALSE) = FALSE
      -- Пребывания В терминальных статусах (won/lost) — не «этапы работы»:
      -- без этого переоткрытая сделка давала бы ложный переход из «Закрыто»
      -- с правилом ≥1 звонок. Переходы В терминальные остаются видимыми
      -- (next_status берётся независимо).
      AND (sc.status_id IS NULL OR sc.status_id NOT IN (${terminalIds}))
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
    responsible_user_id: string | null;
    close_reason: string | null;
  }>(sql.raw(query));

  return res.rows.map((r) => ({
    leadId: Number(r.lead_id),
    funnel: r.pipeline === FUNNEL_PIPELINES.gos ? ("gos" as const) : ("berater" as const),
    status: r.status,
    enterMs: naiveUtcToMs(r.enter_utc),
    exitMs: r.exit_utc ? naiveUtcToMs(r.exit_utc) : null,
    nextStatus: r.next_status,
    responsible: r.responsible,
    responsibleUserId: r.responsible_user_id != null ? Number(r.responsible_user_id) : null,
    closeReason: r.close_reason,
  }));
}

export interface Touch {
  ms: number;
  type: "call" | "call_in" | "message";
}

/**
 * Касания по лидам в окне: исходящие звонки, входящие звонки (нужны TLT —
 * лист «ПРАВКИ» xlsx: gap учитывает входящие) и исходящие сообщения.
 * Дедуп Pattern A fanout — DISTINCT по communication_id внутри лида.
 */
export async function fetchTouches(
  leadIds: number[],
  fromMs: number,
  toMs: number,
  types: readonly string[] = ["call_out", "call_in", "outgoing_chat_message"],
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
    // Дедуп Pattern A fanout по communication_id внутри лида. NULL-ключи
    // (легаси-строки без comm_id) подменяем меткой времени, иначе DISTINCT ON
    // склеил бы ВСЕ NULL-строки лида в одно касание за период.
    const query = `
      SELECT DISTINCT ON (lead_id, dedup_key)
        lead_id,
        communication_type,
        at_utc
      FROM (
        SELECT
          lead_id,
          communication_type,
          to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS at_utc,
          COALESCE(communication_id, 'nc:' || to_char(created_at, 'YYYYMMDDHH24MISS')) AS dedup_key
        FROM analytics.communications
        WHERE lead_id IN (${ids})
          AND communication_type IN (${typeList})
          AND created_at >= '${fromLit}' AND created_at <= '${toLit}'
      ) src
      ORDER BY lead_id, dedup_key
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
        type:
          r.communication_type === "outgoing_chat_message"
            ? "message"
            : r.communication_type === "call_in"
              ? "call_in"
              : "call",
      });
      map.set(k, arr);
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => a.ms - b.ms);
  return map;
}
