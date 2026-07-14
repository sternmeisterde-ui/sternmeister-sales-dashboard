/**
 * Таблица клиентов со score «готовности» (ТЗ §5.4).
 *
 * База = клиенты Бух Бератер, **отфильтрованные по дате термина**: показываем тех,
 * у кого ДЦ- или АА-термин попадает в выбранный диапазон (по умолчанию — сегодня).
 * Это операционный список «кого готовить к ближайшим терминам».
 *
 * Активная сторона = термин, попавший в диапазон (ДЦ если в диапазоне ДЦ-термин,
 * иначе АА). Готовность считаем по ролевке этой стороны (см. score.ts).
 *
 * Выигравшие Гутшайн (статус 142) — отдельная группа `won` (тоже по дате термина).
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { db } from "@/lib/db/index";
import { unwrapRows, languageBucketSql } from "./compute";
import {
  BERATER_STATUSES,
  MED_BERATER_STATUSES,
  getBeraterPipelineIds,
  getBeraterStatusSets,
  type Vertical,
} from "@/lib/kommo/pipeline-config";
import { getRoleplaysForLeads } from "./roleplays";
import { getBotRoleplaysForLeads, getRegisteredBotLeads } from "./bot-roleplays";
import { getOkkByLead } from "./okk-by-lead";
import {
  computeReadiness,
  type LanguageBucket,
  type ReadinessCategory,
  type ScoreFactor,
} from "./score";

const KOMMO_BASE = "https://sternmeister.kommo.com/leads/detail";

// «Стадия CRM» (ТЗ §7): позиция статуса Бератера по пути к Гутшайну → 0..100.
// Немапленные статусы (LOST и пр.) → фактор исключается из скоринга.
// Мед Бератер — структурное зеркало (те же позиции, свои id, spec 21).
const STAGE_SCORE: Record<number, number> = {
  [BERATER_STATUSES.RECEIVED_FROM_FIRST]: 15,
  [BERATER_STATUSES.DELAYED_START]: 18,
  [BERATER_STATUSES.DOVEDENIE]: 22,
  [BERATER_STATUSES.CONSULT_BEFORE_DC]: 35,
  [BERATER_STATUSES.TERM_DC_CANCELLED]: 40,
  [BERATER_STATUSES.CONSULT_BEFORE_DC_DONE]: 50,
  [BERATER_STATUSES.TERM_DC_DONE]: 60,
  [BERATER_STATUSES.CONSULT_BEFORE_AA]: 70,
  [BERATER_STATUSES.TERM_AA]: 75,
  [BERATER_STATUSES.TERM_AA_CANCELLED]: 65,
  [BERATER_STATUSES.CONSULT_BEFORE_AA_DONE]: 85,
  [BERATER_STATUSES.BERATER_REVIEW]: 90,
  [BERATER_STATUSES.APPEAL]: 55,
  [BERATER_STATUSES.WON]: 100,
  // Мед Бератер (14001515)
  [MED_BERATER_STATUSES.RECEIVED_FROM_FIRST]: 15,
  [MED_BERATER_STATUSES.DELAYED_START]: 18,
  [MED_BERATER_STATUSES.DOVEDENIE]: 22,
  [MED_BERATER_STATUSES.CONSULT_BEFORE_DC]: 35,
  [MED_BERATER_STATUSES.TERM_DC_CANCELLED]: 40,
  [MED_BERATER_STATUSES.CONSULT_BEFORE_DC_DONE]: 50,
  [MED_BERATER_STATUSES.TERM_DC_DONE]: 60,
  [MED_BERATER_STATUSES.CONSULT_BEFORE_AA]: 70,
  [MED_BERATER_STATUSES.TERM_AA_CANCELLED]: 65,
  [MED_BERATER_STATUSES.CONSULT_BEFORE_AA_DONE]: 85,
  [MED_BERATER_STATUSES.BERATER_REVIEW]: 90,
  [MED_BERATER_STATUSES.APPEAL]: 55,
};

/**
 * Фильтр по дате термина (YYYY-MM-DD, Berlin).
 *   terminTo = null → «с terminFrom и дальше» (termin >= terminFrom).
 *   terminTo задан → диапазон [terminFrom, terminTo].
 */
export interface ClientsParams {
  terminFrom: string;
  terminTo: string | null;
  /** Фильтр по уровням языка (мультивыбор). Пусто/undefined = без фильтра. */
  lang?: LanguageBucket[] | null;
  /** Вертикаль b2g (Бух/Мед/Все, spec 21). Без неё — Бух Бератер (legacy). */
  vertical?: Vertical;
}

