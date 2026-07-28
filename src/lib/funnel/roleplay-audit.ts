/**
 * Таблица «Ролевки» (Воронка → режим «Клиенты», третий блок).
 *
 * Отвечает на цепочку вопросов по каждой Бератер-сделке с термином в периоде:
 *   звонили ли клиенту → провели ли ролевку → оценил ли её бот → совпадает ли
 *   это с тем, что менеджер выставил руками в карточке Kommo.
 *
 * Источники (все read-only):
 *   analytics.leads_cohort      — сделка, термины ДЦ/АА, ответственный,
 *                                 roleplay_slots (ручные оценки Kommo, 0036);
 *   analytics.client_roleplays  — зеркало клиентских оценок ОКК (0035): все
 *                                 консультационные звонки, включая те, где
 *                                 ролевку не проводили (manager_conducted);
 *   analytics.communications    — сколько всего было соединённых звонков;
 *   master_managers (D1)        — каноничное имя ответственного.
 *
 * Строка = сделка, стороны ДЦ/АА — подколонки (решение пользователя 28.07).
 * Детализация по одной сделке — getRoleplayAuditDetail (отдельный запрос, чтобы
 * не тащить в таблицу разбор по вопросам банка: он тяжёлый).
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { db } from "@/lib/db/index";
import { getBeraterPipelineIds, type Vertical } from "@/lib/kommo/pipeline-config";
import type { RoleplaySlot } from "@/lib/db/schema-analytics";
import { unwrapRows } from "./compute";
import { getLeadNames } from "./clients";

export type Side = "dc" | "aa";
/** Почему у состоявшейся ролевки нет балла. */
export type NotScoredKind = "insufficient" | "degenerate";

export interface BotAttempt {
  attempt: number | null;
  score5: number | null;
  at: string | null; // ISO звонка
  managerName: string | null;
  /** null = оценена; иначе причина отсутствия балла. */
  notScored: NotScoredKind | null;
}

export interface SideAudit {
  terminIso: string | null;
  /** Термин этой стороны попал в фильтр периода. */
  inRange: boolean;
  /**
   * Слоты Kommo по этой сделке известны (leads_cohort.roleplay_slots не NULL).
   * FALSE = сделку не пересинкали после миграции 0036 → сравнивать не с чем,
   * расхождения не считаем (иначе «нет данных» выглядело бы как «не выставлено»).
   */
  kommoKnown: boolean;
  /** Консультационных звонков этой стороны, разобранных ОКК. */
  callsOkk: number;
  /** Из них с проведённой ролевкой. */
  conducted: number;
  /** Из проведённых — оценено ботом. */
  scored: number;
  /** Заполнено слотов в карточке Kommo. */
  kommoFilled: number;
  notScored: Record<NotScoredKind, number>;
  bot: BotAttempt[];
  kommo: RoleplaySlot[];
  /** Ролевок провели не столько, сколько выставлено в Kommo. */
  countMismatch: boolean;
  /** Балл бота ≠ балл в Kommo (по сопоставлению дат) либо пара не нашлась. */
  scoreMismatch: boolean;
}

export interface RoleplayAuditRow {
  leadId: number;
  name: string;
  managerName: string | null;
  status: string | null;
  /** Все соединённые звонки по сделке. */
  callsTotal: number;
  /** Из них разобрано ОКК как консультации (ДЦ+АА). */
  callsOkk: number;
  dc: SideAudit;
  aa: SideAudit;
}

export interface RoleplayAuditTotals {
  leads: number;
  conducted: number;
  scored: number;
  kommoFilled: number;
  notScored: Record<NotScoredKind, number>;
  countMismatchLeads: number;
  scoreMismatchLeads: number;
}

export interface RoleplayAuditResult {
  rows: RoleplayAuditRow[];
  totals: RoleplayAuditTotals;
  /** Сколько строк отсеклось лимитом (0 = показано всё). */
  truncated: number;
}

export interface RoleplayAuditParams {
  terminFrom: string; // YYYY-MM-DD
  terminTo: string | null; // null = открытый край «с даты и дальше»
  vertical?: Vertical;
}

interface BaseRow {
  leadId: string | number;
  status: string | null;
  responsibleUserId: string | number | null;
  terminDate: string | Date | null;
  aaTerminDate: string | Date | null;
  dcInRange: boolean;
  aaInRange: boolean;
  roleplaySlots: RoleplaySlot[] | null;
}

interface MirrorRow {
  leadId: string | number;
  side: string;
  attempt: number | null;
  score5: number | null;
  roleplayAt: string | null;
  managerName: string | null;
  gateReason: string | null;
  managerConducted: boolean;
}

