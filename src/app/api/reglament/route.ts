/**
 * API вкладки «Регламент» (b2g) — зеркало Looker-отчёта «Sternmeister Госники V7».
 * ТЗ: dev_docs/specs/23-ВКЛАДКА-РЕГЛАМЕНТ-ЗЕРКАЛО-LOOKER-РОПа.md
 * Нормативы/формулы: dev_docs/specs/23a-СПРАВОЧНИК-НОРМАТИВОВ-РЕГЛАМЕНТА.md
 *
 * Один роут, переключение `?view=`:
 *   avg_summary  — «Среднее время на этапах / Сводный» (pivot менеджер × этап)
 *   avg_detail   — «… / Детализированно» (по-пребываниям)
 *
 * Всё читается из Analytics Neon (lead_status_changes + leads_cohort).
 * TZ: границы периода — берлинские сутки; timestamps в БД — naive UTC.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";
import { parseDateBoundary, todayCivil, addDaysCivil } from "@/lib/utils/date";
import {
  FUNNEL_PIPELINES,
  SLA_TARGET_SECONDS,
  TLT_GAP_NORMS,
  type FunnelKey,
} from "@/lib/reglament/norms";
import { fetchStageIntervals, fetchTouches, type StageInterval } from "@/lib/reglament/data";
import {
  collapseAll,
  computeStageTime,
  computeTltGap,
  computeTouches,
  displayStageLabel,
} from "@/lib/reglament/compute";

export const dynamic = "force-dynamic";

const VALID_VIEWS = new Set([
  "avg_summary",
  "avg_detail",
  "sla",
  "stage_time",
  "tlt_gap",
  "touches",
  "tasks",
  "summary",
  "missed",
]);

/** Терминальные статусы: пребывание в них не является «этапом работы» —
 *  исключаем из среднего времени (в Looker-пивоте их тоже нет). */
const TERMINAL_STATUSES = [
  "Успешно реализовано",
  "Закрыто и не реализовано",
  "Игнор",
  "Рассрочка",
  "Счет выставлен",
  // Терминальные «успехи» воронок B2G: Бух Гос завершается статусом
  // «Термин ДЦ» (sort 10000 = won-слот Kommo), Бух Бератер — «Гутшайн одобрен».
  "Термин ДЦ",
  "Гутшайн одобрен",
];

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

