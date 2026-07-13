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
import { B2G_PIPELINES, type Vertical } from "@/lib/kommo/pipeline-config";

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
  /** YYYY-MM-DD (берлинская дата) — термин сделки в Kommo (АА, иначе ДЦ), либо null. */
  terminDate: string | null;
  bucket: DocflowUsageBucket;
}

/** Один лид когорты воронки — прошёл этап «принят от 1-й линии» за период. */
export interface DocflowFunnelRow {
  leadId: number;
  leadName: string | null;
  filledAnketa: boolean; // завёл клиента в BGS DocFlow (= заполнил анкету)
  responded: boolean; // хотя бы один отправленный отклик
}

/**
 * Воронка использования сервиса по когорте лидов, прошедших этап «Принято от
 * первой линии» (Бух Бератер) за период — по дате перехода в статус:
 *   accepted → заполнили анкету → откликнулись.
 * Регистрация в сервисе отдельно не трекается: клиент в BGS_DocFlow создаётся
 * ровно при заполнении анкеты (backend/app/api/routes/submissions.py), так что
 * «зарегался» = «заполнил анкету» — одна ступень.
 */
export interface DocflowFunnel {
  label: string;
  acceptedFromFirst: number;
  filledAnketa: number;
  responded: number;
  cohort: DocflowFunnelRow[];
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
  /** Воронка «принят от 1-й линии → анкета → отклик» под выбранную вертикаль
   *  (buh → Бух, med → Мед, all → объединённая Бух+Мед). Массив из ≤1 элемента;
   *  пусто при сбое. */
  funnels: DocflowFunnel[];
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
    funnels: [],
  };
}

function bucketFor(sentCount: number): DocflowUsageBucket {
  if (sentCount === 0) return "unused";
  if (sentCount === 1) return "one";
  return "many";
}

export interface LeadTerminInfo {
  terminDate: string | null; // YYYY-MM-DD (берлинская дата)
  done: boolean; // термин уже прошёл
}