/** Классификация причины, по которой у состоявшейся ролевки нет балла. */
export function classifyNotScored(gateReason: string | null): NotScoredKind {
  return gateReason && /degenerate/i.test(gateReason) ? "degenerate" : "insufficient";
}

function emptySide(terminIso: string | null, inRange: boolean, kommoKnown: boolean): SideAudit {
  return {
    terminIso,
    inRange,
    kommoKnown,
    callsOkk: 0,
    conducted: 0,
    scored: 0,
    kommoFilled: 0,
    notScored: { insufficient: 0, degenerate: 0 },
    bot: [],
    kommo: [],
    countMismatch: false,
    scoreMismatch: false,
  };
}

function toIso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** YYYY-MM-DD (Berlin) из ISO — для сопоставления с датой слота Kommo. */
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

/** Разница дат в днях по гражданскому календарю (обе — YYYY-MM-DD). */
function dayDiff(a: string, b: string): number {
  return Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/**
 * Сопоставление «оценка бота ↔ слот Kommo» ПО ДАТЕ (±1 день), а не по номеру.
 *
 * Номер у бота — порядковый среди состоявшихся ролевок; номер слота в Kommo
 * выбирает менеджер руками. Сравнение «слот 1 ↔ попытка 1» в лоб давало бы
 * ложные расхождения на любом сдвиге. Несопоставленное с обеих сторон —
 * тоже расхождение (ролевка без записи / запись без ролевки).
 */
function detectScoreMismatch(bot: BotAttempt[], kommo: RoleplaySlot[]): boolean {
  const freeSlots = kommo.map((s) => ({ slot: s, used: false }));
  let unmatchedBot = 0;

  for (const b of bot) {
    if (b.score5 === null) continue; // нечего сверять — бот не оценил
    const day = berlinDay(b.at);
    let hit: (typeof freeSlots)[number] | undefined;
    if (day) {
      hit = freeSlots.find((s) => !s.used && s.slot.date !== null && dayDiff(s.slot.date, day) <= 1);
    }
    if (!hit) {
      unmatchedBot++;
      continue;
    }
    hit.used = true;
    if (hit.slot.score !== b.score5) return true;
  }
  const unmatchedSlots = freeSlots.filter((s) => !s.used && s.slot.score !== null).length;
  return unmatchedBot > 0 || unmatchedSlots > 0;
}

export async function computeRoleplayAudit(
  params: RoleplayAuditParams,
  limit = 300,
): Promise<RoleplayAuditResult> {
  const { terminFrom, terminTo, vertical } = params;
  const beraterIds = getBeraterPipelineIds(vertical);

  // Термин лежит как берлинская полночь в UTC — гражданскую дату берём в
  // Berlin (CLAUDE.md #1), иначе термин уезжает на день (кейс 87 vs 88).
  const dcDate = sql`((termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date`;
  const aaDate = sql`((aa_termin_date AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date`;
  const dcCond = terminTo
    ? sql`(${dcDate} >= ${terminFrom}::date AND ${dcDate} <= ${terminTo}::date)`
    : sql`(${dcDate} >= ${terminFrom}::date)`;
  const aaCond = terminTo
    ? sql`(${aaDate} >= ${terminFrom}::date AND ${aaDate} <= ${terminTo}::date)`
    : sql`(${aaDate} >= ${terminFrom}::date)`;

  // Фильтр строго по термину: закрытые и выигранные сделки тоже интересны —
  // ролевки по ним уже провели, и именно их полноту мы проверяем.
  const baseRows = unwrapRows<BaseRow>(
    await analyticsDb.execute(sql`
      SELECT
        lead_id             AS "leadId",
        status              AS "status",
        responsible_user_id AS "responsibleUserId",
        termin_date         AS "terminDate",
        aa_termin_date      AS "aaTerminDate",
        roleplay_slots      AS "roleplaySlots",
        ${dcCond} AS "dcInRange",
        ${aaCond} AS "aaInRange"
      FROM analytics.leads_cohort
      WHERE pipeline_id IN (${sql.join(beraterIds.map((id) => sql`${id}`), sql`, `)})
        AND is_deleted = FALSE
        AND exclude_from_analytics = FALSE
        AND (${dcCond} OR ${aaCond})
      ORDER BY COALESCE(termin_date, aa_termin_date) DESC
    `),
  );

  if (baseRows.length === 0) {
    return {
      rows: [],
      totals: {
        leads: 0,
        conducted: 0,
        scored: 0,
        kommoFilled: 0,
        notScored: { insufficient: 0, degenerate: 0 },
        countMismatchLeads: 0,
        scoreMismatchLeads: 0,
      },
      truncated: 0,
    };
  }

  const ids = baseRows.map((r) => Number(r.leadId));
  const [mirror, callsByLead, names, roster] = await Promise.all([
    fetchMirror(ids),
    fetchConnectedCalls(ids),
    getLeadNames(ids),
    fetchManagerNames(),
  ]);

  const rows: RoleplayAuditRow[] = [];
  for (const r of baseRows) {
    const leadId = Number(r.leadId);
    const uid = r.responsibleUserId === null ? null : Number(r.responsibleUserId);
    // NULL = сделку не синкали после 0036 (нет данных), [] = синкали, слотов нет.
    const kommoKnown = Array.isArray(r.roleplaySlots);
    const slots = kommoKnown ? (r.roleplaySlots as RoleplaySlot[]) : [];
    const dc = buildSide(
      toIso(r.terminDate),
      r.dcInRange === true,
      kommoKnown,
      mirror.get(leadId)?.filter((m) => m.side === "dc") ?? [],
      slots.filter((s) => s.side === "dc"),
    );
    const aa = buildSide(
      toIso(r.aaTerminDate),
      r.aaInRange === true,
      kommoKnown,
      mirror.get(leadId)?.filter((m) => m.side === "aa") ?? [],
      slots.filter((s) => s.side === "aa"),
    );
    rows.push({
      leadId,
      name: names.get(leadId) ?? `Лид #${leadId}`,
      managerName: uid !== null ? (roster.get(uid) ?? null) : null,
      status: r.status,
      callsTotal: callsByLead.get(leadId) ?? 0,
      callsOkk: dc.callsOkk + aa.callsOkk,
      dc,
      aa,
    });
  }

  const totals: RoleplayAuditTotals = {
    leads: rows.length,
    conducted: 0,
    scored: 0,
    kommoFilled: 0,
    notScored: { insufficient: 0, degenerate: 0 },
    countMismatchLeads: 0,
    scoreMismatchLeads: 0,
  };
  for (const row of rows) {
    for (const side of [row.dc, row.aa]) {
      totals.conducted += side.conducted;
      totals.scored += side.scored;
      totals.kommoFilled += side.kommoFilled;
      totals.notScored.insufficient += side.notScored.insufficient;
      totals.notScored.degenerate += side.notScored.degenerate;
    }
    if (row.dc.countMismatch || row.aa.countMismatch) totals.countMismatchLeads += 1;
    if (row.dc.scoreMismatch || row.aa.scoreMismatch) totals.scoreMismatchLeads += 1;
  }

  const shown = rows.slice(0, limit);
  return { rows: shown, totals, truncated: rows.length - shown.length };
}

function buildSide(
  terminIso: string | null,
  inRange: boolean,
  kommoKnown: boolean,
  mirrorRows: MirrorRow[],
  kommoSlots: RoleplaySlot[],
): SideAudit {
  const side = emptySide(terminIso, inRange, kommoKnown);
  side.callsOkk = mirrorRows.length;
  side.kommo = [...kommoSlots].sort((a, b) => a.attempt - b.attempt);
  side.kommoFilled = kommoSlots.filter((s) => s.score !== null || s.date !== null).length;

  const conducted = mirrorRows
    .filter((m) => m.managerConducted)
    .sort((a, b) => (a.roleplayAt ?? "").localeCompare(b.roleplayAt ?? ""));
  side.conducted = conducted.length;

  for (const m of conducted) {
    const notScored = m.score5 === null ? classifyNotScored(m.gateReason) : null;
    if (notScored) side.notScored[notScored] += 1;
    else side.scored += 1;
    side.bot.push({
      attempt: m.attempt,
      score5: m.score5,
      at: m.roleplayAt ? new Date(m.roleplayAt).toISOString() : null,
      managerName: m.managerName,
      notScored,
    });
  }

  // Без данных из Kommo сравнивать не с чем — «нет данных» ≠ «не выставлено».
  side.countMismatch = kommoKnown && side.conducted !== side.kommoFilled;
  side.scoreMismatch = kommoKnown && detectScoreMismatch(side.bot, side.kommo);
  return side;
}

/** Зеркало ролевок по сделкам: все консультационные звонки, обе стороны. */
async function fetchMirror(leadIds: number[]): Promise<Map<number, MirrorRow[]>> {
  const out = new Map<number, MirrorRow[]>();
  if (leadIds.length === 0) return out;
  const rows = unwrapRows<MirrorRow>(
    await analyticsDb.execute(sql`
      SELECT lead_id            AS "leadId",
             side               AS "side",
             attempt            AS "attempt",
             score_5            AS "score5",
             roleplay_at::text  AS "roleplayAt",
             manager_name       AS "managerName",
             gate_reason        AS "gateReason",
             manager_conducted  AS "managerConducted"
      FROM analytics.client_roleplays
      WHERE lead_id IN (${sql.raw(leadIds.join(","))})
      ORDER BY lead_id, side, roleplay_at
    `),
  );
  for (const r of rows) {
    const id = Number(r.leadId);
    const list = out.get(id);
    if (list) list.push(r);
    else out.set(id, [r]);
  }
  return out;
}

/**
 * Соединённые звонки по сделке (call_status=4), COUNT(DISTINCT communication_id)
 * — Pattern A fanout иначе двоит (CLAUDE.md #4). Без ограничения по датам:
 * интересна вся история общения по конкретной Бератер-сделке, а она живёт
 * ровно фазу консультаций.
 */
async function fetchConnectedCalls(leadIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (leadIds.length === 0) return out;
  const rows = unwrapRows<{ leadId: string | number; n: string | number }>(
    await analyticsDb.execute(sql`
      SELECT lead_id AS "leadId", COUNT(DISTINCT communication_id) AS "n"
      FROM analytics.communications
      WHERE lead_id IN (${sql.raw(leadIds.join(","))})
        AND communication_type IN ('call_in', 'call_out')
        AND call_status = 4
      GROUP BY lead_id
    `),
  );
  for (const r of rows) out.set(Number(r.leadId), Number(r.n) || 0);
  return out;
}

// ── Детализация по одной сделке ──────────────────────────────────────────────

/** Русские подписи 6 критериев клиентской ролевки (OKK criteria-config.json). */
export const CLIENT_RP_CRITERIA: Record<string, string> = {
  selbstpraesentation: "Самопрезентация (о себе)",
  fachkenntnis: "Знание курса",
  argumentation: "Аргументация",
  einwandbehandlung: "Работа с возражениями",
  ablehnungsszenario: "Сценарий отказа",
  sprachkompetenz: "Немецкая речь",
};

export interface CriterionScore {
  coverage: number;
  quality: number;
  score: number;
  applicable: boolean;
  weight: number;
}

export interface QuestionResult {
  question_id: string;
  question_topic: string;
  criterion: string;
  asked: boolean;
  self_produced: boolean;
  covered: boolean;
  is_ideal: boolean;
  answer_strength: string | null;
  grammar_quality: number;
  problem_type: string | null;
  quote: string;
}

export interface RoleplayCallDetail {
  okkCallId: string;
  side: Side;
  attempt: number | null;
  at: string | null;
  managerName: string | null;
  durationSeconds: number | null;
  /** false = менеджер ролевку не проводил (звонок был, ролевки не было). */
  conducted: boolean;
  score5: number | null;
  scorePercent: number | null;
  notScored: NotScoredKind | null;
  gateReason: string | null;
  criterionScores: Record<string, CriterionScore> | null;
  questions: QuestionResult[] | null;
}

/**
 * Полная детализация ролевок сделки — для drawer'а под таблицей.
 * Отдельным запросом: question_coverage весит десятки КБ на звонок, в списке
 * из сотен сделок это неподъёмный payload.
 */
export async function getRoleplayAuditDetail(leadId: number): Promise<RoleplayCallDetail[]> {
  if (!Number.isInteger(leadId) || leadId <= 0) return [];
  const rows = unwrapRows<{
    okkCallId: string;
    side: string;
    attempt: number | null;
    at: string | null;
    managerName: string | null;
    durationSeconds: number | null;
    conducted: boolean;
    score5: number | null;
    scorePercent: number | null;
    gateReason: string | null;
    criterionScores: Record<string, CriterionScore> | null;
    questions: QuestionResult[] | null;
  }>(
    await analyticsDb.execute(sql`
      SELECT okk_call_id::text  AS "okkCallId",
             side               AS "side",
             attempt            AS "attempt",
             roleplay_at::text  AS "at",
             manager_name       AS "managerName",
             duration_seconds   AS "durationSeconds",
             manager_conducted  AS "conducted",
             score_5            AS "score5",
             score_percent      AS "scorePercent",
             gate_reason        AS "gateReason",
             criterion_scores   AS "criterionScores",
             question_coverage  AS "questions"
      FROM analytics.client_roleplays
      WHERE lead_id = ${leadId}
      ORDER BY roleplay_at NULLS LAST
    `),
  );
  return rows.map((r) => ({
    okkCallId: r.okkCallId,
    side: r.side === "aa" ? "aa" : "dc",
    attempt: r.attempt,
    at: r.at ? new Date(r.at).toISOString() : null,
    managerName: r.managerName,
    durationSeconds: r.durationSeconds,
    conducted: r.conducted === true,
    score5: r.score5,
    scorePercent: r.scorePercent,
    notScored: r.conducted && r.score5 === null ? classifyNotScored(r.gateReason) : null,
    gateReason: r.gateReason,
    criterionScores: r.criterionScores ?? null,
    questions: Array.isArray(r.questions) ? r.questions : null,
  }));
}

/** kommo_user_id → каноничное имя из master_managers (D1). */
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
