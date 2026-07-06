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
import { FUNNEL_PIPELINES, type FunnelKey } from "@/lib/reglament/norms";

export const dynamic = "force-dynamic";

const VALID_VIEWS = new Set(["avg_summary", "avg_detail", "sla"]);

/** Терминальные статусы: пребывание в них не является «этапом работы» —
 *  исключаем из среднего времени (в Looker-пивоте их тоже нет). */
const TERMINAL_STATUSES = [
  "Успешно реализовано",
  "Закрыто и не реализовано",
  "Игнор",
  "Рассрочка",
  "Счет выставлен",
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
