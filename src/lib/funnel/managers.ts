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

/**
 * Профильная конверсия роли (ТЗ «помимо C5 — конверсия, за которую отвечает
 * сам менеджер»). База/цель считаются ровно как в «Когортах» (через
 * processLeadForConversion), поэтому % сходится 1-в-1 с вкладкой Когорты:
 *   qualifier → C2 (Квал лид → Термин ДЦ; база = все его квал-клиенты)
 *   berater   → C3 (Конс. перед ДЦ → Термин ДЦ состоялся; база — подмножество)
 *   dovedenie → C4 (Конс. перед АА → Гутшайн; база — подмножество)
 * Значения C2/C3/C4 ⊂ ConversionId, без C3.1 (у неё своя 3-состояний логика).
 * ⚠ Дубль есть в ManagersView.tsx (клиент) — managers.ts серверный, импортить
 * его runtime-значения в клиент нельзя. При смене мапы править оба места.
 */
export const ROLE_CONVERSION: Record<ManagerRoleKey, "C2" | "C3" | "C4"> = {
  qualifier: "C2",
  berater: "C3",
  dovedenie: "C4",
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
  /** Профильная конверсия роли (см. ROLE_CONVERSION): база/цель и %. */
  roleBase: number;
  roleTarget: number;
  roleConversionPct: number | null;
  touches: number;
  /** Дней с ≥1 касанием по клиентам менеджера (знаменатель «касаний/день»). */
  activeDays: number;
  /** Среднее касаний в активный рабочий день = touches / activeDays. */
  touchesPerDay: number | null;
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
  roleBase: number;
  roleTarget: number;
  touches: number;
  /** Объединение дат касаний по всем клиентам менеджера → size = активные дни. */
  touchDays: Set<string>;
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
    leadIds.length ? fetchTouchesByLead(leadIds, opts) : Promise.resolve(new Map<number, LeadTouches>()),
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
      a = { clients: 0, reachedDocs: 0, reachedTermDc: 0, reachedGutschein: 0, roleBase: 0, roleTarget: 0, touches: 0, touchDays: new Set<string>(), consultations: 0 };
      accByRole[role].set(uid, a);
    }
    apply(a);
  };

  for (const lead of baseLeads) {
    if (lead.isDisqualified) continue;
    const beraters: BeraterLead[] = beraterContext.get(lead.leadId) ?? [];
    const touchInfo = touchesByLead.get(lead.leadId);
    const touches = touchInfo?.total ?? 0;
    const touchDays = touchInfo?.days ?? [];
    const consult = countConsultations(beraters);

    // Результаты конверсий по лиду. C2/C3/C4 нужны и для общего пути, и как
    // профильные конверсии ролей (см. ROLE_CONVERSION).
    const c1 = processLeadForConversion("C1", lead, targetEvents, beraterContext);
    const byConv = {
      C2: processLeadForConversion("C2", lead, targetEvents, beraterContext),
      C3: processLeadForConversion("C3", lead, targetEvents, beraterContext),
      C4: processLeadForConversion("C4", lead, targetEvents, beraterContext),
    };
    const c5 = processLeadForConversion("C5", lead, targetEvents, beraterContext);
    const reachedDocs = c1.included && c1.targetAt !== null;
    const reachedTermDc = byConv.C2.included && byConv.C2.targetAt !== null;
    const reachedGutschein = c5.included && c5.targetAt !== null;

    // applyFor(role) — общий клиентский путь + профильная конверсия роли.
    // База/цель профильной конверсии повторяют логику когорт (compute.ts):
    // дисквал-лиды уже отброшены выше (continue), поэтому здесь только проверка
    // target_at ≤ disqualified_at для temporal-корректности (как _target_counts).
    const applyFor = (role: ManagerRoleKey) => (a: Accum) => {
      a.clients += 1;
      a.touches += touches;
      for (const d of touchDays) a.touchDays.add(d);
      a.consultations += consult;
      if (reachedDocs) a.reachedDocs += 1;
      if (reachedTermDc) a.reachedTermDc += 1;
      if (reachedGutschein) a.reachedGutschein += 1;
      const rc = byConv[ROLE_CONVERSION[role]];
      if (rc.included) {
        a.roleBase += 1;
        if (
          rc.targetAt !== null &&
          (lead.disqualifiedAt === null || rc.targetAt <= lead.disqualifiedAt)
        ) {
          a.roleTarget += 1;
        }
      }
    };

    // Квалификатор — ответственный Гос-сделки, линия 1 (B2G).
    const qUid = lead.responsibleUserId;
    if (qUid !== null && isB2gManager(qUid) && roster.get(qUid)!.line === "1") {
      bump("qualifier", qUid, applyFor("qualifier"));
    }
    // Бератер/Доведение — ответственный Бератер-сделки нужной линии (B2G).
    const bUid = creditBeraterResponsible(beraters, roster, isB2gManager, ROLE_BERATER_LINE.berater);
    if (bUid !== null) bump("berater", bUid, applyFor("berater"));
    const dUid = creditBeraterResponsible(beraters, roster, isB2gManager, ROLE_BERATER_LINE.dovedenie);
    if (dUid !== null) bump("dovedenie", dUid, applyFor("dovedenie"));
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
        roleBase: a.roleBase,
        roleTarget: a.roleTarget,
        roleConversionPct: a.roleBase > 0 ? (a.roleTarget / a.roleBase) * 100 : null,
        touches: a.touches,
        activeDays: a.touchDays.size,
        touchesPerDay: a.touchDays.size > 0 ? a.touches / a.touchDays.size : null,
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
// При нескольких Бератер-сделках клиента нужной линии кредит идёт тому, чья
// сделка достигла Гутшайна (WON), иначе — первому в детерминированном порядке
// (fetchBeraterContext сортирует по lead_id, см. ORDER BY).
function creditBeraterResponsible(
  beraters: BeraterLead[],
  roster: Map<number, ManagerMeta>,
  isB2gManager: (uid: number) => boolean,
  expectedLine: string
): number | null {
  let firstMatch: number | null = null;
  for (const b of beraters) {
    const uid = b.responsibleUserId;
    if (uid === null || !isB2gManager(uid)) continue;
    if (roster.get(uid)!.line !== expectedLine) continue;
    if (b.events.has(BERATER_STATUSES.WON)) return uid; // достиг Гутшайна → кредит ему
    if (firstMatch === null) firstMatch = uid;
  }
  return firstMatch;
}

// ── Консультации: +1 за каждую проведённую (ДЦ/АА) среди Бератер-сделок клиента ─
function countConsultations(beraters: BeraterLead[]): number {
  let n = 0;
  for (const b of beraters) {
    for (const s of CONSULT_DONE_STATUSES) if (b.events.has(s)) n += 1;
  }
  return n;
}

// ── Касания: distinct communications по каждому лиду ЗА ПЕРИОД ────────────────
// COUNT(DISTINCT communication_id) — Pattern A fanout иначе двоит (CLAUDE.md #4).
// Ограничено окном [from,to]: «касания за период», иначе запрос сканирует всю
// историю по тысячам лидов (риск таймаута Neon на широких диапазонах).
//
// Группируем дополнительно по дню (Europe/Berlin, CLAUDE.md #1): total = сумма
// distinct-касаний по дням лида (= distinct по лиду, т.к. каждое касание в одном
// дне), days = список дат → объединение по менеджеру даёт «активные дни».
interface LeadTouches {
  total: number;
  days: string[];
}
async function fetchTouchesByLead(
  leadIds: number[],
  opts: ComputeOpts
): Promise<Map<number, LeadTouches>> {
  const out = new Map<number, LeadTouches>();
  if (leadIds.length === 0) return out;
  const idsIn = leadIds.join(",");
  const rows = unwrapRows<{
    leadId: string | number;
    day: string;
    n: string | number;
  }>(
    await analyticsDb.execute(sql`
      SELECT
        lead_id AS "leadId",
        ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date::text AS "day",
        COUNT(DISTINCT communication_id)::int AS "n"
      FROM analytics.communications
      WHERE lead_id IN (${sql.raw(idsIn)})
        AND communication_id IS NOT NULL
        AND created_at >= ${opts.from.toISOString()}
        AND created_at <  ${opts.to.toISOString()}
      GROUP BY lead_id, "day"
    `)
  );
  for (const r of rows) {
    const id = Number(r.leadId);
    let lt = out.get(id);
    if (!lt) {
      lt = { total: 0, days: [] };
      out.set(id, lt);
    }
    lt.total += Number(r.n);
    lt.days.push(r.day);
  }
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
        AND e.total_score IS NOT NULL
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