export interface ClientSideReadiness {
  latest: number | null;
  avg: number | null;
  attempts: number[];
}

export interface ClientRow {
  leadId: number;
  name: string;
  kommoUrl: string;
  status: string | null;
  languageBucket: LanguageBucket;
  dc: ClientSideReadiness;
  aa: ClientSideReadiness;
  /** Дата термина (попавшего в диапазон). */
  terminAtIso: string | null;
  /** Есть ли термин (ДЦ/АА) в выбранном диапазоне = «актуальный» клиент.
   *  false у won-бэклога, попавшего только по статусу WON. */
  terminInRange: boolean;
  lastTouchAtIso: string | null;
  daysSinceLastTouch: number | null;
  /** Тренировок с ботом ролевок (репо berater_bot). */
  botRoleplayCount: number;
  /** Зарегистрирован ли клиент в боте (есть запись в analytics.bot_users). */
  botRegistered: boolean;
  /** Последняя самооценка готовности ботом (overall_readiness). */
  botLatestReadiness: string | null;
  /** Ответственный менеджер (имя из master_managers) или null. */
  managerName: string | null;
  /** Дней на текущей стадии Бератера (по последней смене статуса). */
  daysOnStage: number | null;
  /** Проведённых консультаций (статусы ДЦ/АА «проведена»). */
  consultations: number;
  /** Средний ОКК всех звонков сделки (0..100) или null. */
  okkDeal: number | null;
  score: number;
  category: ReadinessCategory;
  factors: ScoreFactor[];
}

export interface ClientGroup {
  clients: ClientRow[];
  total: number;
  shown: number;
  /** Разбивка ВСЕЙ группы (не только показанных) по категориям — для KPI. */
  categories: { hot: number; warm: number; cold: number };
}

/**
 * Совокупные средние готовности (последний балл ролевок стороны) по ВСЕМ
 * клиентам периода — ДЦ и АА отдельно. Берётся dc.latest/aa.latest (как колонки
 * ДЦ/АА в таблице — актуальная готовность), усредняется по полному набору
 * scored-лидов (active + won), не по усечённому до limit списку, поэтому не
 * зависит от пагинации/фильтров фронта. null → нет клиентов с ролевками стороны.
 */
export interface ClientsReadinessSummary {
  avgDc: number | null;
  avgAa: number | null;
  countDc: number; // клиентов с хотя бы одной ДЦ-ролевкой (dc.latest !== null)
  countAa: number;
}

export interface ClientsResult {
  active: ClientGroup;
  won: ClientGroup;
  summary: ClientsReadinessSummary;
}

type BaseRow = {
  leadId: string | number;
  pipelineId: string | number;
  statusId: string | number;
  status: string | null;
  languageLevel: string | null;
  responsibleUserId: string | number | null;
  terminDate: string | Date | null;
  aaTerminDate: string | Date | null;
  dcInRange: boolean | null;
  aaInRange: boolean | null;
};

interface ScoredLead {
  leadId: number;
  status: string | null;
  languageBucket: LanguageBucket;
  dc: ClientSideReadiness;
  aa: ClientSideReadiness;
  terminAtIso: string | null;
  terminInRange: boolean;
  lastTouchAtIso: string | null;
  daysSinceLastTouch: number | null;
  botRoleplayCount: number;
  botRegistered: boolean;
  botLatestReadiness: string | null;
  managerName: string | null;
  daysOnStage: number | null;
  consultations: number;
  okkDeal: number | null;
  score: number;
  category: ReadinessCategory;
  factors: ScoreFactor[];
}

