/**
 * Раздел «Ролевки» (Воронка → отдельный режим).
 *
 * Отвечает на вопрос РОПа: сколько ролевок реально провели с клиентами, растёт
 * ли это понедельно, и можно ли верить оценкам в карточках Kommo.
 *
 * ТРИ СЛОЯ, сознательно разделённые — смешивать их нельзя, у них разное покрытие:
 *
 *  1. КОНСУЛЬТАЦИИ (полное покрытие). Соединённые звонки ≥10 мин, сделанные
 *     пока сделка стояла на консультационном этапе (ДЦ/АА). Источник —
 *     analytics.communications × интервалы стадий из lead_status_changes.
 *     Это главный счётчик: он ничего не теряет.
 *
 *  2. РАЗБОР ОКК (частичное покрытие ≈ 7% звонков!). ОКК берёт в оценку только
 *     звонки ОТ 15 МИНУТ (MIN_DURATION_BY_PROMPT.d2_berater=900), поэтому
 *     консультации 10–15 мин туда не попадают вовсе. Из разобранных видно,
 *     репетировали ли реально: `roleplay_present` = клиент сам отвечал
 *     по-немецки (гейт по ответам). Менеджерский критерий «Проведение ролевки»
 *     мягче — засчитывает «предложил / перенёс / отправил в тренажёр», поэтому
 *     как счётчик ролевок он не годится и здесь не используется.
 *
 *  3. ОЦЕНКИ В KOMMO + ПРОВЕНАНС. Поля «Ролевка ДЦ/АА-N оценка» заполняют ДВА
 *     источника: менеджеры руками и — с 22.06.2026 — сам бот ОКК
 *     (writeClientRoleplayScore, KOMMO_WRITE_ENABLED=true). Различаем так:
 *     ручная правка оставляет событие в tracking_events (синк тянет события
 *     ТОЛЬКО по kommo_user_id менеджеров, записи бота туда не попадают
 *     физически) → есть событие = поставил человек. Балл бота берём из
 *     client_roleplays.
 *
 * Все окна — берлинские (CLAUDE.md #1). Счёт звонков — COUNT(DISTINCT
 * communication_id): Pattern A fanout иначе двоит (CLAUDE.md #4).
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { db } from "@/lib/db/index";
import { d2OkkDb } from "@/lib/db/okk";
import { trackingDb } from "@/lib/db/tracking-db";
import {
  getBeraterPipelineIds,
  getBeraterStatusSets,
  type Vertical,
} from "@/lib/kommo/pipeline-config";
import { unwrapRows } from "./compute";
import { getLeadNames } from "./clients";

/** Консультация = соединённый разговор не короче этого (решение РОПа 28.07). */
export const CONSULT_MIN_SECONDS = 600;

/** Поля Kommo «Ролевка ДЦ/АА-N оценка» → сторона и номер слота. */
const SCORE_FIELDS: Record<number, { side: Side; attempt: number }> = {
  891980: { side: "dc", attempt: 1 },
  891984: { side: "dc", attempt: 2 },
  891988: { side: "dc", attempt: 3 },
  891992: { side: "aa", attempt: 1 },
  891996: { side: "aa", attempt: 2 },
  892000: { side: "aa", attempt: 3 },
};

export type Side = "dc" | "aa";

export interface RoleplaysParams {
  /** Начало периода, YYYY-MM-DD (Berlin). */
  from: string;
  /** Конец периода включительно, YYYY-MM-DD (Berlin). */
  to: string;
  vertical?: Vertical;
}

export interface WeekPoint {
  /** Понедельник недели, YYYY-MM-DD (Berlin). */
  weekStart: string;
  consultations: number;
  analyzed: number;
  confirmed: number;
  leads: number;
  /** Консультаций на клиента за неделю. */
  perLead: number | null;
}

export interface ManagerRow {
  name: string;
  consultations: number;
  analyzed: number;
  confirmed: number;
  leads: number;
  perLead: number | null;
  /** Оценок, выставленных РУКАМИ в карточке Kommo за период. */
  manualScores: number;
  /** Оценок, посчитанных ботом (с 22.06 он их и записывает в Kommo сам). */
  botScores: number;
}

/** Почему консультация не попала в разбор ОКК (человеческим языком). */
export interface NotAnalyzedReason {
  reason: string;
  count: number;
}

