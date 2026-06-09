/**
 * Срез по менеджерам (ТЗ §5.7 / §9.5) — табло работы менеджеров в воронке.
 *
 * Роль менеджера на сделке выводим из «ответственный по воронке» + «линия
 * менеджера» (см. 02-доку §3.9), а НЕ из редких CRM-полей. Роли согласованы с
 * линиями вкладки «Аналитика»:
 *   qualifier  — ответственный Гос-сделки, линия 1
 *   berater    — ответственный линкованной Бератер-сделки, линия 2
 *   dovedenie  — то же, линия 3
 *
 * **Ростер менеджеров — `master_managers` (D1, источник правды):** включаем
 * только `department='b2g'` (не РОП). Это отсекает B2B-менеджеров и системных
 * юзеров (Rose), которые местами стоят ответственными за Гос-сделки, и даёт
 * каноничное имя (чинит дрейф Maksim/Максим) + линию.
 *
 * **Все 3 роли считаются за ОДИН проход** (путь клиента одинаков для всех ролей).
 * Средний ОКК — прямой запрос в D2 (готовый total_score, §7.5/§3.8), prompt_type
 * по роли, стык по kommo_user_id. Дисквалы исключены.
 *
 * v3 (опц.): колонка Hot/Warm/Cold по менеджеру.
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { db } from "@/lib/db/index";
import { d2OkkDb } from "@/lib/db/okk";
import { BERATER_STATUSES } from "@/lib/kommo/pipeline-config";
import {
  enrichDisqualifiedAt,
  fetchBeraterContext,
  fetchCloseReasonHistory,
  fetchQualifiedBaseLeads,
  fetchTargetEvents,
  processLeadForConversion,
  unwrapRows,
  type BeraterLead,
  type ComputeOpts,
} from "./compute";

const CONSULT_DONE_STATUSES = [
  BERATER_STATUSES.CONSULT_BEFORE_DC_DONE, // 102183939
  BERATER_STATUSES.CONSULT_BEFORE_AA_DONE, // 102183947
];

export type ManagerRoleKey = "qualifier" | "berater" | "dovedenie";

const ROLE_KEYS: ManagerRoleKey[] = ["qualifier", "berater", "dovedenie"];

/** Линия Бератер-ответственного для роли (berater/dovedenie). */
const ROLE_BERATER_LINE: Record<"berater" | "dovedenie", string> = {
  berater: "2",
  dovedenie: "3",
};

/** prompt_type ОКК-звонка → роль (см. 02 §3.8). */
const PROMPT_TYPE_ROLE: Record<string, ManagerRoleKey> = {
  d2_qualifier: "qualifier",
  d2_berater: "berater",
  d2_berater2: "berater",
  d2_dovedenie: "dovedenie",
};

export interface ManagerRow {
  userId: number | null;
  name: string;
  line: string | null;
  clients: number;
  reachedDocs: number;
  reachedTermDc: number;
  reachedGutschein: number;
  conversionC5Pct: number | null;
  touches: number;
  consultations: number;
  avgOkk: number | null;
  okkScored: number;
}

export interface ManagersResult {
  /** Готовые строки по каждой роли — фронт переключает мгновенно. */
  roles: Record<ManagerRoleKey, ManagerRow[]>;
  fromIso: string;
  toIso: string;
}

interface ManagerMeta {
  name: string;
  department: string;
  line: string | null;
  role: string | null;
}

interface Accum {
  clients: number;
  reachedDocs: number;
  reachedTermDc: number;
  reachedGutschein: number;
  touches: number;
  consultations: number;
}

type OkkAgg = Record<ManagerRoleKey, { sum: number; n: number }>;