export async function computeClients(
  params: ClientsParams,
  limit = 300
): Promise<ClientsResult> {
  const { terminFrom, terminTo, lang, vertical } = params;
  const beraterIds = getBeraterPipelineIds(vertical);
  const brStatus = getBeraterStatusSets(vertical);
  // Одна дата (terminTo == null) = «с этого числа и дальше» (>=); период = диапазон.
  const dcCond = terminTo
    ? sql`(termin_date::date >= ${terminFrom}::date AND termin_date::date <= ${terminTo}::date)`
    : sql`(termin_date::date >= ${terminFrom}::date)`;
  const aaCond = terminTo
    ? sql`(aa_termin_date::date >= ${terminFrom}::date AND aa_termin_date::date <= ${terminTo}::date)`
    : sql`(aa_termin_date::date >= ${terminFrom}::date)`;
  const baseRows = unwrapRows<BaseRow>(
    await analyticsDb.execute(sql`
      SELECT
        lead_id             AS "leadId",
        pipeline_id         AS "pipelineId",
        status_id           AS "statusId",
        status              AS "status",
        language_level      AS "languageLevel",
        responsible_user_id AS "responsibleUserId",
        termin_date         AS "terminDate",
        aa_termin_date AS "aaTerminDate",
        ${dcCond} AS "dcInRange",
        ${aaCond} AS "aaInRange"
      FROM analytics.leads_cohort
      WHERE pipeline_id IN (${sql.join(beraterIds.map((id) => sql`${id}`), sql`, `)})
        AND is_deleted = FALSE
        AND exclude_from_analytics = FALSE
        AND status_id <> 143
        AND (
          status_id = 142
          OR ${dcCond}
          OR ${aaCond}
        )
        ${languageBucketSql(lang)}
    `)
  );
  if (baseRows.length === 0) {
    return {
      active: emptyGroup(),
      won: emptyGroup(),
      summary: { avgDc: null, avgAa: null, countDc: 0, countAa: 0 },
    };
  }

  const ids = baseRows.map((r) => Number(r.leadId));
  const [roleplays, lastTouch, botRoleplays, botRegisteredSet, roster, stageEntered, consults, okkByLead] =
    await Promise.all([
      getRoleplaysForLeads(ids),
      fetchLastTouchMap(ids),
      getBotRoleplaysForLeads(ids), // graceful no-op без BERATER_BOT_DATABASE_URL
      getRegisteredBotLeads(ids), // кто зарегистрирован в боте (analytics.bot_users)
      fetchManagerNames(),
      fetchCurrentStageEntered(ids),
      fetchConsultationCounts(ids, [
        ...brStatus.consultBeforeDCDone,
        ...brStatus.consultBeforeAADone,
      ]),
      getOkkByLead(ids), // ОКК-агрегаты из D2
    ]);

  const nowMs = Date.now();
  // Без BERATER_BOT_DATABASE_URL бот-фактор не штрафует, а исключается (null).
  const botConfigured = !!process.env.BERATER_BOT_DATABASE_URL;
  // Бот ролевок — БУХОВЫЙ (у мед будет свой, решение юзера 2026-07-06):
  // мед-клиентам бот-факторы не даём вовсе (null → «нет данных», не штраф).
  const medBeraterIds = new Set(getBeraterPipelineIds("med"));
  const activeScored: ScoredLead[] = [];
  const wonScored: ScoredLead[] = [];

  for (const r of baseRows) {
    const leadId = Number(r.leadId);
    const isWon = Number(r.statusId) === BERATER_STATUSES.WON;
    const dcInRange = r.dcInRange === true;
    // Мед-клиент → буховый бот к нему неприменим (свой бот будет позже).
    const isMedLead = medBeraterIds.has(Number(r.pipelineId));
    const botApplies = botConfigured && !isMedLead;

    const bucket = normalizeBucket(r.languageLevel);
    // A1 = «не квал по языку» — в аналитику не идёт (как и в когортах).
    if (bucket === "a1") continue;
    const rp = roleplays.get(leadId);
    const dc = sideReadiness(rp?.dc);
    const aa = sideReadiness(rp?.aa);

    // Активная сторона: для выигравших — АА (их финальная подготовка до Гутшайна);
    // для активных — термин, попавший в диапазон (ДЦ приоритетнее как более ранний).
    const activeSide: "dc" | "aa" = isWon ? "aa" : dcInRange ? "dc" : "aa";
    const activeAvg = (activeSide === "aa" ? aa.avg : dc.avg) ?? null;
    const terminAtIso = toIso(dcInRange ? r.terminDate : r.aaTerminDate);

    const lastTouchIso = lastTouch.get(leadId) ?? null;
    const days =
      lastTouchIso === null
        ? null
        : Math.max(0, Math.floor((nowMs - Date.parse(lastTouchIso)) / 86_400_000));

    // Бот-ролевки — отдельная сущность от звонковых (их качество в dc/aa). Не склеиваем.
    const bot = botRoleplays.get(leadId);
    const botCount = bot?.count ?? 0;

    const uid = r.responsibleUserId === null ? null : Number(r.responsibleUserId);
    const managerName = uid !== null ? roster.get(uid) ?? null : null;
    const stageIso = stageEntered.get(leadId) ?? null;
    const daysOnStage =
      stageIso === null
        ? null
        : Math.max(0, Math.floor((nowMs - Date.parse(stageIso)) / 86_400_000));
    const consultations = consults.get(leadId) ?? 0;
    const okk = okkByLead.get(leadId);
    const crmStageScore = STAGE_SCORE[Number(r.statusId)] ?? null;

    const readiness = computeReadiness({
      languageBucket: bucket,
      activeSide,
      activeAvg,
      hasManagerRoleplay: dc.avg !== null || aa.avg !== null,
      daysSinceLastTouch: days,
      botRoleplayCount: botApplies ? botCount : null,
      botReadiness: botApplies ? bot?.latestReadiness ?? null : null,
      consultationDone: consultations > 0,
      dealOkk: okk?.dealOkk ?? null,
      crmStageScore,
    });

    const lead: ScoredLead = {
      leadId,
      status: r.status,
      languageBucket: bucket,
      dc,
      aa,
      terminAtIso,
      terminInRange: dcInRange || r.aaInRange === true,
      lastTouchAtIso: lastTouchIso,
      daysSinceLastTouch: days,
      botRoleplayCount: botCount,
      botRegistered: botRegisteredSet.has(leadId),
      botLatestReadiness: bot?.latestReadiness ?? null,
      managerName,
      daysOnStage,
      consultations,
      okkDeal: okk?.dealOkk ?? null,
      score: readiness.score,
      category: readiness.category,
      factors: readiness.factors,
    };
    (isWon ? wonScored : activeScored).push(lead);
  }

  wonScored.sort((a, b) => b.score - a.score);
  activeScored.sort((a, b) => b.score - a.score);
  const activeTop = activeScored.slice(0, limit);
  const wonTop = wonScored.slice(0, limit);

  const names = await getLeadNames([
    ...activeTop.map((s) => s.leadId),
    ...wonTop.map((s) => s.leadId),
  ]);

  return {
    active: {
      clients: activeTop.map((s) => toRow(s, names)),
      total: activeScored.length,
      shown: activeTop.length,
      categories: countCategories(activeScored),
    },
    won: {
      clients: wonTop.map((s) => toRow(s, names)),
      total: wonScored.length,
      shown: wonTop.length,
      categories: countCategories(wonScored),
    },
    // По ВСЕМ клиентам периода (active + won), а не по усечённым top.
    summary: summarizeReadiness([...activeScored, ...wonScored]),
  };
}

