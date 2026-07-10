/**
 * Статистика сервиса BGS DocFlow (репо BGS_DocFlow, ОТДЕЛЬНЫЙ Neon) — сколько
 * учеников (клиентов школы) пользуется автоматизацией откликов на вакансии и
 * сколько получают ответы от работодателей.
 *
 * ЧТЕНИЕ НАПРЯМУЮ из Neon-БД сервиса через getDocflowDb() (read-only, мы туда
 * не пишем). Схема: backend/app/models/models.py в репо BGS_DocFlow —
 * clients.status ('new'|'active'|'paused'|'done'), applications.status
 * ('draft'|'sent'|'replied'|'no_reply') с sent_at/replied_at.
 * Нет DOCFLOW_DATABASE_URL / БД недоступна → available:false (graceful).
 *
 * ВАЖНО про clients.status: в коде BGS_DocFlow 'active'/'paused'/'done' никто
 * не проставляет (только дефолт 'new' при создании). Поэтому "завершил" здесь
 * считаем НЕ по этому полю, а по факту прошедшего термина сделки в НАШЕЙ
 * analytics (clients.kommo_lead_id → analytics.leads_cohort.termin_date /
 * aa_termin_date, см. docs/DASHBOARD-TERMIN.md): термин уже прошёл → клиент
 * закончил использовать сервис (решение по Gutschein принято). Клиенты без
 * привязанного лида или без записанного термина считаются «в работе».
 *
 * Имя лида для ссылки в Kommo дотягиваем из analytics.lead_contact_links →
 * contacts — тот же паттерн, что и в src/lib/broadcast/stats.ts.
 */
import { sql } from "drizzle-orm";
import { getDocflowDb } from "@/lib/db/docflow-db";
import { analyticsDb } from "@/lib/db/analytics";

/** Локальный распаковщик результата neon-http (массив либо {rows:[]}). */
function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const r = (result as { rows: unknown }).rows;
    if (Array.isArray(r)) return r as T[];
  }
  return [];
}

/** Сколько строк-заявок максимум отдаём (защита от гигантских ответов). */
const APPLICATIONS_CAP = 2000;

export interface DocflowDayPoint {
  day: string; // YYYY-MM-DD (берлинская гражданская дата)
  sent: number;
  replied: number;
}

export interface DocflowApplicationRow {
  sentAt: string; // ISO (UTC)
  day: string; // YYYY-MM-DD (берлинская дата, совпадает с группировкой графика)
  status: string; // sent | replied | no_reply
  company: string | null;
  position: string | null;
  leadId: number | null;
  leadName: string | null;
}

/** Сколько откликов клиент отправил за всё время — 3 бакета для «бублика». */
export interface DocflowUsageBuckets {
  unused: number; // 0 отправленных откликов
  one: number; // ровно 1
  many: number; // >1
}

export type DocflowUsageBucket = "unused" | "one" | "many";

/** Строка клиента для drill-модалки бублика — снимок по всему времени. */
export interface DocflowClientUsageRow {
  leadId: number | null;
  leadName: string | null;
  sentCount: number;
  done: boolean;
  bucket: DocflowUsageBucket;
}

export interface DocflowStats {
  available: boolean;
  range: { from: string; to: string };
  clients: { total: number; inProgress: number; done: number };
  usage: DocflowUsageBuckets;
  clientsList: DocflowClientUsageRow[];
  applications: { sent: number; replied: number; responseRate: number | null };
  days: DocflowDayPoint[];
  applicationsList: DocflowApplicationRow[];
  applicationsTruncated: boolean;
}

function emptyStats(range: { from: string; to: string }): DocflowStats {
  return {
    available: false,
    range,
    clients: { total: 0, inProgress: 0, done: 0 },
    usage: { unused: 0, one: 0, many: 0 },
    clientsList: [],
    applications: { sent: 0, replied: 0, responseRate: null },
    days: [],
    applicationsList: [],
    applicationsTruncated: false,
  };
}

function bucketFor(sentCount: number): DocflowUsageBucket {
  if (sentCount === 0) return "unused";
  if (sentCount === 1) return "one";
  return "many";
}