/** Термин (АА, иначе ДЦ) по каждому лиду — дата + прошёл ли уже, одним запросом. */
async function resolveTerminInfo(leadIds: number[]): Promise<Map<number, LeadTerminInfo>> {
  const out = new Map<number, LeadTerminInfo>();
  const ids = Array.from(new Set(leadIds.filter((n) => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) return out;
  try {
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    const data = rows<{ lead_id: string | number; termin_date: string | null; is_done: boolean }>(
      await analyticsDb.execute(sql`
        SELECT lead_id,
               to_char(termin, 'YYYY-MM-DD') AS termin_date,
               COALESCE(termin::date < ((now() AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date, false) AS is_done
        FROM (
          SELECT lead_id,
                 (MAX(COALESCE(aa_termin_date, termin_date)) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin' AS termin
          FROM analytics.leads_cohort
          WHERE lead_id IN (${idList})
          GROUP BY lead_id
        ) t
      `),
    );
    for (const r of data) {
      const id = Number(r.lead_id);
      if (Number.isInteger(id)) {
        out.set(id, { terminDate: r.termin_date, done: Boolean(r.is_done) });
      }
    }
  } catch (e) {
    console.error(
      "[docflow] resolveTerminInfo failed (non-fatal, treated as none done):",
      e instanceof Error ? e.message : e,
    );
  }
  return out;
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

/**
 * Воронка по когорте лидов, переданных на 2-ю линию (пайплайны `pipelineIds`,
 * Бератер) за берлинский период [from, to]. Из этой когорты считаем, сколько
 * завели анкету в BGS DocFlow и сколько откликнулись. Для вертикали «Все»
 * передаётся несколько пайплайнов (Бух + Мед) — когорта объединённая, одна воронка.
 *
 * «Принято от первой линии» = СОЗДАНИЕ Бератер-сделки (leads_cohort.created_at)
 * в периоде — так же, как это считает вкладка Воронка (overview.ts, bl.createdAt).
 * Событие статуса RECEIVED_FROM_FIRST (93860331) для этого НЕ годится: при
 * автопереходе из «Термин ДЦ» Kommo создаёт Бератер-сделку сразу в этом статусе
 * и события смены статуса не пишет — 63 лида в lead_status_changes отсутствуют
 * вовсе, а у остальных первое событие («Доведение») сдвигает дату. Сверено на
 * 2026-06-11..07-10: created_at даёт 243 (как Воронка) против 247 по event_at.
 * Уважаем те же фильтры аналитики, что и Воронка (exclude_from_analytics/is_deleted).
 *
 * `sentByLeadId` — карта kommo_lead_id → число отправленных откликов (за всё
 * время), собранная из уже загруженных clients (переиспользуем, чтобы не
 * ходить в БД DocFlow повторно). Наличие ключа = у лида есть клиент = анкета
 * заполнена; значение > 0 = откликался. Graceful: пустая когорта при сбое.
 */
async function computeFunnel(
  label: string,
  pipelineIds: number[],
  from: string,
  to: string,
  sentByLeadId: Map<number, number>,
): Promise<DocflowFunnel> {
  const empty: DocflowFunnel = {
    label,
    acceptedFromFirst: 0,
    filledAnketa: 0,
    responded: 0,
    cohort: [],
  };
  try {
    const pipelineList = sql.join(pipelineIds.map((id) => sql`${id}`), sql`, `);
    const cohortRaw = rows<{ lead_id: string | number }>(
      await analyticsDb.execute(sql`
        SELECT lead_id
        FROM analytics.leads_cohort
        WHERE pipeline_id IN (${pipelineList})
          AND exclude_from_analytics = FALSE
          AND is_deleted = FALSE
          AND (created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin' >= ${from}::date
          AND (created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin' < (${to}::date + 1)
      `),
    );
    const leadIds: number[] = [];
    for (const r of cohortRaw) {
      const id = Number(r.lead_id);
      if (Number.isInteger(id) && id > 0) leadIds.push(id);
    }
    if (leadIds.length === 0) return empty;

    const names = await resolveLeadNames(leadIds);
    let filledAnketa = 0;
    let responded = 0;
    const cohort: DocflowFunnelRow[] = leadIds.map((leadId) => {
      const hasClient = sentByLeadId.has(leadId);
      const didRespond = (sentByLeadId.get(leadId) ?? 0) > 0;
      if (hasClient) filledAnketa++;
      if (didRespond) responded++;
      return {
        leadId,
        leadName: names.get(leadId) ?? null,
        filledAnketa: hasClient,
        responded: didRespond,
      };
    });

    return {
      label,
      acceptedFromFirst: leadIds.length,
      filledAnketa,
      responded,
      cohort,
    };
  } catch (e) {
    console.error(
      "[docflow] computeFunnel failed (non-fatal, empty funnel):",
      e instanceof Error ? e.message : e,
    );
    return empty;
  }
}

export interface GetDocflowStatsArgs {
  /** YYYY-MM-DD включительно (берлинская гражд. дата). Фильтрует sent_at откликов. */
  from: string;
  to: string;
  /** Вертикаль b2g (Бух/Мед/Все) — какие воронки Бератер показать. Дефолт buh.
   *  «all» → обе воронки ОТДЕЛЬНЫМИ блоками, цифры не суммируются. */
  vertical?: Vertical;
}

export async function getDocflowStats(args: GetDocflowStatsArgs): Promise<DocflowStats> {
  const { from, to, vertical = "buh" } = args;
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
    // kommo_lead_id → сумма отправленных откликов (для воронки: наличие ключа =
    // анкета заполнена, значение > 0 = откликался). Дубли клиентов на один лид
    // суммируем (submissions.py допускает повторную анкету при потере ссылки).
    const sentByLeadId = new Map<number, number>();
    for (const r of clientRows) {
      const clientId = Number(r.id);
      const leadId = r.kommo_lead_id != null ? Number(r.kommo_lead_id) : NaN;
      if (Number.isInteger(leadId) && leadId > 0) {
        leadByClientId.set(clientId, leadId);
        allLeadIds.push(leadId);
        sentByLeadId.set(leadId, (sentByLeadId.get(leadId) ?? 0) + (Number(r.sent_cnt) || 0));
      }
    }

    // Воронка «принят от 1-й линии → анкета → отклик» по выбранной вертикали.
    // «all» → ОДНА общая воронка по объединённой когорте Бух + Мед Бератер.
    const funnelTask =
      vertical === "med"
        ? computeFunnel("Мед Бератер", [B2G_PIPELINES.MED_BERATER], from, to, sentByLeadId)
        : vertical === "all"
          ? computeFunnel(
              "Бух + Мед Бератер",
              [B2G_PIPELINES.BERATER, B2G_PIPELINES.MED_BERATER],
              from,
              to,
              sentByLeadId,
            )
          : computeFunnel("Бух Бератер", [B2G_PIPELINES.BERATER], from, to, sentByLeadId);

    const [terminByLeadId, names, funnel] = await Promise.all([
      resolveTerminInfo(allLeadIds),
      resolveLeadNames(allLeadIds),
      funnelTask,
    ]);
    const funnels = [funnel];

    const total = clientRows.length;
    let done = 0;
    for (const leadId of leadByClientId.values()) {
      if (terminByLeadId.get(leadId)?.done) done++;
    }
    const inProgress = total - done;

    const usage: DocflowUsageBuckets = { unused: 0, one: 0, many: 0 };
    const clientsList: DocflowClientUsageRow[] = clientRows.map((r) => {
      const leadId = leadByClientId.get(Number(r.id)) ?? null;
      const sentCount = Number(r.sent_cnt) || 0;
      const bucket = bucketFor(sentCount);
      usage[bucket]++;
      const termin = leadId != null ? terminByLeadId.get(leadId) : undefined;
      return {
        leadId,
        leadName: leadId != null ? names.get(leadId) ?? null : null,
        sentCount,
        done: termin?.done ?? false,
        terminDate: termin?.terminDate ?? null,
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
      funnels,
    };
  } catch (e) {
    console.error(
      "[docflow] getDocflowStats failed (non-fatal):",
      e instanceof Error ? e.message : e,
    );
    return emptyStats(range);
  }
}