export interface ClientRow {
  leadId: number;
  name: string;
  managerName: string | null;
  /** Этап на момент ПОСЛЕДНЕЙ консультации (а не текущий — сделка уезжает). */
  stage: string | null;
  side: Side | null;
  terminIso: string | null;
  consultations: number;
  analyzed: number;
  confirmed: number;
  /** Разбивка «почему не разобрано» — вместо догадок в подсказке. */
  notAnalyzed: NotAnalyzedReason[];
  /** Баллы бота по порядку проведения. */
  botScores: Array<{ score: number | null; at: string | null; notScored: NotScoredKind | null }>;
  /** Ручные правки оценок в Kommo: кто и когда. */
  manualEdits: Array<{ side: Side; attempt: number; score: number | null; at: string; author: string | null }>;
}

export type NotScoredKind = "insufficient" | "degenerate";

export interface RoleplaysTotals {
  consultations: number;
  analyzed: number;
  confirmed: number;
  leads: number;
  perLead: number | null;
  manualScores: number;
  botScores: number;
}

export interface RoleplaysResult {
  totals: RoleplaysTotals;
  weeks: WeekPoint[];
  managers: ManagerRow[];
  clients: ClientRow[];
  /** Доля разобранного ОКК — чтобы никто не принял «не разобрано» за «не было». */
  coveragePct: number | null;
}

export function classifyNotScored(gateReason: string | null): NotScoredKind {
  return gateReason && /degenerate/i.test(gateReason) ? "degenerate" : "insufficient";
}