/** Naive-UTC литерал для сравнения с timestamp-колонками analytics.*. */
function utcLiteral(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function clampInt(value: string | null, def: number, max: number): number {
  if (!value) return def;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return def;
  return Math.min(parsed, max);
}

/** Разбор периода: берлинские сутки [from 00:00, to 23:59:59.999]. */
function parsePeriod(sp: URLSearchParams): { fromUtc: Date; toUtc: Date } | null {
  const today = todayCivil();
  const fromStr = sp.get("from") ?? addDaysCivil(today, -29);
  const toStr = sp.get("to") ?? today;
  const fromUtc = parseDateBoundary(fromStr, "start");
  const toUtc = parseDateBoundary(toStr, "end");
  if (!fromUtc || !toUtc || toUtc.getTime() < fromUtc.getTime()) return null;
  return { fromUtc, toUtc };
}

function parseFunnels(sp: URLSearchParams): FunnelKey[] {
  const f = sp.get("funnel");
  if (f === "gos" || f === "berater") return [f];
  return ["gos", "berater"];
}

/** WHERE-фрагменты общих фильтров детальных view (менеджер, id сделки). */
function detailFilters(sp: URLSearchParams): string {
  const parts: string[] = [];
  const manager = sp.get("manager");
  if (manager) parts.push(`AND lc.manager = '${esc(manager)}'`);
  const leadId = sp.get("leadId");
  if (leadId && /^\d{1,12}$/.test(leadId)) parts.push(`AND sc.lead_id = ${Number(leadId)}`);
  return parts.join("\n");
}

interface TaskDayRow {
  day: string;
  funnel: FunnelKey;
  manager: string;
  total: number;
  planned: number;
  overdue: number;
  completed: number;
  notCompleted: number;
  score: number;
}

/**
 * Задачи: день × менеджер × воронка (формулы справочника 23a §5).
 * Всего на день = задачи с дедлайном сегодня + висящие просроченные;
 * Просроченные = Всего − Запланировано; Показатель = Завершено/Всего×100
 * (может быть > 100). Момент завершения — completed_at (заполняется
 * sync-tasks из updated_at Kommo; исторические строки без него не попадают
 * в «Завершено»). Хвосты просрочки старше полугода до начала периода
 * отсекаются осознанно.
 */
async function aggregateTasks(opts: {
  pipelines: string;
  fromUtc: Date;
  fromLit: string;
  toLit: string;
  fromCivil: string;
  toCivil: string;
  manager: string | null;
}): Promise<TaskDayRow[]> {
  const managerCond = opts.manager ? `AND t.task_manager = '${esc(opts.manager)}'` : "";
  const horizonLit = utcLiteral(new Date(opts.fromUtc.getTime() - 183 * 86_400_000));
  const query = `
    SELECT
      t.task_manager,
      lc.pipeline,
      to_char(t.deadline AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') AS deadline_day,
      to_char(t.completed_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') AS completed_day,
      t.is_completed
    FROM analytics.tasks t
    JOIN analytics.leads_cohort lc ON lc.lead_id = t.lead_id
    WHERE lc.pipeline IN (${opts.pipelines})
      AND COALESCE(lc.is_deleted, FALSE) = FALSE
      AND t.deadline IS NOT NULL
      AND t.task_manager IS NOT NULL
      AND (
        (t.deadline >= '${horizonLit}' AND t.deadline <= '${opts.toLit}')
        OR (t.completed_at >= '${opts.fromLit}' AND t.completed_at <= '${opts.toLit}')
      )
      ${managerCond}
  `;
  const res = await analyticsDb.execute<{
    task_manager: string;
    pipeline: string;
    deadline_day: string | null;
    completed_day: string | null;
    is_completed: number;
  }>(sql.raw(query));

  const days: string[] = [];
  for (let d = opts.fromCivil; d <= opts.toCivil; d = addDaysCivil(d, 1)) days.push(d);

  interface Agg {
    planned: number;
    overdue: number;
    completed: number;
  }
  const agg = new Map<string, Agg>(); // key: day|funnel|manager
  const bump = (day: string, funnel: FunnelKey, manager: string, k: keyof Agg) => {
    const key = `${day}|${funnel}|${manager}`;
    const a = agg.get(key) ?? { planned: 0, overdue: 0, completed: 0 };
    a[k]++;
    agg.set(key, a);
  };
  for (const r of res.rows) {
    const funnel: FunnelKey = r.pipeline === FUNNEL_PIPELINES.gos ? "gos" : "berater";
    for (const day of days) {
      if (r.deadline_day === day) bump(day, funnel, r.task_manager, "planned");
      else if (
        r.deadline_day != null &&
        r.deadline_day < day &&
        (!r.is_completed || (r.completed_day != null && r.completed_day >= day))
      ) {
        bump(day, funnel, r.task_manager, "overdue");
      }
      if (r.completed_day === day) bump(day, funnel, r.task_manager, "completed");
    }
  }
  return [...agg.entries()]
    .map(([key, a]) => {
      const [day, funnel, manager] = key.split("|");
      const total = a.planned + a.overdue;
      return {
        day,
        funnel: funnel as FunnelKey,
        manager,
        total,
        planned: a.planned,
        overdue: a.overdue,
        completed: a.completed,
        notCompleted: Math.max(0, total - a.completed),
        score: total > 0 ? Math.round((a.completed / total) * 10000) / 100 : 0,
      };
    })
    .filter((r) => r.total > 0 || r.completed > 0)
    .sort((a, b) => (a.day === b.day ? a.manager.localeCompare(b.manager, "ru") : b.day.localeCompare(a.day)));
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const sp = request.nextUrl.searchParams;
    const view = sp.get("view") ?? "";
    if (!VALID_VIEWS.has(view)) {
      return NextResponse.json({ error: "Invalid view" }, { status: 400 });
    }
    const period = parsePeriod(sp);
    if (!period) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    const funnels = parseFunnels(sp);
    const pipelines = funnels.map((f) => `'${esc(FUNNEL_PIPELINES[f])}'`).join(", ");
    const fromLit = utcLiteral(period.fromUtc);
    const toLit = utcLiteral(period.toUtc);
    const terminalList = TERMINAL_STATUSES.map((s) => `'${esc(s)}'`).join(", ");

    // ── Сводка «Показатели соблюдения регламента» ─────────────────────
    // Каждая метрика = доля ok-проверок менеджера за период; «Регламент, %»
    // = микро-среднее Σok/Σпроверок по всем метрикам (гипотеза 23a §6,
    // простое среднее процентов опровергнуто). SLA-порог — предварительный.
    if (view === "summary") {
      const nowMs = Date.now();
      const intervals = await fetchStageIntervals({
        funnels: ["gos", "berater"],
        fromUtc: period.fromUtc,
        toUtc: period.toUtc,
        anchor: "exit",
      });
      const merged = collapseAll(intervals);
      const stageRows = merged
        .map((iv) => computeStageTime(iv, nowMs))
        .filter((r): r is NonNullable<typeof r> => r !== null);
      const tltIv = merged.filter((iv) => TLT_GAP_NORMS[iv.funnel][iv.status] != null);
      const touchIv = collapseAll(intervals, { intake: true }).filter(
        (iv) => iv.exitMs != null && iv.nextStatus != null,
      );
      const allLeadIds = [...new Set([...tltIv, ...touchIv].map((iv) => iv.leadId))];
      const allMs = [...tltIv, ...touchIv].flatMap((iv) => [iv.enterMs, iv.exitMs ?? nowMs]);
      const touches = await fetchTouches(
        allLeadIds,
        allMs.length ? Math.min(...allMs) : 0,
        allMs.length ? Math.max(...allMs) : 0,
      );
      const tltRows = tltIv
        .map((iv) => computeTltGap(iv, touches.get(iv.leadId), nowMs))
        .filter((r): r is NonNullable<typeof r> => r !== null);
      const touchRows = touchIv
        .map((iv) => computeTouches(iv, touches.get(iv.leadId)))
        .filter((r): r is NonNullable<typeof r> => r !== null);

      // SLA (только Гос): доля лидов с первым звонком ≤ порога от начала
      // смены. Лиды без звонка (pending) не участвуют.
      const slaRes = await analyticsDb.execute<{
        manager: string | null;
        n: string;
        ok: string;
      }>(
        sql.raw(`
          SELECT s.manager,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (
              WHERE COALESCE(s.sla_first_call_from_shift_seconds, s.sla_first_call_seconds) <= ${SLA_TARGET_SECONDS}
            )::int AS ok
          FROM analytics.sla s
          LEFT JOIN analytics.leads_cohort lc ON lc.lead_id = s.lead_id
          WHERE s.pipeline_name = '${esc(FUNNEL_PIPELINES.gos)}'
            AND s.sla_start >= '${fromLit}' AND s.sla_start <= '${toLit}'
            AND COALESCE(lc.is_deleted, FALSE) = FALSE
            AND COALESCE(s.sla_first_call_from_shift_seconds, s.sla_first_call_seconds) IS NOT NULL
          GROUP BY s.manager
        `),
      );

      const fromCivil = sp.get("from") ?? addDaysCivil(todayCivil(), -29);
      const toCivil = sp.get("to") ?? todayCivil();
      const taskRows = await aggregateTasks({
        pipelines,
        fromUtc: period.fromUtc,
        fromLit,
        toLit,
        fromCivil,
        toCivil,
        manager: null,
      });

      // Σ по (funnel, manager, metric)
      type Cell = { ok: number; n: number };
      const cells = new Map<string, Cell>(); // funnel|manager|metric
      const add = (funnel: FunnelKey, manager: string, metric: string, ok: number, n: number) => {
        const key = `${funnel}|${manager}|${metric}`;
        const c = cells.get(key) ?? { ok: 0, n: 0 };
        c.ok += ok;
        c.n += n;
        cells.set(key, c);
      };
      for (const r of stageRows) add(r.interval.funnel, r.interval.responsible, "stage", r.ok ? 1 : 0, 1);
      for (const r of tltRows) add(r.interval.funnel, r.interval.responsible, "tlt", r.ok ? 1 : 0, 1);
      for (const r of touchRows) add(r.interval.funnel, r.interval.responsible, "touches", r.ok ? 1 : 0, 1);
      for (const r of slaRes.rows) {
        if (r.manager) add("gos", r.manager, "sla", Number(r.ok), Number(r.n));
      }
      for (const r of taskRows) add(r.funnel, r.manager, "tasks", Math.min(r.completed, r.total), r.total);

      const managersByFunnel: Record<FunnelKey, Set<string>> = { gos: new Set(), berater: new Set() };
      for (const key of cells.keys()) {
        const [funnel, manager] = key.split("|");
        managersByFunnel[funnel as FunnelKey].add(manager);
      }
      const METRICS = ["sla", "tlt", "stage", "touches", "tasks"] as const;
      const build = (funnel: FunnelKey) =>
        [...managersByFunnel[funnel]]
          .sort((a, b) => a.localeCompare(b, "ru"))
          .map((manager) => {
            const metrics: Record<string, { pct: number; ok: number; n: number } | null> = {};
            let sumOk = 0;
            let sumN = 0;
            for (const m of METRICS) {
              if (funnel === "berater" && m === "sla") continue;
              const c = cells.get(`${funnel}|${manager}|${m}`);
              if (c && c.n > 0) {
                metrics[m] = { pct: Math.round((c.ok / c.n) * 100), ok: c.ok, n: c.n };
                sumOk += c.ok;
                sumN += c.n;
              } else {
                metrics[m] = null;
              }
            }
            return {
              manager,
              metrics,
              reglament: sumN > 0 ? Math.round((sumOk / sumN) * 100) : null,
            };
          })
          .filter((r) => r.reglament !== null);
      return NextResponse.json({ view, gos: build("gos"), berater: build("berater") });
    }

    // ── Пропущенные звонки (определение из ТЗ 23 §4.1) ────────────────
    // Только CallGear; звонок = кластер cg-легов (телефон + разрыв ≤3 мин);
    // пропущен = ни один агент не ответил. Входящие CG идут через
    // переадресацию («Call forwarding»): короткое соединение (< порога) —
    // гудки/сброс, т.е. НЕ ответ; длинное — разговор с менеджером по
    // мобильному. Порог 🟡 подобран по эталону (T=7с — ближайший счёт).
    // Менеджер = ответственный контакта. Ограничение: звонки без агентских
    // легов (вне рабочего времени) в communications отсутствуют.
    if (view === "missed") {
      const FORWARD_MIN_TALK_SECONDS = 7;
      const legsRes = await analyticsDb.execute<{
        communication_id: string;
        at_utc: string;
        call_status: number | null;
        manager: string | null;
        phone: string | null;
        duration: number | null;
      }>(
        sql.raw(`
          SELECT DISTINCT ON (communication_id)
            communication_id,
            to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS at_utc,
            call_status,
            manager,
            phone,
            duration
          FROM analytics.communications
          WHERE communication_type = 'call_in'
            AND communication_id LIKE 'cg-leg%'
            AND phone IS NOT NULL
            AND created_at >= '${fromLit}' AND created_at <= '${toLit}'
          ORDER BY communication_id
        `),
      );
      const norm = (p: string) => p.replace(/\D/g, "").slice(-9);
      const legs = legsRes.rows
        .map((r) => ({
          ms: new Date(r.at_utc.replace(" ", "T") + "Z").getTime(),
          answered:
            r.call_status === 4 &&
            (r.manager !== "Call forwarding" || Number(r.duration ?? 0) >= FORWARD_MIN_TALK_SECONDS),
          phone: norm(r.phone ?? ""),
        }))
        .filter((l) => l.phone.length >= 7)
        .sort((a, b) => a.ms - b.ms);
      // Кластеризация легов в звонки
      interface Cluster {
        phone: string;
        startMs: number;
        lastMs: number;
        answered: boolean;
      }
      const clusters: Cluster[] = [];
      const lastByPhone = new Map<string, Cluster>();
      for (const l of legs) {
        const prev = lastByPhone.get(l.phone);
        if (prev && l.ms - prev.lastMs <= 180_000) {
          prev.lastMs = l.ms;
          prev.answered = prev.answered || l.answered;
        } else {
          const c: Cluster = { phone: l.phone, startMs: l.ms, lastMs: l.ms, answered: l.answered };
          clusters.push(c);
          lastByPhone.set(l.phone, c);
        }
      }
      const missed = clusters.filter((c) => !c.answered).sort((a, b) => b.startMs - a.startMs);

      // Контакты по номерам (основной телефон или phones_all)
      const phones = [...new Set(missed.map((c) => c.phone))];
      const contactsByPhone = new Map<
        string,
        { contactId: number; name: string | null; responsibleUserId: number | null }
      >();
      if (phones.length > 0) {
        const values = phones.map((p) => `('${esc(p)}')`).join(", ");
        const contactsRes = await analyticsDb.execute<{
          p: string;
          contact_id: string;
          name: string | null;
          responsible_user_id: string | null;
        }>(
          sql.raw(`
            SELECT v.p, c.contact_id, c.name, c.responsible_user_id
            FROM (VALUES ${values}) AS v(p)
            JOIN analytics.contacts c
              ON right(regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g'), 9) = v.p
              OR EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(COALESCE(c.phones_all, '[]'::jsonb)) ph
                WHERE right(regexp_replace(ph, '\\D', '', 'g'), 9) = v.p
              )
          `),
        );
        for (const r of contactsRes.rows) {
          if (!contactsByPhone.has(r.p)) {
            contactsByPhone.set(r.p, {
              contactId: Number(r.contact_id),
              name: r.name,
              responsibleUserId: r.responsible_user_id != null ? Number(r.responsible_user_id) : null,
            });
          }
        }
      }
      // Имена ответственных по kommo user id
      const userNames = await analyticsDb.execute<{ uid: string; manager: string }>(
        sql.raw(`
          SELECT DISTINCT ON (responsible_user_id) responsible_user_id AS uid, manager
          FROM analytics.leads_cohort
          WHERE responsible_user_id IS NOT NULL AND manager IS NOT NULL
          ORDER BY responsible_user_id, created_at DESC
        `),
      );
      const nameByUid = new Map(userNames.rows.map((r) => [Number(r.uid), r.manager]));

      const berlinStr = (ms: number): string => {
        const d = new Date(ms);
        return `${d.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" })} ${d.toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin", hour12: false })}`;
      };
      return NextResponse.json({
        view,
        rows: missed.map((c) => {
          const contact = contactsByPhone.get(c.phone);
          return {
            at: berlinStr(c.startMs),
            phone: c.phone,
            contactId: contact?.contactId ?? null,
            contactName: contact?.name ?? null,
            manager:
              contact?.responsibleUserId != null
                ? (nameByUid.get(contact.responsibleUserId) ?? "—")
                : "—",
          };
        }),
      });
    }

    // ── Задачи: день × менеджер (формулы из справочника 23a §5) ──────
    if (view === "tasks") {
      const managerParam = sp.get("manager") || null;
      const fromCivil = sp.get("from") ?? addDaysCivil(todayCivil(), -29);
      const toCivil = sp.get("to") ?? todayCivil();
      const rows = await aggregateTasks({
        pipelines,
        fromUtc: period.fromUtc,
        fromLit,
        toLit,
        fromCivil,
        toCivil,
        manager: managerParam,
      });
      // Свежесть данных задач (наш ETL задач может отставать)
      const [fresh] = (
        await analyticsDb.execute<{ max_created: string | null }>(
          sql.raw(
            `SELECT to_char(MAX(task_created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') AS max_created FROM analytics.tasks`,
          ),
        )
      ).rows;
      return NextResponse.json({ view, rows, dataUpTo: fresh?.max_created ?? null });
    }

    // ── Регламентные детальные view (интервалы этапов + касания) ─────
    if (view === "stage_time" || view === "tlt_gap" || view === "touches") {
      const limit = clampInt(sp.get("limit"), 100, 500);
      const offset = clampInt(sp.get("offset"), 0, 1_000_000);
      const managerParam = sp.get("manager") || null;
      const leadParam = sp.get("leadId");
      const leadId = leadParam && /^\d{1,12}$/.test(leadParam) ? Number(leadParam) : null;
      const nowMs = Date.now();

      let intervals = await fetchStageIntervals({
        funnels,
        fromUtc: period.fromUtc,
        toUtc: period.toUtc,
        anchor: "exit",
        closedOnly: view === "touches",
        manager: managerParam,
        leadId,
      });

      const berlinStr = (ms: number): string => {
        const d = new Date(ms);
        const date = d.toLocaleDateString("en-CA", { timeZone: "Europe/Berlin" });
        const time = d.toLocaleTimeString("en-GB", { timeZone: "Europe/Berlin", hour12: false });
        return `${date} ${time}`;
      };
      const paginate = <T,>(rows: T[]) => ({
        total: rows.length,
        okCount: 0,
        page: rows.slice(offset, offset + limit),
      });

      if (view === "stage_time") {
        const rows = intervals
          .map((iv) => computeStageTime(iv, nowMs))
          .filter((r): r is NonNullable<typeof r> => r !== null);
        const okCount = rows.filter((r) => r.ok).length;
        const { total, page } = paginate(rows);
        return NextResponse.json({
          view,
          total,
          okCount,
          rows: page.map((r) => ({
            leadId: r.interval.leadId,
            funnel: r.interval.funnel,
            status: r.interval.status,
            enterAt: berlinStr(r.interval.enterMs),
            exitAt: r.interval.exitMs != null ? berlinStr(r.interval.exitMs) : null,
            unit: r.unit,
            limit: r.limit,
            fact: Math.round(r.fact * 100) / 100,
            ok: r.ok,
            responsible: r.interval.responsible,
          })),
        });
      }

      if (view === "tlt_gap") {
        // Только этапы с TLT-нормативом — сузим перед выборкой касаний.
        intervals = intervals.filter((iv) => TLT_GAP_NORMS[iv.funnel][iv.status] != null);
        const leadIds = [...new Set(intervals.map((iv) => iv.leadId))];
        const minMs = Math.min(...intervals.map((iv) => iv.enterMs), nowMs);
        const maxMs = Math.max(...intervals.map((iv) => iv.exitMs ?? nowMs), 0);
        const touches = await fetchTouches(leadIds, minMs, maxMs);
        const rows = intervals
          .map((iv) => computeTltGap(iv, touches.get(iv.leadId), nowMs))
          .filter((r): r is NonNullable<typeof r> => r !== null);
        const okCount = rows.filter((r) => r.ok).length;
        const { total, page } = paginate(rows);
        return NextResponse.json({
          view,
          total,
          okCount,
          rows: page.map((r) => ({
            leadId: r.interval.leadId,
            funnel: r.interval.funnel,
            status: r.interval.status,
            enterAt: berlinStr(r.interval.enterMs),
            exitAt: r.interval.exitMs != null ? berlinStr(r.interval.exitMs) : null,
            limit: r.limit,
            gapFact: r.gapFact,
            ok: r.ok,
            responsible: r.interval.responsible,
          })),
        });
      }

      // touches — переходы между этапами (Гос-группа «Новый лид / Взят в
      // работу» схлопывается: внутренний переход не считается переходом).
      const collapsed = collapseAll(intervals).filter(
        (iv): iv is StageInterval & { exitMs: number } => iv.exitMs != null && iv.nextStatus != null,
      );
      const leadIds = [...new Set(collapsed.map((iv) => iv.leadId))];
      const minMs = collapsed.length ? Math.min(...collapsed.map((iv) => iv.enterMs)) : 0;
      const maxMs = collapsed.length ? Math.max(...collapsed.map((iv) => iv.exitMs)) : 0;
      const touches = await fetchTouches(leadIds, minMs, maxMs);
      const rows = collapsed
        .map((iv) => computeTouches(iv, touches.get(iv.leadId)))
        .filter((r): r is NonNullable<typeof r> => r !== null);
      // свежие переходы сверху
      rows.sort((a, b) => (b.interval.exitMs ?? 0) - (a.interval.exitMs ?? 0));
      const okCount = rows.filter((r) => r.ok).length;
      const { total, page } = paginate(rows);
      return NextResponse.json({
        view,
        total,
        okCount,
        rows: page.map((r) => ({
          leadId: r.interval.leadId,
          funnel: r.interval.funnel,
          fromStatus: displayStageLabel(r.interval.funnel, r.interval.status),
          toStatus: displayStageLabel(r.interval.funnel, r.interval.nextStatus ?? "—"),
          exitAt: berlinStr(r.interval.exitMs ?? 0),
          calls: r.calls,
          messages: r.messages,
          minCalls: r.minCalls,
          minMessages: r.minMessages,
          ok: r.ok,
          responsible: r.interval.responsible,
        })),
      });
    }

    // ── SLA первого звонка (только Бух Гос) ──────────────────────────
    // Семантика подтверждена сверкой с Looker (ТЗ 23 §4.2): «Время до
    // 1-го звонка» = от начала СМЕНЫ менеджера (sla_first_call_from_shift_seconds).
    // Лид без звонка — «ещё не позвонили» (в Looker там артефакт с датой
    // обновления отчёта; мы показываем честный статус).
    if (view === "sla") {
      const limit = clampInt(sp.get("limit"), 100, 500);
      const offset = clampInt(sp.get("offset"), 0, 1_000_000);
      const managerParam = sp.get("manager");
      const managerCond = managerParam ? `AND s.manager = '${esc(managerParam)}'` : "";
      const leadParam = sp.get("leadId");
      const leadCond =
        leadParam && /^\d{1,12}$/.test(leadParam) ? `AND s.lead_id = ${Number(leadParam)}` : "";
      const query = `
        WITH rows AS (
          SELECT
            s.lead_id,
            s.manager,
            to_char(s.sla_start AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') AS enter_berlin,
            CASE WHEN s.first_call_out_at IS NULL THEN NULL
                 ELSE to_char(s.first_call_out_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS')
            END AS call_berlin,
            COALESCE(s.sla_first_call_from_shift_seconds, s.sla_first_call_seconds) AS sla_seconds,
            s.sla_start AS sort_key
          FROM analytics.sla s
          LEFT JOIN analytics.leads_cohort lc ON lc.lead_id = s.lead_id
          WHERE s.pipeline_name = '${esc(FUNNEL_PIPELINES.gos)}'
            AND s.sla_start >= '${fromLit}' AND s.sla_start <= '${toLit}'
            AND COALESCE(lc.is_deleted, FALSE) = FALSE
            ${managerCond}
            ${leadCond}
        )
        SELECT *,
          COUNT(*) OVER ()::int AS total,
          AVG(sla_seconds) FILTER (WHERE sla_seconds IS NOT NULL) OVER ()::bigint AS avg_seconds
        FROM rows
        ORDER BY sort_key DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      const res = await analyticsDb.execute<{
        lead_id: string;
        manager: string | null;
        enter_berlin: string;
        call_berlin: string | null;
        sla_seconds: string | null;
        total: number;
        avg_seconds: string | null;
      }>(sql.raw(query));
      return NextResponse.json({
        view,
        total: res.rows.length > 0 ? Number(res.rows[0].total) : 0,
        avgSeconds: res.rows.length > 0 && res.rows[0].avg_seconds != null ? Number(res.rows[0].avg_seconds) : null,
        rows: res.rows.map((r) => ({
          leadId: Number(r.lead_id),
          manager: r.manager ?? "—",
          enterAt: r.enter_berlin,
          callAt: r.call_berlin,
          slaSeconds: r.sla_seconds != null ? Number(r.sla_seconds) : null,
        })),
      });
    }

    // Базовый источник пребываний: событие входа в этап + выход (или «сейчас»
    // для открытых). Ответственный — ТЕКУЩИЙ менеджер сделки из leads_cohort
    // (как «Отв-ый за сделку» в Looker), не исторический из status_changes.
    // Фильтр периода — по ДАТЕ ВХОДА в этап (как в Looker «Дата входа в этап»).
    const intervalsCte = `
      WITH intervals AS (
        SELECT
          sc.lead_id,
          sc.pipeline,
          sc.status,
          sc.event_at,
          sc.next_event_at,
          COALESCE(sc.next_event_at, NOW() AT TIME ZONE 'UTC') AS exit_at,
          COALESCE(lc.manager, '—') AS responsible
        FROM analytics.lead_status_changes sc
        LEFT JOIN analytics.leads_cohort lc ON lc.lead_id = sc.lead_id
        WHERE sc.pipeline IN (${pipelines})
          AND sc.status NOT IN (${terminalList})
          AND sc.event_at >= '${fromLit}' AND sc.event_at <= '${toLit}'
          AND COALESCE(lc.is_deleted, FALSE) = FALSE
          ${detailFilters(sp)}
      )
    `;

    if (view === "avg_summary") {
      const query = `
        ${intervalsCte}
        SELECT
          pipeline,
          status,
          responsible,
          COUNT(*)::int AS stays,
          AVG(EXTRACT(EPOCH FROM (exit_at - event_at)))::bigint AS avg_seconds
        FROM intervals
        GROUP BY pipeline, status, responsible
      `;
      const res = await analyticsDb.execute<{
        pipeline: string;
        status: string;
        responsible: string;
        stays: number;
        avg_seconds: string;
      }>(sql.raw(query));
      return NextResponse.json({
        view,
        rows: res.rows.map((r) => ({
          pipeline: r.pipeline,
          status: r.status,
          responsible: r.responsible,
          stays: Number(r.stays),
          avgSeconds: Number(r.avg_seconds),
        })),
      });
    }

    // avg_detail — плоский лог пребываний, свежие сверху.
    const limit = clampInt(sp.get("limit"), 100, 500);
    const offset = clampInt(sp.get("offset"), 0, 1_000_000);
    const query = `
      ${intervalsCte}
      SELECT
        lead_id,
        pipeline,
        status,
        -- Timestamp'ы отдаём готовыми берлинскими строками: raw-SQL через
        -- neon-драйвер парсит naive timestamp неоднозначно (server-local),
        -- поэтому конверсия и формат фиксируются на стороне Postgres.
        to_char(event_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') AS enter_berlin,
        CASE WHEN next_event_at IS NULL THEN NULL
             ELSE to_char(next_event_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS')
        END AS exit_berlin,
        EXTRACT(EPOCH FROM (exit_at - event_at))::bigint AS seconds,
        responsible,
        COUNT(*) OVER ()::int AS total
      FROM intervals
      ORDER BY event_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const res = await analyticsDb.execute<{
      lead_id: string;
      pipeline: string;
      status: string;
      enter_berlin: string;
      exit_berlin: string | null;
      seconds: string;
      responsible: string;
      total: number;
    }>(sql.raw(query));
    const total = res.rows.length > 0 ? Number(res.rows[0].total) : 0;
    return NextResponse.json({
      view,
      total,
      rows: res.rows.map((r) => ({
        leadId: Number(r.lead_id),
        pipeline: r.pipeline,
        status: r.status,
        enterAt: r.enter_berlin,
        exitAt: r.exit_berlin,
        seconds: Number(r.seconds),
        responsible: r.responsible,
      })),
    });
  } catch (error) {
    console.error("[reglament] error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
