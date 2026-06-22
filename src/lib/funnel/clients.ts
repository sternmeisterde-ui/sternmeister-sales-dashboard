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
import { unwrapRows } from "./compute";
import { B2G_PIPELINES, BERATER_STATUSES } from "@/lib/kommo/pipeline-config";
import { getRoleplaysForLeads } from "./roleplays";
import { getBotRoleplaysForLeads } from "./bot-roleplays";
import {
  computeReadiness,
  type LanguageBucket,
  type ReadinessCategory,
  type ScoreFactor,
} from "./score";

const BERATER = B2G_PIPELINES.BERATER;
const KOMMO_BASE = "https://sternmeister.kommo.com/leads/detail";

/**
 * Фильтр по дате термина (YYYY-MM-DD, Berlin).
 *   terminTo = null → «с terminFrom и дальше» (termin >= terminFrom).
 *   terminTo задан → диапазон [terminFrom, terminTo].
 */
export interface ClientsParams {
  terminFrom: string;
  terminTo: string | null;
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
  /** Последняя самооценка готовности ботом (overall_readiness). */
  botLatestReadiness: string | null;
  /** Ответственный менеджер (имя из master_managers) или null. */
  managerName: string | null;
  /** Дней на текущей стадии Бератера (по последней смене статуса). */
  daysOnStage: number | null;
  /** Проведённых консультаций (статусы ДЦ/АА «проведена»). */
  consultations: number;
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

export interface ClientsResult {
  active: ClientGroup;
  won: ClientGroup;
}

type BaseRow = {
  leadId: string | number;
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
  botLatestReadiness: string | null;
  managerName: string | null;
  daysOnStage: number | null;
  consultations: number;
  score: number;
  category: ReadinessCategory;
  factors: ScoreFactor[];
}

export async function computeClients(
  params: ClientsParams,
  limit = 300
): Promise<ClientsResult> {
  const { terminFrom, terminTo } = params;
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
        status_id           AS "statusId",
        status              AS "status",
        language_level      AS "languageLevel",
        responsible_user_id AS "responsibleUserId",
        termin_date         AS "terminDate",
        aa_termin_date AS "aaTerminDate",
        ${dcCond} AS "dcInRange",
        ${aaCond} AS "aaInRange"
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${BERATER}
        AND is_deleted = FALSE
        AND exclude_from_analytics = FALSE
        AND status_id <> ${BERATER_STATUSES.LOST}
        AND (
          status_id = ${BERATER_STATUSES.WON}
          OR ${dcCond}
          OR ${aaCond}
        )
    `)
  );
  if (baseRows.length === 0) {
    return { active: emptyGroup(), won: emptyGroup() };
  }

  const ids = baseRows.map((r) => Number(r.leadId));
  const [roleplays, lastTouch, botRoleplays, roster, stageEntered, consults] =
    await Promise.all([
      getRoleplaysForLeads(ids),
      fetchLastTouchMap(ids),
      getBotRoleplaysForLeads(ids), // graceful no-op без BERATER_BOT_DATABASE_URL
      fetchManagerNames(),
      fetchCurrentStageEntered(ids),
      fetchConsultationCounts(ids),
    ]);

  const nowMs = Date.now();
  const activeScored: ScoredLead[] = [];
  const wonScored: ScoredLead[] = [];

  for (const r of baseRows) {
    const leadId = Number(r.leadId);
    const isWon = Number(r.statusId) === BERATER_STATUSES.WON;
    const dcInRange = r.dcInRange === true;

    const bucket = normalizeBucket(r.languageLevel);
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

    const readiness = computeReadiness({
      languageBucket: bucket,
      activeSide,
      activeAvg,
      daysSinceLastTouch: days,
      botRoleplayCount: botCount,
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
      botLatestReadiness: bot?.latestReadiness ?? null,
      managerName,
      daysOnStage,
      consultations,
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

  const names = await hydrateNames([
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
    botLatestReadiness: s.botLatestReadiness,
    managerName: s.managerName,
    daysOnStage: s.daysOnStage,
    consultations: s.consultations,
    score: s.score,
    category: s.category,
    factors: s.factors,
  };
}

function normalizeBucket(raw: string | null): LanguageBucket {
  if (!raw) return "unknown";
  const s = raw.trim().toUpperCase();
  if (s.startsWith("A1") || s.startsWith("A2")) return "a2";
  if (s.startsWith("B1")) return "b1";
  if (s.startsWith("B2")) return "b2";
  if (s.startsWith("C1") || s.startsWith("C2")) return "c1";
  return "unknown";
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

// Проведённых консультаций: входы в статусы ДЦ/АА «проведена».
async function fetchConsultationCounts(leadIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (leadIds.length === 0) return out;
  const idsIn = leadIds.join(",");
  const rows = unwrapRows<{ leadId: string | number; c: string | number }>(
    await analyticsDb.execute(sql`
      SELECT lead_id AS "leadId", count(*) AS "c"
      FROM analytics.lead_status_changes
      WHERE lead_id IN (${sql.raw(idsIn)})
        AND status_id IN (${BERATER_STATUSES.CONSULT_BEFORE_DC_DONE}, ${BERATER_STATUSES.CONSULT_BEFORE_AA_DONE})
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

async function hydrateNames(leadIds: number[]): Promise<Map<number, string>> {
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