export async function computeManagers(opts: ComputeOpts): Promise<ManagersResult> {
  // 1. Квал-база Бух Гос (та же, что у когорт; уважает period/source).
  const baseLeadsRaw = await fetchQualifiedBaseLeads(opts);
  const leadIds = baseLeadsRaw.map((l) => l.leadId);

  // 2. Параллельно: данные движка + касания + ОКК + ростер менеджеров.
  const [
    closeReasonHistory,
    targetEvents,
    beraterContext,
    touchesByLead,
    okkByUser,
    roster,
  ] = await Promise.all([
    leadIds.length ? fetchCloseReasonHistory(leadIds) : Promise.resolve(new Map()),
    leadIds.length ? fetchTargetEvents(leadIds) : Promise.resolve(new Map<string, Date>()),
    leadIds.length ? fetchBeraterContext(leadIds) : Promise.resolve(new Map()),
    leadIds.length ? fetchTouchesByLead(leadIds) : Promise.resolve(new Map<number, number>()),
    fetchOkkAllRoles(opts),
    fetchManagerRoster(),
  ]);

  const baseLeads = baseLeadsRaw.map((lead) =>
    enrichDisqualifiedAt(lead, closeReasonHistory.get(lead.leadId))
  );

  // Только B2G-менеджеры (не РОП). Отсекает B2B-ответственных и системных юзеров.
  const isB2gManager = (uid: number): boolean => {
    const m = roster.get(uid);
    return !!m && m.department === "b2g" && m.role !== "rop";
  };

  // 3. Аккумуляторы по каждой роли. Путь клиента считаем один раз.
  const accByRole: Record<ManagerRoleKey, Map<number, Accum>> = {
    qualifier: new Map(),
    berater: new Map(),
    dovedenie: new Map(),
  };
  const bump = (role: ManagerRoleKey, uid: number, apply: (a: Accum) => void) => {
    let a = accByRole[role].get(uid);
    if (!a) {
      a = { clients: 0, reachedDocs: 0, reachedTermDc: 0, reachedGutschein: 0, touches: 0, consultations: 0 };
      accByRole[role].set(uid, a);
    }
    apply(a);
  };

  for (const lead of baseLeads) {
    if (lead.isDisqualified) continue;
    const beraters: BeraterLead[] = beraterContext.get(lead.leadId) ?? [];
    const touches = touchesByLead.get(lead.leadId) ?? 0;
    const consult = countConsultations(beraters);

    const c1 = processLeadForConversion("C1", lead, targetEvents, beraterContext);
    const c2 = processLeadForConversion("C2", lead, targetEvents, beraterContext);
    const c5 = processLeadForConversion("C5", lead, targetEvents, beraterContext);
    const reachedDocs = c1.included && c1.targetAt !== null;
    const reachedTermDc = c2.included && c2.targetAt !== null;
    const reachedGutschein = c5.included && c5.targetAt !== null;

    const apply = (a: Accum) => {
      a.clients += 1;
      a.touches += touches;
      a.consultations += consult;
      if (reachedDocs) a.reachedDocs += 1;
      if (reachedTermDc) a.reachedTermDc += 1;
      if (reachedGutschein) a.reachedGutschein += 1;
    };

    // Квалификатор — ответственный Гос-сделки, линия 1 (B2G).
    const qUid = lead.responsibleUserId;
    if (qUid !== null && isB2gManager(qUid) && roster.get(qUid)!.line === "1") {
      bump("qualifier", qUid, apply);
    }
    // Бератер/Доведение — ответственный Бератер-сделки нужной линии (B2G).
    const bUid = creditBeraterResponsible(beraters, roster, isB2gManager, "2");
    if (bUid !== null) bump("berater", bUid, apply);
    const dUid = creditBeraterResponsible(beraters, roster, isB2gManager, "3");
    if (dUid !== null) bump("dovedenie", dUid, apply);
  }

  // 4. Сборка строк по ролям (все uid уже прошли B2G-фильтр при накоплении).
  const roles = {} as Record<ManagerRoleKey, ManagerRow[]>;
  for (const role of ROLE_KEYS) {
    const rows: ManagerRow[] = [];
    for (const [uid, a] of accByRole[role]) {
      const meta = roster.get(uid)!;
      const okk = okkByUser.get(uid)?.[role];
      rows.push({
        userId: uid,
        name: meta.name,
        line: meta.line,
        clients: a.clients,
        reachedDocs: a.reachedDocs,
        reachedTermDc: a.reachedTermDc,
        reachedGutschein: a.reachedGutschein,
        conversionC5Pct: a.clients > 0 ? (a.reachedGutschein / a.clients) * 100 : null,
        touches: a.touches,
        consultations: a.consultations,
        avgOkk: okk && okk.n > 0 ? Math.round((okk.sum / okk.n) * 10) / 10 : null,
        okkScored: okk ? okk.n : 0,
      });
    }
    rows.sort((x, y) => y.clients - x.clients);
    roles[role] = rows;
  }

  return { roles, fromIso: opts.from.toISOString(), toIso: opts.to.toISOString() };
}