/** Понедельник берлинской недели для YYYY-MM-DD. */
function weekStartOf(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = понедельник
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

interface ConsultRow {
  leadId: string | number;
  manager: string | null;
  statusId: string | number;
  day: string;
  n: string | number;
}

export async function computeRoleplaysSection(
  params: RoleplaysParams,
): Promise<RoleplaysResult> {
  const { from, to, vertical } = params;
  const beraterIds = getBeraterPipelineIds(vertical);
  const br = getBeraterStatusSets(vertical);
  const dcStatuses = [...br.consultBeforeDC, ...br.consultBeforeDCDone];
  const aaStatuses = [...br.consultBeforeAA, ...br.consultBeforeAADone];
  const consultStatuses = [...dcStatuses, ...aaStatuses];

  // Слой 1. Звонки ≥10 мин, попавшие в интервал консультационной стадии.
  // Интервал стадии — от события смены статуса до следующего события по сделке.
  const consultRows = unwrapRows<ConsultRow>(
    await analyticsDb.execute(sql`
      WITH stage_ranges AS (
        SELECT lsc.lead_id,
               lsc.status_id,
               lsc.event_at,
               LEAD(lsc.event_at) OVER (PARTITION BY lsc.lead_id ORDER BY lsc.event_at) AS next_at
        FROM analytics.lead_status_changes lsc
        JOIN analytics.leads_cohort lc ON lc.lead_id = lsc.lead_id
        WHERE lc.pipeline_id IN (${sql.join(beraterIds.map((id) => sql`${id}`), sql`, `)})
          AND lc.is_deleted = FALSE
          AND lc.exclude_from_analytics = FALSE
      )
      SELECT c.lead_id AS "leadId",
             c.manager  AS "manager",
             r.status_id AS "statusId",
             to_char((c.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') AS "day",
             COUNT(DISTINCT c.communication_id) AS "n"
      FROM analytics.communications c
      JOIN stage_ranges r
        ON r.lead_id = c.lead_id
       AND c.created_at >= r.event_at
       AND (r.next_at IS NULL OR c.created_at < r.next_at)
      WHERE r.status_id IN (${sql.join(consultStatuses.map((id) => sql`${id}`), sql`, `)})
        AND c.communication_type IN ('call_in', 'call_out')
        AND c.call_status = 4
        AND c.duration >= ${CONSULT_MIN_SECONDS}
        AND ((c.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
              BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1, 2, 3, 4
    `),
  );

  const dcSet = new Set(dcStatuses.map(Number));
  const leadIds = new Set<number>();
  for (const r of consultRows) leadIds.add(Number(r.leadId));

  // Слой 2. Что из этого разобрал ОКК и где репетиция подтверждена.
  const okkRows = leadIds.size
    ? unwrapRows<{
        leadId: string | number;
        side: string;
        roleplayAt: string | null;
        score5: number | null;
        gateReason: string | null;
        managerName: string | null;
        confirmed: boolean;
      }>(
        await analyticsDb.execute(sql`
          SELECT lead_id           AS "leadId",
                 side              AS "side",
                 roleplay_at::text AS "roleplayAt",
                 score_5           AS "score5",
                 gate_reason       AS "gateReason",
                 manager_name      AS "managerName",
                 roleplay_present  AS "confirmed"
          FROM analytics.client_roleplays
          WHERE lead_id IN (${sql.raw([...leadIds].join(","))})
            AND ((roleplay_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
                  BETWEEN ${from}::date AND ${to}::date
          ORDER BY lead_id, roleplay_at
        `),
      )
    : [];

  // Слой 3. Ручные правки оценок в карточке Kommo (из tracking_events).
  const manualEdits = await fetchManualScoreEdits(from, to);

  // Почему часть консультаций не разобрана — берём фактическую причину из D2,
  // а не гадаем. Причин несколько и они неочевидны (повторный звонок, уехавший
  // этап, сбой обработки), поэтому одной подписи «короче порога» мало.
  const notAnalyzed = await fetchNotAnalyzedReasons([...leadIds], from, to, consultStatuses);

  // Справочники: имена клиентов, ответственные, термины, этап последней консультации.
  const ids = [...leadIds];
  const [names, leadMeta, roster] = await Promise.all([
    getLeadNames(ids),
    fetchLeadMeta(ids),
    fetchManagerNames(),
  ]);

  // ── Сборка по клиентам ────────────────────────────────────────────────────
  const clientMap = new Map<
    number,
    {
      consultations: number;
      lastDay: string | null;
      lastStatusId: number | null;
      managers: Map<string, number>;
      sides: Set<Side>;
    }
  >();
  for (const r of consultRows) {
    const leadId = Number(r.leadId);
    const n = Number(r.n) || 0;
    let e = clientMap.get(leadId);
    if (!e) {
      e = { consultations: 0, lastDay: null, lastStatusId: null, managers: new Map(), sides: new Set() };
      clientMap.set(leadId, e);
    }
    e.consultations += n;
    if (e.lastDay === null || r.day > e.lastDay) {
      e.lastDay = r.day;
      e.lastStatusId = Number(r.statusId);
    }
    e.sides.add(dcSet.has(Number(r.statusId)) ? "dc" : "aa");
    if (r.manager) e.managers.set(r.manager, (e.managers.get(r.manager) ?? 0) + n);
  }

  const okkByLead = new Map<number, typeof okkRows>();
  for (const r of okkRows) {
    const id = Number(r.leadId);
    const list = okkByLead.get(id);
    if (list) list.push(r);
    else okkByLead.set(id, [r]);
  }

  const editsByLead = new Map<number, ClientRow["manualEdits"]>();
  for (const e of manualEdits) {
    if (!leadIds.has(e.leadId)) continue;
    const list = editsByLead.get(e.leadId);
    const item = {
      side: e.side,
      attempt: e.attempt,
      score: e.score,
      at: e.at,
      author: roster.get(e.kommoUserId) ?? null,
    };
    if (list) list.push(item);
    else editsByLead.set(e.leadId, [item]);
  }

  const clients: ClientRow[] = [];
  for (const [leadId, e] of clientMap) {
    const okk = okkByLead.get(leadId) ?? [];
    const meta = leadMeta.get(leadId);
    // Ответственный по CRM, а если его нет — тот, кто больше звонил.
    const topCaller = [...e.managers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const side = e.sides.size === 1 ? [...e.sides][0] : null;
    clients.push({
      leadId,
      name: names.get(leadId) ?? `Лид #${leadId}`,
      managerName: meta?.managerName ?? topCaller,
      stage: meta?.statusNameById.get(e.lastStatusId ?? -1) ?? null,
      side,
      terminIso: side === "aa" ? (meta?.aaTerminIso ?? null) : (meta?.terminIso ?? null),
      consultations: e.consultations,
      analyzed: okk.length,
      confirmed: okk.filter((r) => r.confirmed).length,
      notAnalyzed: notAnalyzed.get(leadId) ?? [],
      botScores: okk.map((r) => ({
        score: r.score5,
        at: r.roleplayAt ? new Date(r.roleplayAt).toISOString() : null,
        notScored: r.score5 === null ? classifyNotScored(r.gateReason) : null,
      })),
      manualEdits: (editsByLead.get(leadId) ?? []).sort((a, b) => a.at.localeCompare(b.at)),
    });
  }
  clients.sort((a, b) => b.consultations - a.consultations || a.name.localeCompare(b.name, "ru"));

  // ── Понедельная динамика ──────────────────────────────────────────────────
  const weekMap = new Map<string, { c: number; a: number; k: number; leads: Set<number> }>();
  const bump = (week: string) => {
    let w = weekMap.get(week);
    if (!w) {
      w = { c: 0, a: 0, k: 0, leads: new Set() };
      weekMap.set(week, w);
    }
    return w;
  };
  for (const r of consultRows) {
    const w = bump(weekStartOf(r.day));
    w.c += Number(r.n) || 0;
    w.leads.add(Number(r.leadId));
  }
  for (const r of okkRows) {
    if (!r.roleplayAt) continue;
    const day = berlinDay(r.roleplayAt);
    if (!day) continue;
    const w = bump(weekStartOf(day));
    w.a += 1;
    if (r.confirmed) w.k += 1;
  }
  const weeks: WeekPoint[] = [...weekMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, w]) => ({
      weekStart,
      consultations: w.c,
      analyzed: w.a,
      confirmed: w.k,
      leads: w.leads.size,
      perLead: w.leads.size > 0 ? Math.round((w.c / w.leads.size) * 100) / 100 : null,
    }));

  // ── Срез по менеджерам ────────────────────────────────────────────────────
  const mgrMap = new Map<
    string,
    { c: number; a: number; k: number; leads: Set<number>; manual: number; bot: number }
  >();
  const mgr = (name: string) => {
    let m = mgrMap.get(name);
    if (!m) {
      m = { c: 0, a: 0, k: 0, leads: new Set(), manual: 0, bot: 0 };
      mgrMap.set(name, m);
    }
    return m;
  };
  for (const r of consultRows) {
    if (!r.manager) continue;
    const m = mgr(r.manager);
    m.c += Number(r.n) || 0;
    m.leads.add(Number(r.leadId));
  }
  for (const r of okkRows) {
    if (!r.managerName) continue;
    const m = mgr(r.managerName);
    m.a += 1;
    if (r.confirmed) m.k += 1;
    if (r.score5 !== null) m.bot += 1;
  }
  for (const e of manualEdits) {
    if (!leadIds.has(e.leadId)) continue;
    const name = roster.get(e.kommoUserId);
    if (!name) continue;
    mgr(name).manual += 1;
  }
  const managers: ManagerRow[] = [...mgrMap.entries()]
    .map(([name, m]) => ({
      name,
      consultations: m.c,
      analyzed: m.a,
      confirmed: m.k,
      leads: m.leads.size,
      perLead: m.leads.size > 0 ? Math.round((m.c / m.leads.size) * 100) / 100 : null,
      manualScores: m.manual,
      botScores: m.bot,
    }))
    .sort((a, b) => b.consultations - a.consultations);

  const totals: RoleplaysTotals = {
    consultations: clients.reduce((s, c) => s + c.consultations, 0),
    analyzed: okkRows.length,
    confirmed: okkRows.filter((r) => r.confirmed).length,
    leads: clients.length,
    perLead: null,
    manualScores: managers.reduce((s, m) => s + m.manualScores, 0),
    botScores: managers.reduce((s, m) => s + m.botScores, 0),
  };
  totals.perLead =
    totals.leads > 0 ? Math.round((totals.consultations / totals.leads) * 100) / 100 : null;

  return {
    totals,
    weeks,
    managers,
    clients,
    coveragePct:
      totals.consultations > 0
        ? Math.round((totals.analyzed / totals.consultations) * 100)
        : null,
  };
}

function berlinDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Человеческая причина по тексту `calls.error_message` из ОКК. */
function humanReason(err: string | null, promptType: string | null): string {
  if (promptType && promptType !== "d2_berater" && promptType !== "d2_berater2") {
    // Звонок разобран, но под другой рубрикой: ОКК классифицирует по своему
    // dual-фильтру и мог отнести разговор к доведению или квалификации.
    const label =
      promptType.includes("dovedenie") ? "доведение"
      : promptType.includes("qualifier") ? "квалификация"
      : promptType;
    return `разобран как «${label}», а не консультация`;
  }
  const e = err ?? "";
  if (/follow-up call on/i.test(e)) {
    const m = /priorCount=(\d+)/.exec(e);
    return `повторный звонок: у сделки уже ${m ? m[1] : "4+"} касаний — первичный скрипт не разбирают`;
  }
  if (/too short for/i.test(e)) {
    const m = /\((\d+)s < (\d+)s\)/.exec(e);
    return m
      ? `короче порога разбора (${Math.round(Number(m[1]) / 60)} мин < ${Math.round(Number(m[2]) / 60)} мин)`
      : "короче порога разбора";
  }
  if (/status .* not allowed|initial\/current status/i.test(e)) {
    return "сделка уехала на другой этап — рубрика не совпала";
  }
  if (/primary of interrupted pair/i.test(e)) return "первая часть склеенного разговора (разбирают вторую)";
  if (/stuck in evaluating|Evaluation failed/i.test(e)) return "сбой обработки — звонок так и не оценён";
  if (/no CRM data/i.test(e)) return "нет данных CRM";
  if (/unknown pipeline/i.test(e)) return "неизвестная воронка";
  if (/Unmatched agent/i.test(e)) return "менеджер не сопоставлен";
  if (/Excluded agent/i.test(e)) return "менеджер исключён из ОКК";
  if (!e) return "не дошёл до разбора";
  return e.slice(0, 70);
}