/** Лиды, у которых термин (АА, иначе ДЦ) уже прошёл — по берлинской гражд. дате. */
async function resolveDoneLeadIds(leadIds: number[]): Promise<Set<number>> {
  const done = new Set<number>();
  const ids = Array.from(new Set(leadIds.filter((n) => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) return done;
  try {
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    const data = rows<{ lead_id: string | number }>(
      await analyticsDb.execute(sql`
        SELECT lead_id
        FROM analytics.leads_cohort
        WHERE lead_id IN (${idList})
        GROUP BY lead_id
        HAVING (
          (MAX(COALESCE(aa_termin_date, termin_date)) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin'
        )::date < ((now() AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
      `),
    );
    for (const r of data) {
      const id = Number(r.lead_id);
      if (Number.isInteger(id)) done.add(id);
    }
  } catch (e) {
    console.error(
      "[docflow] resolveDoneLeadIds failed (non-fatal, treated as none done):",
      e instanceof Error ? e.message : e,
    );
  }
  return done;
}

/** Имя лида по kommo_lead_id из НАШЕЙ analytics (для ссылки в Kommo). Graceful: пусто при сбое. */
async function resolveLeadNames(leadIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = Array.from(new Set(leadIds.filter((n) => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) return out;
  try {
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    const data = rows<{ lead_id: string | number; name: string | null }>(
      await analyticsDb.execute(sql`
        SELECT l.lead_id, c.name
        FROM analytics.lead_contact_links l
        JOIN analytics.contacts c ON c.contact_id = l.contact_id
        WHERE l.lead_id IN (${idList})
          AND l.is_active = TRUE
          AND c.name IS NOT NULL
        ORDER BY l.first_seen_at
      `),
    );
    for (const r of data) {
      const id = Number(r.lead_id);
      if (Number.isInteger(id) && r.name && !out.has(id)) out.set(id, String(r.name));
    }
  } catch (e) {
    console.error(
      "[docflow] resolveLeadNames failed (non-fatal):",
      e instanceof Error ? e.message : e,
    );
  }
  return out;
}

export interface GetDocflowStatsArgs {
  /** YYYY-MM-DD включительно (берлинская гражд. дата). Фильтрует sent_at откликов. */
  from: string;
  to: string;
}

export async function getDocflowStats(args: GetDocflowStatsArgs): Promise<DocflowStats> {
  const { from, to } = args;
  const range = { from, to };
  const db = getDocflowDb();
  if (!db) return emptyStats(range);

  // Период применяется к sent_at по берлинской гражд. дате (CLAUDE.md #1: TZ везде).
  const inBerlinPeriod = sql`(sent_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin' >= ${from}::date
      AND (sent_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin' < (${to}::date + 1)`;

  try {
    const [clientsRaw, dayRaw, appListRaw] = await Promise.all([
      // Роспись клиентов — снимок по всему времени (не period-scoped), как
      // "здоровье доставки"/"сводка подписок" в Рассылке: это lifecycle-состояние.
      // sent_cnt — сколько откликов клиент отправил за всё время (для бублика).
      db.execute(sql`
        SELECT c.id, c.kommo_lead_id,
               count(a.id) FILTER (WHERE a.sent_at IS NOT NULL) AS sent_cnt
        FROM clients c
        LEFT JOIN applications a ON a.client_id = c.id
        GROUP BY c.id, c.kommo_lead_id
      `),
      db.execute(sql`
        SELECT to_char((sent_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') AS day,
               count(*) AS sent,
               count(*) FILTER (WHERE status = 'replied') AS replied
        FROM applications
        WHERE sent_at IS NOT NULL AND ${inBerlinPeriod}
        GROUP BY 1
        ORDER BY 1
      `),
      db.execute(sql`
        SELECT a.sent_at,
               to_char((a.sent_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') AS day,
               a.status, a.company, a.position, a.client_id
        FROM applications a
        WHERE a.sent_at IS NOT NULL AND ${inBerlinPeriod}
        ORDER BY a.sent_at DESC
        LIMIT ${APPLICATIONS_CAP + 1}
      `),
    ]);

    const clientRows = rows<{
      id: string | number;
      kommo_lead_id: string | number | null;
      sent_cnt: string | number;
    }>(clientsRaw);
    const leadByClientId = new Map<number, number>();
    const allLeadIds: number[] = [];
    for (const r of clientRows) {
      const clientId = Number(r.id);
      const leadId = r.kommo_lead_id != null ? Number(r.kommo_lead_id) : NaN;
      if (Number.isInteger(leadId) && leadId > 0) {
        leadByClientId.set(clientId, leadId);
        allLeadIds.push(leadId);
      }
    }

    const [doneLeadIds, names] = await Promise.all([
      resolveDoneLeadIds(allLeadIds),
      resolveLeadNames(allLeadIds),
    ]);

    const total = clientRows.length;
    let done = 0;
    for (const leadId of leadByClientId.values()) {
      if (doneLeadIds.has(leadId)) done++;
    }
    const inProgress = total - done;

    const usage: DocflowUsageBuckets = { unused: 0, one: 0, many: 0 };
    const clientsList: DocflowClientUsageRow[] = clientRows.map((r) => {
      const leadId = leadByClientId.get(Number(r.id)) ?? null;
      const sentCount = Number(r.sent_cnt) || 0;
      const bucket = bucketFor(sentCount);
      usage[bucket]++;
      return {
        leadId,
        leadName: leadId != null ? names.get(leadId) ?? null : null,
        sentCount,
        done: leadId != null && doneLeadIds.has(leadId),
        bucket,
      };
    });

    // Итоги за период — сумма по дням (dayRaw уже посчитан с тем же WHERE-фильтром
    // по sent_at; отдельный агрегирующий запрос на totals был бы дублем — #efficiency review).
    const dayRows = rows<{ day: string; sent: string | number; replied: string | number }>(dayRaw);
    let sent = 0;
    let replied = 0;
    for (const r of dayRows) {
      sent += Number(r.sent) || 0;
      replied += Number(r.replied) || 0;
    }

    const appListRows = rows<{
      sent_at: string;
      day: string;
      status: string;
      company: string | null;
      position: string | null;
      client_id: string | number;
    }>(appListRaw);
    const applicationsTruncated = appListRows.length > APPLICATIONS_CAP;
    const capped = appListRows.slice(0, APPLICATIONS_CAP);

    return {
      available: true,
      range,
      clients: { total, inProgress, done },
      usage,
      clientsList,
      applications: {
        sent,
        replied,
        responseRate: sent > 0 ? replied / sent : null,
      },
      days: dayRows.map((r) => ({
        day: String(r.day),
        sent: Number(r.sent) || 0,
        replied: Number(r.replied) || 0,
      })),
      applicationsList: capped.map((r) => {
        const leadId = leadByClientId.get(Number(r.client_id)) ?? null;
        return {
          sentAt: String(r.sent_at),
          day: String(r.day),
          status: String(r.status),
          company: r.company,
          position: r.position,
          leadId,
          leadName: leadId != null ? names.get(leadId) ?? null : null,
        };
      }),
      applicationsTruncated,
    };
  } catch (e) {
    console.error(
      "[docflow] getDocflowStats failed (non-fatal):",
      e instanceof Error ? e.message : e,
    );
    return emptyStats(range);
  }
}