/** Совокупное среднее dc.latest / aa.latest по клиентам (null пропускаются). */
function summarizeReadiness(scored: ScoredLead[]): ClientsReadinessSummary {
  let dcSum = 0, dcN = 0, aaSum = 0, aaN = 0;
  for (const s of scored) {
    if (s.dc.latest !== null) { dcSum += s.dc.latest; dcN += 1; }
    if (s.aa.latest !== null) { aaSum += s.aa.latest; aaN += 1; }
  }
  return {
    avgDc: dcN > 0 ? Math.round((dcSum / dcN) * 10) / 10 : null,
    avgAa: aaN > 0 ? Math.round((aaSum / aaN) * 10) / 10 : null,
    countDc: dcN,
    countAa: aaN,
  };
}

function countCategories(scored: ScoredLead[]): {
  hot: number;
  warm: number;
  cold: number;
} {
  const c = { hot: 0, warm: 0, cold: 0 };
  for (const s of scored) c[s.category] += 1;
  return c;
}

function emptyGroup(): ClientGroup {
  return { clients: [], total: 0, shown: 0, categories: { hot: 0, warm: 0, cold: 0 } };
}

function toIso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toRow(s: ScoredLead, names: Map<number, string>): ClientRow {
  return {
    leadId: s.leadId,
    name: names.get(s.leadId) ?? `Лид #${s.leadId}`,
    kommoUrl: `${KOMMO_BASE}/${s.leadId}`,
    status: s.status,
    languageBucket: s.languageBucket,
    dc: s.dc,
    aa: s.aa,
    terminAtIso: s.terminAtIso,
    terminInRange: s.terminInRange,
    lastTouchAtIso: s.lastTouchAtIso,
    daysSinceLastTouch: s.daysSinceLastTouch,
    botRoleplayCount: s.botRoleplayCount,
    botRegistered: s.botRegistered,
    botLatestReadiness: s.botLatestReadiness,
    managerName: s.managerName,
    daysOnStage: s.daysOnStage,
    consultations: s.consultations,
    okkDeal: s.okkDeal,
    score: s.score,
    category: s.category,
    factors: s.factors,
  };
}