// ── Кредит за клиента для berater/dovedenie ─────────────────────────────────
function creditBeraterResponsible(
  beraters: BeraterLead[],
  roster: Map<number, ManagerMeta>,
  isB2gManager: (uid: number) => boolean,
  expectedLine: string
): number | null {
  for (const b of beraters) {
    const uid = b.responsibleUserId;
    if (uid === null || !isB2gManager(uid)) continue;
    if (roster.get(uid)!.line === expectedLine) return uid;
  }
  return null;
}

// ── Консультации: +1 за каждую проведённую (ДЦ/АА) среди Бератер-сделок клиента ─
function countConsultations(beraters: BeraterLead[]): number {
  let n = 0;
  for (const b of beraters) {
    for (const s of CONSULT_DONE_STATUSES) if (b.events.has(s)) n += 1;
  }
  return n;
}

// ── Касания: distinct communications по каждому лиду (Pattern A, CLAUDE.md #4) ─
async function fetchTouchesByLead(leadIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (leadIds.length === 0) return out;
  const idsIn = leadIds.join(",");
  const rows = unwrapRows<{ leadId: string | number; n: string | number }>(
    await analyticsDb.execute(sql`
      SELECT lead_id AS "leadId", COUNT(DISTINCT communication_id)::int AS "n"
      FROM analytics.communications
      WHERE lead_id IN (${sql.raw(idsIn)})
        AND communication_id IS NOT NULL
      GROUP BY lead_id
    `)
  );
  for (const r of rows) out.set(Number(r.leadId), Number(r.n));
  return out;
}

// ── ОКК по менеджеру и роли (D2, готовый total_score) ───────────────────────
// Один запрос: (kommo_user_id, prompt_type) → sum + count. Агрегируем по роли
// в JS (berater = d2_berater + d2_berater2).
async function fetchOkkAllRoles(opts: ComputeOpts): Promise<Map<number, OkkAgg>> {
  const out = new Map<number, OkkAgg>();
  const rows = unwrapRows<{
    kommoUserId: string | number | null;
    promptType: string | null;
    sum: string | number | null;
    n: string | number;
  }>(
    await d2OkkDb.execute(sql`
      SELECT
        m.kommo_user_id     AS "kommoUserId",
        e.prompt_type       AS "promptType",
        SUM(e.total_score)  AS "sum",
        COUNT(*)::int       AS "n"
      FROM evaluations e
      JOIN calls c    ON c.id = e.call_id
      JOIN managers m ON m.id = c.manager_id
      WHERE e.prompt_type IN ('d2_qualifier','d2_berater','d2_berater2','d2_dovedenie')
        AND m.kommo_user_id IS NOT NULL
        AND c.call_created_at >= ${opts.from.toISOString()}
        AND c.call_created_at <  ${opts.to.toISOString()}
      GROUP BY m.kommo_user_id, e.prompt_type
    `)
  );
  for (const r of rows) {
    if (r.kommoUserId === null || r.promptType === null) continue;
    const role = PROMPT_TYPE_ROLE[r.promptType];
    if (!role) continue;
    const uid = Number(r.kommoUserId);
    let agg = out.get(uid);
    if (!agg) {
      agg = {
        qualifier: { sum: 0, n: 0 },
        berater: { sum: 0, n: 0 },
        dovedenie: { sum: 0, n: 0 },
      };
      out.set(uid, agg);
    }
    agg[role].sum += r.sum === null ? 0 : Number(r.sum);
    agg[role].n += Number(r.n);
  }
  return out;
}

// ── Ростер менеджеров из master_managers (D1, источник правды) ───────────────
// Ключ — kommo_user_id (= responsible_user_id). Содержит отдел + линию + роль +
// каноничное имя. Funnel — B2G, поэтому при сборке фильтруем department='b2g'.
async function fetchManagerRoster(): Promise<Map<number, ManagerMeta>> {
  const out = new Map<number, ManagerMeta>();
  const rows = unwrapRows<{
    name: string;
    kommoUserId: string | number | null;
    department: string;
    line: string | null;
    role: string | null;
  }>(
    await db.execute(sql`
      SELECT name AS "name", kommo_user_id AS "kommoUserId",
             department AS "department", line AS "line", role AS "role"
      FROM master_managers
      WHERE kommo_user_id IS NOT NULL
    `)
  );
  for (const r of rows) {
    if (r.kommoUserId === null) continue;
    out.set(Number(r.kommoUserId), {
      name: r.name,
      department: r.department,
      line: r.line,
      role: r.role,
    });
  }
  return out;
}
