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
 *  2. РАЗБОР ОКК (частичное покрытие, на июль ≈ 76% консультаций). Порог взятия
 *     в оценку снижен до 10 минут (PR okk#51), но часть звонков ОКК пропускает
 *     по своим правилам — фактическую причину по каждому показывает humanReason.
 *     Из разобранных видно,
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

export interface ManagerRow {
  name: string;
  consultations: number;
  analyzed: number;
  confirmed: number;
  leads: number;
  perLead: number | null;
  /** Оценок, посчитанных ботом по записи разговора. */
  botScores: number;
  /** Баллов фактически стоит в карточках Kommo за период. */
  kommoScores: number;
  /** Из них расходятся с ботом (или бот их вовсе не подтверждал). */
  mismatches: number;
}

/** Почему консультация не попала в разбор ОКК (человеческим языком). */
export interface NotAnalyzedReason {
  reason: string;
  count: number;
}

/**
 * Одна ролевка в сверке «что насчитал бот» ↔ «что фактически стоит в Kommo».
 *
 * Смысл сверки: менеджер вписывает балл сразу, бот считает свой примерно через
 * два часа и перезаписывает поле. Значит расхождение — это либо балл, который
 * бот ещё не проверил, либо тот, который менеджер поправил ПОСЛЕ бота. И то и
 * другое РОПу нужно видеть поимённо.
 *
 * Сопоставляем по стороне и ДАТЕ (допуск ±1 день), а не по номеру слота:
 * `roleplay_number` ненадёжен, а дату и менеджер, и бот пишут одну и ту же —
 * дату разговора.
 */
export interface SlotCompare {
  side: Side;
  /** Позиция слота в карточке (ДЦ-1..3 / АА-1..3); null — бот оценил, слота нет. */
  attempt: number | null;
  /** Балл бота (null — бот эту ролевку не оценивал). */
  bot: number | null;
  /** Что фактически стоит в карточке (null — слот пуст). */
  kommo: number | null;
  /** Дата разговора — по данным бота или из слота. */
  day: string | null;
  status: SlotStatus;
  /** Кто последним правил слот руками (из журнала событий Kommo). */
  editedBy: string | null;
  editedAt: string | null;
}

export type SlotStatus =
  /** Балл в карточке совпал с ботом. */
  | "match"
  /** В карточке другая цифра — балл менеджера пережил разбор бота. */
  | "mismatch"
  /** Бот оценил, а в карточке пусто — запись не дошла. */
  | "bot_only"
  /** В карточке стоит балл, ролевку бот не разбирал — подтверждения нет. */
  | "kommo_only"
  /** Разговор сегодня: бот считает ~2 часа, расхождением это считать рано. */
  | "pending";

/** Расхождение = всё, кроме совпадения и «бот ещё считает». */
export function isMismatch(s: SlotStatus): boolean {
  return s === "mismatch" || s === "bot_only" || s === "kommo_only";
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
  /** Сверка «бот ↔ карточка Kommo» по каждой ролевке периода. */
  kommoSlots: SlotCompare[];
}

export type NotScoredKind = "insufficient" | "degenerate";

export interface RoleplaysTotals {
  consultations: number;
  analyzed: number;
  confirmed: number;
  leads: number;
  perLead: number | null;
  botScores: number;
  kommoScores: number;
  mismatches: number;
}

export interface RoleplaysResult {
  totals: RoleplaysTotals;
  managers: ManagerRow[];
  clients: ClientRow[];
  /** Доля разобранного ОКК — чтобы никто не принял «не разобрано» за «не было». */
  coveragePct: number | null;
}

export function classifyNotScored(gateReason: string | null): NotScoredKind {
  return gateReason && /degenerate/i.test(gateReason) ? "degenerate" : "insufficient";
}

/** Слот из зеркала карточки Kommo. */
interface KommoSlot {
  side: Side;
  attempt: number;
  score: number | null;
  date: string | null;
}

/** 'YYYY-MM-DD' по Берлину; null на пустой/битой дате. */
function berlinDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Разница в днях между двумя 'YYYY-MM-DD'. */
function dayGap(a: string | null, b: string | null): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/**
 * Сводит ролевки бота и слоты карточки в одну сверку.
 *
 * Пара ищется по стороне и дате разговора: сначала точное совпадение дня, затем
 * ±1 день (менеджер нередко вписывает балл на следующее утро). По номеру слота
 * не сопоставляем — `roleplay_number` клампится до 3 и ловит гонки.
 */
function compareSlots(
  bot: Array<{ side: Side; day: string | null; score: number | null }>,
  kommo: KommoSlot[],
  edits: Array<{ side: Side; attempt: number; at: string; author: string | null }>,
  today: string,
): SlotCompare[] {
  const freeSlots = [...kommo];
  const out: SlotCompare[] = [];

  const lastEdit = (side: Side, attempt: number) =>
    edits
      .filter((e) => e.side === side && e.attempt === attempt)
      .sort((a, b) => a.at.localeCompare(b.at))
      .at(-1) ?? null;

  const take = (
    side: Side,
    day: string | null,
    maxGap: number,
    want: "sameScore" | "scored" | "any",
    score: number | null,
  ): KommoSlot | null => {
    const i = freeSlots.findIndex((s) => {
      if (s.side !== side || dayGap(s.date, day) > maxGap) return false;
      if (want === "sameScore") return score !== null && s.score === score;
      if (want === "scored") return s.score !== null;
      return true;
    });
    return i >= 0 ? freeSlots.splice(i, 1)[0] : null;
  };

  // Пары ищем в порядке убывания уверенности, и каждый проход — по ВСЕМ
  // ролевкам сразу. Иначе первая же строка забирает чужой слот: например
  // неоценённая ролевка перехватывала слот у оценённой в тот же день, и вместо
  // честного совпадения выходила пара выдуманных расхождений.
  const passes: Array<[number, "sameScore" | "scored" | "any"]> = [
    [0, "sameScore"], // тот же день и та же цифра — самое надёжное
    [0, "scored"],
    [0, "any"],
    [1, "sameScore"], // менеджер нередко вписывает балл на следующее утро
    [1, "scored"],
    [1, "any"],
  ];
  const pending: Array<{ side: Side; day: string | null; score: number | null; slot: KommoSlot | null }> =
    bot.map((b) => ({ ...b, slot: null }));
  for (const [gap, want] of passes) {
    for (const p of pending) {
      if (p.slot) continue;
      p.slot = take(p.side, p.day, gap, want, p.score);
    }
  }

  for (const p of pending) {
    const edit = p.slot ? lastEdit(p.side, p.slot.attempt) : null;
    let status: SlotStatus;
    if (!p.slot || p.slot.score === null) {
      // Бот оценил, а в карточке пусто. В день разговора это норма: он считает
      // примерно два часа — расхождением такое объявлять рано.
      status = p.score === null ? "match" : p.day === today ? "pending" : "bot_only";
    } else if (p.score === null) {
      status = "kommo_only"; // балл стоит, но бот эту ролевку не оценил
    } else {
      status = p.slot.score === p.score ? "match" : "mismatch";
    }
    out.push({
      side: p.side,
      attempt: p.slot?.attempt ?? null,
      bot: p.score,
      kommo: p.slot?.score ?? null,
      day: p.day ?? p.slot?.date ?? null,
      status,
      editedBy: edit?.author ?? null,
      editedAt: edit?.at ?? null,
    });
  }

  // Остались слоты, которым не нашлось ролевки бота — балл стоит, а разбора нет.
  for (const s of freeSlots) {
    if (s.score === null) continue;
    const edit = lastEdit(s.side, s.attempt);
    out.push({
      side: s.side,
      attempt: s.attempt,
      bot: null,
      kommo: s.score,
      day: s.date,
      status: s.date === today ? "pending" : "kommo_only",
      editedBy: edit?.author ?? null,
      editedAt: edit?.at ?? null,
    });
  }

  return out.sort((a, b) => (a.day ?? "").localeCompare(b.day ?? ""));
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

  // Сегодняшний берлинский день: ролевку этого дня бот, возможно, ещё считает
  // (запись в карточку идёт примерно через два часа после разговора).
  const today = berlinDay(new Date().toISOString()) ?? to;

  // Слой 3. Что ФАКТИЧЕСКИ стоит в карточках Kommo (зеркало полей из
  // leads_cohort.roleplay_slots) + кто последним правил слот руками.
  const kommoSlotsByLead = await fetchKommoSlots([...leadIds], from, to);
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

  type Edit = { side: Side; attempt: number; score: number | null; at: string; author: string | null };
  const editsByLead = new Map<number, Edit[]>();
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
    // Причины — это звонки, которые ВИДЕЛ ОКК, но не разобрал. Колонка же
    // считает консультации по телефонии: телефония видит все соединённые
    // звонки, ОКК — только дошедшие до него, поэтому суммы могут не совпасть.
    // Сводим явно, а не подгоняем: если телефония насчитала больше, чем ОКК
    // вообще видел, добавляем честную строку «до ОКК не дошёл».
    const reasons = [...(notAnalyzed.get(leadId) ?? [])];
    const okkSeen = okk.length + reasons.reduce((s, r) => s + r.count, 0);
    if (e.consultations > okkSeen) {
      reasons.push({
        reason: "звонок до ОКК не дошёл — отметки о разборе нет вовсе",
        count: e.consultations - okkSeen,
      });
    }
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
      notAnalyzed: reasons,
      botScores: okk.map((r) => ({
        score: r.score5,
        at: r.roleplayAt ? new Date(r.roleplayAt).toISOString() : null,
        notScored: r.score5 === null ? classifyNotScored(r.gateReason) : null,
      })),
      kommoSlots: compareSlots(
        okk.map((r) => ({ side: r.side === "aa" ? "aa" : "dc", day: berlinDay(r.roleplayAt), score: r.score5 })),
        kommoSlotsByLead.get(leadId) ?? [],
        editsByLead.get(leadId) ?? [],
        today,
      ),
    });
  }
  clients.sort((a, b) => b.consultations - a.consultations || a.name.localeCompare(b.name, "ru"));

  // ── Срез по менеджерам ────────────────────────────────────────────────────
  const mgrMap = new Map<
    string,
    { c: number; a: number; k: number; leads: Set<number>; bot: number; kommo: number; bad: number }
  >();
  const mgr = (name: string) => {
    let m = mgrMap.get(name);
    if (!m) {
      m = { c: 0, a: 0, k: 0, leads: new Set(), bot: 0, kommo: 0, bad: 0 };
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
  // Сверку «бот ↔ карточка» вешаем на ОТВЕТСТВЕННОГО по сделке: спрос за то,
  // что стоит в карточке, идёт с него, кто бы физически ни правил поле.
  for (const c of clients) {
    if (!c.managerName) continue;
    const m = mgr(c.managerName);
    for (const s of c.kommoSlots) {
      if (s.kommo !== null) m.kommo += 1;
      if (isMismatch(s.status)) m.bad += 1;
    }
  }
  const managers: ManagerRow[] = [...mgrMap.entries()]
    .map(([name, m]) => ({
      name,
      consultations: m.c,
      analyzed: m.a,
      confirmed: m.k,
      leads: m.leads.size,
      perLead: m.leads.size > 0 ? Math.round((m.c / m.leads.size) * 100) / 100 : null,
      kommoScores: m.kommo,
      mismatches: m.bad,
      botScores: m.bot,
    }))
    .sort((a, b) => b.consultations - a.consultations);

  const totals: RoleplaysTotals = {
    consultations: clients.reduce((s, c) => s + c.consultations, 0),
    analyzed: okkRows.length,
    confirmed: okkRows.filter((r) => r.confirmed).length,
    leads: clients.length,
    perLead: null,
    kommoScores: managers.reduce((s, m) => s + m.kommoScores, 0),
    mismatches: managers.reduce((s, m) => s + m.mismatches, 0),
    botScores: managers.reduce((s, m) => s + m.botScores, 0),
  };
  totals.perLead =
    totals.leads > 0 ? Math.round((totals.consultations / totals.leads) * 100) / 100 : null;

  return {
    totals,
    managers,
    clients,
    coveragePct:
      totals.consultations > 0
        ? Math.round((totals.analyzed / totals.consultations) * 100)
        : null,
  };
}


/** «4 касания» вместо «4 касаний»: причины читают люди, а не парсер. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
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
    const n = m ? Number(m[1]) : null;
    return `повторный звонок: у сделки уже ${n === null ? "4+ касаний" : plural(n, "касание", "касания", "касаний")} — первичный скрипт не разбирают`;
  }
  if (/too short for/i.test(e)) {
    const m = /\((\d+)s < (\d+)s\)/.exec(e);
    // Округляем ВНИЗ: при 899 с округление вверх давало «15 мин < 15 мин».
    return m
      ? `короче порога разбора (${Math.floor(Number(m[1]) / 60)} мин < ${Math.round(Number(m[2]) / 60)} мин)`
      : "короче порога разбора";
  }
  if (/status .* not allowed|initial\/current status/i.test(e)) {
    return "сделка уехала на другой этап — рубрика не совпала";
  }
  if (/non-primary on/i.test(e)) {
    // Post-eval skip: оценка посчитана, но Grok распознал в содержании не
    // первичный скрипт (followup / check-in / перевод), и её отбросили.
    const m = /call_type=([a-z_]+)/i.exec(e);
    const kind =
      m?.[1] === "check_in" ? "созвон-сверка"
      : m?.[1] === "transfer" ? "перевод на другого менеджера"
      : m?.[1] === "interrupted" ? "оборванный разговор"
      : m?.[1] === "unqualified" ? "клиент не квалифицирован"
      : m?.[1] === "deferred_start" ? "отложенный старт"
      : "повторный разговор";
    return `не первичный разговор (${kind}) — оценку отбросили после разбора`;
  }
  if (/primary of interrupted pair/i.test(e)) return "первая часть склеенного разговора (разбирают вторую)";
  if (/incomplete \((\w+)\)/i.test(e)) {
    const m = /incomplete \((\w+)\)/i.exec(e);
    const kind =
      m?.[1] === "connection_drop" ? "оборвалась связь"
      : m?.[1] === "abrupt_cutoff" ? "разговор резко оборвался"
      : m?.[1] === "transcript_truncated" ? "запись обрезана"
      : "разговор неполный";
    return `${kind}, продолжения за 48 часов не было`;
  }
  if (/stuck in evaluating|Evaluation failed/i.test(e)) return "сбой обработки — звонок так и не оценён";
  if (/no CRM data/i.test(e)) return "нет данных CRM";
  if (/unknown pipeline/i.test(e)) return "неизвестная воронка";
  if (/Unmatched agent/i.test(e)) return "менеджер не сопоставлен";
  if (/Excluded agent/i.test(e)) return "менеджер исключён из ОКК";
  if (/Removed \(auto/i.test(e)) return "оценка снята автоматикой (не консультация)";
  // Исторические пометки ручных чисток мая 2026 — оценка была, но её сняли.
  if (/Cleanup .*continuation .*non-primary/i.test(e)) {
    return "оценка снята при чистке 20.05: продолжение признано не первичным";
  }
  if (/Cleanup .*pre-v5\.1 script/i.test(e)) {
    return "оценка снята при чистке: звонок по старому скрипту (до 16.05)";
  }
  if (/Cleanup .*incomplete/i.test(e)) {
    return "оценка снята при чистке: разговор неполный, продолжения не было";
  }
  if (/Cleanup (\d{4}-\d{2}-\d{2})/i.test(e)) {
    const d = /Cleanup (\d{4}-\d{2}-\d{2})/i.exec(e)?.[1] ?? "";
    return `оценка снята при чистке ${d}`;
  }
  if (/Removed: complaint/i.test(e)) {
    return "оценка снята по жалобе — звонок не должен был оцениваться";
  }
  if (/canary|halted|retro-/i.test(e)) return "остановлено служебным прогоном";
  if (/Telegram notification failed/i.test(e)) {
    // Оценка есть, упало только уведомление — на разбор это не влияет, но в
    // error_message остаётся именно этот текст.
    return "оценка есть, не ушло уведомление менеджеру";
  }
  if (!e) return "не дошёл до разбора";
  // Незнакомый случай: показываем как есть, но помечаем — так видно, что
  // словарь причин пора дополнить, а не что это «нормальная» формулировка.
  return `не разобрано: ${e.slice(0, 60)}`;
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
        -- Отсекаем звонки, по которым КЛИЕНТСКАЯ ролевка всё-таки посчитана:
        -- именно их считает колонка «Разобрал ОКК». Раньше проверялось наличие
        -- МЕНЕДЖЕРСКОЙ оценки, и звонки, где её пропустило правило повторных,
        -- попадали разом и в «разобрано», и в «причины пропуска».
        LEFT JOIN client_evaluations ce ON ce.call_id = c.id
        WHERE ce.call_id IS NULL
          AND c.kommo_lead_id IN (${sql.raw(ids.join(","))})
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
/**
 * Что фактически стоит в карточках Kommo — из зеркала `roleplay_slots`.
 *
 * Берём только слоты с датой внутри периода: карточка копит ролевки за всю
 * жизнь сделки, и июньский слот в июльской выборке выглядел бы «расхождением».
 *
 * NULL в колонке = сделку ещё не синкали после миграции 0036 (обычный ETL
 * обновляет только изменившиеся сделки) — такие в сверку не попадают вовсе,
 * иначе пустое зеркало читалось бы как «в карточке ничего не стоит».
 */
async function fetchKommoSlots(
  leadIds: number[],
  from: string,
  to: string,
): Promise<Map<number, KommoSlot[]>> {
  const out = new Map<number, KommoSlot[]>();
  if (leadIds.length === 0) return out;

  const rows = unwrapRows<{ leadId: string | number; slots: unknown }>(
    await analyticsDb.execute(sql`
      SELECT lead_id AS "leadId", roleplay_slots AS "slots"
      FROM analytics.leads_cohort
      WHERE lead_id IN (${sql.raw(leadIds.join(","))})
        AND roleplay_slots IS NOT NULL
    `),
  );

  for (const r of rows) {
    if (!Array.isArray(r.slots)) continue;
    const slots: KommoSlot[] = [];
    for (const raw of r.slots as Array<Record<string, unknown>>) {
      const date = typeof raw.date === "string" ? raw.date : null;
      if (!date || date < from || date > to) continue;
      slots.push({
        side: raw.side === "aa" ? "aa" : "dc",
        attempt: Number(raw.attempt) || 1,
        score: typeof raw.score === "number" ? raw.score : null,
        date,
      });
    }
    if (slots.length) out.set(Number(r.leadId), slots);
  }
  return out;
}

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