function normalizeBucket(raw: string | null): LanguageBucket {
  // Не указан / нераспознанное → A2 (минимум). A1 — отдельно (не квал по языку).
  if (!raw) return "a2";
  const s = raw.trim().toUpperCase();
  if (s.startsWith("A1")) return "a1";
  if (s.startsWith("B1")) return "b1";
  if (s.startsWith("B2")) return "b2";
  if (s.startsWith("C1") || s.startsWith("C2")) return "c1";
  return "a2";
}

function sideReadiness(
  side:
    | { latestScore5: number | null; avgScore5: number | null; attempts: Array<{ score5: number | null }> }
    | undefined
): ClientSideReadiness {
  if (!side) return { latest: null, avg: null, attempts: [] };
  return {
    latest: side.latestScore5,
    avg: side.avgScore5,
    attempts: side.attempts
      .map((a) => a.score5)
      .filter((s): s is number => s !== null),
  };
}

// Имена менеджеров (master_managers, D1) по kommo_user_id — для колонки «Менеджер».
async function fetchManagerNames(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const rows = unwrapRows<{ uid: string | number | null; name: string | null }>(
    await db.execute(sql`
      SELECT kommo_user_id AS "uid", name AS "name"
      FROM master_managers
      WHERE kommo_user_id IS NOT NULL
    `)
  );
  for (const r of rows) {
    if (r.uid === null || !r.name) continue;
    out.set(Number(r.uid), r.name);
  }
  return out;
}

// Вход в ТЕКУЩУЮ стадию = последняя смена статуса (max event_at) по сделке.
async function fetchCurrentStageEntered(leadIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (leadIds.length === 0) return out;
  const idsIn = leadIds.join(",");
  const rows = unwrapRows<{ leadId: string | number; entered: string | Date | null }>(
    await analyticsDb.execute(sql`
      SELECT lead_id AS "leadId", max(event_at) AS "entered"
      FROM analytics.lead_status_changes
      WHERE lead_id IN (${sql.raw(idsIn)}) AND event_at IS NOT NULL
      GROUP BY lead_id
    `)
  );
  for (const r of rows) {
    if (r.entered === null) continue;
    out.set(Number(r.leadId), toIso(r.entered) as string);
  }
  return out;
}

// Проведённых консультаций: входы в статусы ДЦ/АА «проведена» (vertical-aware).
async function fetchConsultationCounts(
  leadIds: number[],
  consultStatusIds: number[]
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (leadIds.length === 0 || consultStatusIds.length === 0) return out;
  const idsIn = leadIds.join(",");
  const rows = unwrapRows<{ leadId: string | number; c: string | number }>(
    await analyticsDb.execute(sql`
      SELECT lead_id AS "leadId", count(*) AS "c"
      FROM analytics.lead_status_changes
      WHERE lead_id IN (${sql.raw(idsIn)})
        AND status_id IN (${sql.raw(consultStatusIds.join(","))})
      GROUP BY lead_id
    `)
  );
  for (const r of rows) out.set(Number(r.leadId), Number(r.c) || 0);
  return out;
}

async function fetchLastTouchMap(leadIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (leadIds.length === 0) return out;
  const idsIn = leadIds.join(",");
  const rows = unwrapRows<{ leadId: string | number; lastTouch: string | Date | null }>(
    await analyticsDb.execute(sql`
      SELECT lead_id AS "leadId", max(created_at) AS "lastTouch"
      FROM analytics.communications
      WHERE lead_id IN (${sql.raw(idsIn)})
      GROUP BY lead_id
    `)
  );
  for (const r of rows) {
    if (r.lastTouch === null) continue;
    out.set(Number(r.leadId), toIso(r.lastTouch) as string);
  }
  return out;
}

export async function getLeadNames(leadIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (leadIds.length === 0) return out;
  const idsIn = leadIds.join(",");
  const rows = unwrapRows<{ leadId: string | number; contactName: string | null }>(
    await analyticsDb.execute(sql`
      SELECT l.lead_id AS "leadId", cn.name AS "contactName"
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
    `)
  );
  for (const r of rows) {
    const id = Number(r.leadId);
    const name = r.contactName?.trim();
    if (name) out.set(id, name);
  }
  return out;
}