/**
 * Почему консультации сделки не попали в разбор ОКК. Читаем D2 напрямую (как
 * getOkkByLead): в analytics зеркалятся только УЖЕ разобранные ролевки, а нам
 * нужны как раз неразобранные и их причина.
 */
async function fetchNotAnalyzedReasons(
  leadIds: number[],
  from: string,
  to: string,
  consultStatuses: number[],
): Promise<Map<number, NotAnalyzedReason[]>> {
  const out = new Map<number, NotAnalyzedReason[]>();
  const ids = leadIds.filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return out;
  try {
    const rows = unwrapRows<{
      leadId: string | number;
      err: string | null;
      promptType: string | null;
    }>(
      await d2OkkDb.execute(sql`
        SELECT c.kommo_lead_id AS "leadId",
               c.error_message AS "err",
               e.prompt_type   AS "promptType"
        FROM calls c
        LEFT JOIN LATERAL (
          SELECT prompt_type FROM evaluations
          WHERE call_id = c.id ORDER BY created_at DESC LIMIT 1
        ) e ON TRUE
        WHERE c.kommo_lead_id IN (${sql.raw(ids.join(","))})
          AND c.duration_seconds >= ${CONSULT_MIN_SECONDS}
          AND (c.call_created_at AT TIME ZONE 'Europe/Berlin')::date
                BETWEEN ${from}::date AND ${to}::date
          -- Только звонки, сделанные НА консультационном этапе: у ОКК есть
          -- собственный снимок стадии на момент звонка, он же используется в
          -- слое 1 (там стадия берётся из lead_status_changes). Без этого в
          -- «почему не разобрано» попадали звонки доведения и квалификации,
          -- которые консультациями и не считались.
          AND c.initial_kommo_status_id IN (${sql.join(
            consultStatuses.map((id) => sql`${id}`),
            sql`, `,
          )})
          AND (e.prompt_type IS NULL OR e.prompt_type NOT IN ('d2_berater', 'd2_berater2'))
      `),
    );
    const perLead = new Map<number, Map<string, number>>();
    for (const r of rows) {
      const id = Number(r.leadId);
      if (!Number.isInteger(id)) continue;
      const reason = humanReason(r.err, r.promptType);
      const m = perLead.get(id) ?? new Map<string, number>();
      m.set(reason, (m.get(reason) ?? 0) + 1);
      perLead.set(id, m);
    }
    for (const [id, m] of perLead) {
      out.set(
        id,
        [...m.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
      );
    }
  } catch (e) {
    // D2 недоступна — раздел должен работать и без объяснений.
    console.error(
      "[funnel/roleplays] not-analyzed reasons unavailable (non-fatal):",
      e instanceof Error ? e.message : e,
    );
  }
  return out;
}

interface ManualEdit {
  leadId: number;
  kommoUserId: number;
  side: Side;
  attempt: number;
  score: number | null;
  at: string; // ISO
}

/**
 * Ручные правки полей «Ролевка …-N оценка» из tracking_events.
 *
 * Почему это надёжный признак «поставил человек»: tracking-синк тянет события
 * Kommo с `filter[created_by]` = kommo_user_id менеджеров из master_managers
 * (src/lib/tracking/sync.ts), поэтому записи бота ОКК в эту таблицу не попадают
 * ФИЗИЧЕСКИ. Есть событие → значение выставил человек; нет события, а балл в
 * карточке есть → это автозапись бота (работает с 22.06.2026).
 */
async function fetchManualScoreEdits(from: string, to: string): Promise<ManualEdit[]> {
  const out: ManualEdit[] = [];
  const fieldIds = Object.keys(SCORE_FIELDS);
  try {
    const rows = unwrapRows<{
      entityId: string | number | null;
      kommoUserId: string | number;
      eventType: string;
      createdAt: string | Date;
      raw: unknown;
    }>(
      await trackingDb.execute(sql`
        SELECT entity_id      AS "entityId",
               kommo_user_id  AS "kommoUserId",
               event_type     AS "eventType",
               created_at     AS "createdAt",
               raw            AS "raw"
        FROM tracking_events
        WHERE entity_type = 'lead'
          AND event_type IN (${sql.join(
            fieldIds.map((id) => sql`${`custom_field_${id}_value_changed`}`),
            sql`, `,
          )})
          AND (created_at AT TIME ZONE 'Europe/Berlin')::date BETWEEN ${from}::date AND ${to}::date
      `),
    );
    for (const r of rows) {
      const leadId = r.entityId === null ? NaN : Number(r.entityId);
      if (!Number.isInteger(leadId)) continue;
      const m = /^custom_field_(\d+)_value_changed$/.exec(r.eventType);
      const slot = m ? SCORE_FIELDS[Number(m[1])] : undefined;
      if (!slot) continue;
      out.push({
        leadId,
        kommoUserId: Number(r.kommoUserId),
        side: slot.side,
        attempt: slot.attempt,
        score: extractScore(r.raw),
        at: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
      });
    }
  } catch (e) {
    // Tracking — отдельный Neon-проект и может быть не сконфигурен: раздел
    // должен работать и без слоя провенанса, просто без колонок «руками».
    console.error(
      "[funnel/roleplays] manual edits unavailable (non-fatal):",
      e instanceof Error ? e.message : e,
    );
  }
  return out;
}

/** Балл из value_after события Kommo: [{custom_field_value:{text:"4"}}]. */
function extractScore(raw: unknown): number | null {
  const after = (raw as { value_after?: unknown } | null)?.value_after;
  if (!Array.isArray(after) || after.length === 0) return null;
  const text = (after[0] as { custom_field_value?: { text?: unknown } })?.custom_field_value?.text;
  const n = Number(text);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

interface LeadMeta {
  managerName: string | null;
  terminIso: string | null;
  aaTerminIso: string | null;
  statusNameById: Map<number, string>;
}

/** Ответственный, термины и названия стадий (для колонки «этап»). */
async function fetchLeadMeta(leadIds: number[]): Promise<Map<number, LeadMeta>> {
  const out = new Map<number, LeadMeta>();
  if (leadIds.length === 0) return out;
  const [leads, statuses, roster] = await Promise.all([
    unwrapRowsAsync<{
      leadId: string | number;
      responsibleUserId: string | number | null;
      terminDate: string | Date | null;
      aaTerminDate: string | Date | null;
    }>(sql`
      SELECT lead_id AS "leadId", responsible_user_id AS "responsibleUserId",
             termin_date AS "terminDate", aa_termin_date AS "aaTerminDate"
      FROM analytics.leads_cohort
      WHERE lead_id IN (${sql.raw(leadIds.join(","))})
    `),
    unwrapRowsAsync<{ statusId: string | number; statusName: string | null }>(sql`
      SELECT DISTINCT ON (status_id) status_id AS "statusId", status AS "statusName"
      FROM analytics.lead_status_changes
      WHERE status IS NOT NULL
      ORDER BY status_id, event_at DESC
    `),
    fetchManagerNames(),
  ]);

  const statusNameById = new Map<number, string>();
  for (const s of statuses) {
    if (s.statusName) statusNameById.set(Number(s.statusId), s.statusName);
  }
  for (const l of leads) {
    const uid = l.responsibleUserId === null ? null : Number(l.responsibleUserId);
    out.set(Number(l.leadId), {
      managerName: uid !== null ? (roster.get(uid) ?? null) : null,
      terminIso: toIso(l.terminDate),
      aaTerminIso: toIso(l.aaTerminDate),
      statusNameById,
    });
  }
  return out;
}

function toIso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

async function unwrapRowsAsync<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return unwrapRows<T>(await analyticsDb.execute(query));
}

/** kommo_user_id → каноничное имя (master_managers, D1). */
async function fetchManagerNames(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const rows = unwrapRows<{ uid: string | number | null; name: string | null }>(
    await db.execute(sql`
      SELECT kommo_user_id AS "uid", name AS "name"
      FROM master_managers
      WHERE kommo_user_id IS NOT NULL
    `),
  );
  for (const r of rows) {
    if (r.uid === null || !r.name) continue;
    out.set(Number(r.uid), r.name);
  }
  return out;
}
