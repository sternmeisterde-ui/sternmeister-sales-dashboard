import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { unwrapRows } from "@/lib/funnel/compute";
import { getOkkByLead } from "@/lib/funnel/okk-by-lead";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/funnel/correlation?factor=bot|language|okk|readiness
 * Связь фактора с Гутшайном на РЕШЁННЫХ берётер-сделках (WON 142 / LOST 143).
 * Возвращает ОБА вида:
 *  • segments — win-rate по упорядоченным сегментам + средняя + corr (для столбиков справа).
 *  • points   — дневное скользящее win-rate (за TIME_WINDOW дней) по ДАТЕ закрытия
 *               сделки, для 2 макро-сегментов (для линии по времени слева).
 * Только analytics-БД (+ D2 для «balls ОКК» через getOkkByLead).
 */

// Вертикаль (мед-админ, spec 21): панель корреляции работает по решённым
// сделкам Бератер-воронок выбранной вертикали. Кампания бота — буховая, но
// связка идёт по lead_id и для мед просто даст «мало данных» (честно).
import { getBeraterPipelineIds, type Vertical } from "@/lib/kommo/pipeline-config";

const WON = 142;
const LOST = 143;
const TIME_WINDOW = 30; // дней — окно скользящего win-rate
const TIME_MIN_N = 15; // меньше в окне → точку не рисуем

interface LeadRow {
  won: number; // 0/1
  resDate: string | null; // YYYY-MM-DD дата закрытия (для линии по времени)
  seg: string; // ключ fine-сегмента
  macro: "a" | "b"; // 2 макро-группы (для линии по времени)
  metric: number; // числовое значение для коэффициента корреляции
}

interface FactorData {
  factor: string;
  label: string;
  population: string;
  caveat: string;
  segOrder: { key: string; label: string }[];
  macro: { aLabel: string; bLabel: string };
  rows: LeadRow[];
}

const pct = (won: number, n: number) => (n > 0 ? Math.round((1000 * won) / n) / 10 : 0);

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return Math.round((sxy / Math.sqrt(sxx * syy)) * 100) / 100;
}

// ── Vertical-хелперы: воронки Бератера выбранной вертикали ──────────────────
const beraterIn = (vertical?: Vertical) =>
  sql.join(getBeraterPipelineIds(vertical).map((id) => sql`${id}`), sql`, `);

// Подзапрос даты закрытия (последнее событие WON/LOST)
const resAtJoin = (vertical?: Vertical) => sql`
  LEFT JOIN (
    SELECT lead_id, max(event_at) AS res_at
    FROM analytics.lead_status_changes
    WHERE pipeline_id IN (${beraterIn(vertical)}) AND status_id IN (${WON}, ${LOST})
    GROUP BY lead_id
  ) res ON res.lead_id = lc.lead_id`;

// ── Сборщики данных по фактору ───────────────────────────────────────────────

function botBucket(rp: number): string {
  if (rp === 0) return "0";
  if (rp <= 2) return "1-2";
  if (rp <= 4) return "3-4";
  return "5+";
}

async function botData(vertical?: Vertical): Promise<FactorData> {
  // Старт бот-эры = первая зафиксированная ролевка (раньше бота не было, и лиды
  // тех дат нельзя считать «не тренировался» — у них не было возможности).
  const startRow = unwrapRows<{ s: string | null }>(
    await analyticsDb.execute(sql`SELECT min(substring(finished_at, 1, 10)) AS s FROM analytics.bot_roleplays WHERE finished_at IS NOT NULL`),
  );
  const botStart = startRow[0]?.s ?? "2026-05-01";
  const raw = unwrapRows<{ won: number | string; res_date: string | null; rp: number | string }>(
    await analyticsDb.execute(sql`
      WITH bot AS (
        SELECT lead_id, count(*) AS cnt FROM analytics.bot_roleplays
        WHERE lead_id IS NOT NULL GROUP BY lead_id)
      SELECT (lc.status_id = ${WON})::int AS won,
             to_char(res.res_at, 'YYYY-MM-DD') AS res_date,
             COALESCE(bot.cnt, 0) AS rp
      FROM analytics.leads_cohort lc
      LEFT JOIN bot ON bot.lead_id = lc.lead_id
      ${resAtJoin(vertical)}
      WHERE lc.pipeline_id IN (${beraterIn(vertical)}) AND lc.is_deleted = FALSE
        AND lc.exclude_from_analytics = FALSE
        AND lc.status_id IN (${WON}, ${LOST})
        -- тренировавшихся берём всех; «не тренировался» — только после старта бота
        -- (у них была возможность). Иначе дотбот-лиды раздувают «не тренировался».
        AND (COALESCE(bot.cnt, 0) > 0 OR lc.created_at >= ${botStart})`),
  );
  return {
    factor: "bot",
    label: "Ролевки с ботом",
    population: `решённые сделки с ${botStart} (старт бота)`,
    caveat: "Тренируются мотивированные клиенты — это корреляция, не причина. Верхние бакеты малы.",
    segOrder: [
      { key: "0", label: "0 ролевок" }, { key: "1-2", label: "1–2" },
      { key: "3-4", label: "3–4" }, { key: "5+", label: "5+" },
    ],
    macro: { aLabel: "Тренировался", bLabel: "Не тренировался" },
    rows: raw.map((r) => {
      const rp = Number(r.rp);
      return { won: Number(r.won), resDate: r.res_date ?? null, seg: botBucket(rp), macro: rp > 0 ? "a" : "b", metric: rp };
    }),
  };
}

async function languageData(vertical?: Vertical): Promise<FactorData> {
  const raw = unwrapRows<{ won: number | string; res_date: string | null; lang: string }>(
    await analyticsDb.execute(sql`
      SELECT (lc.status_id = ${WON})::int AS won,
             to_char(res.res_at, 'YYYY-MM-DD') AS res_date,
             CASE
               WHEN TRIM(lc.language_level) ILIKE 'A1%' THEN 'a1'
               WHEN TRIM(lc.language_level) ILIKE 'B1%' THEN 'b1'
               WHEN TRIM(lc.language_level) ILIKE 'B2%' THEN 'b2'
               WHEN TRIM(lc.language_level) ILIKE 'C1%' OR TRIM(lc.language_level) ILIKE 'C2%' THEN 'c1'
               ELSE 'a2' END AS lang
      FROM analytics.leads_cohort lc
      ${resAtJoin(vertical)}
      WHERE lc.pipeline_id IN (${beraterIn(vertical)}) AND lc.is_deleted = FALSE
        AND lc.exclude_from_analytics = FALSE
        AND lc.status_id IN (${WON}, ${LOST})`),
  );
  const rank: Record<string, number> = { a2: 0, b1: 1, b2: 2, c1: 3 };
  return {
    factor: "language",
    label: "Уровень языка",
    population: "решённые сделки (всё время)",
    caveat: "A1 («не квал по языку») исключён. Это корреляция, не причина.",
    segOrder: [
      { key: "a2", label: "A2" }, { key: "b1", label: "B1" },
      { key: "b2", label: "B2" }, { key: "c1", label: "C1" },
    ],
    macro: { aLabel: "B2–C1 (выше)", bLabel: "A2–B1" },
    rows: raw
      .map((r) => ({ won: Number(r.won), resDate: r.res_date ?? null, lang: String(r.lang) }))
      .filter((d) => d.lang !== "a1")
      .map((d) => ({ won: d.won, resDate: d.resDate, seg: d.lang, macro: (d.lang === "b2" || d.lang === "c1" ? "a" : "b") as "a" | "b", metric: rank[d.lang] })),
  };
}

function okkBucket(s: number): string {
  if (s < 60) return "<60";
  if (s < 75) return "60-74";
  if (s < 90) return "75-89";
  return "90+";
}

async function okkData(vertical?: Vertical): Promise<FactorData> {
  const raw = unwrapRows<{ won: number | string; res_date: string | null; lead: number | string }>(
    await analyticsDb.execute(sql`
      SELECT (lc.status_id = ${WON})::int AS won,
             to_char(res.res_at, 'YYYY-MM-DD') AS res_date, lc.lead_id AS lead
      FROM analytics.leads_cohort lc
      ${resAtJoin(vertical)}
      WHERE lc.pipeline_id IN (${beraterIn(vertical)}) AND lc.is_deleted = FALSE
        AND lc.exclude_from_analytics = FALSE
        AND lc.status_id IN (${WON}, ${LOST})`),
  );
  const leads = raw
    .map((r) => ({ won: Number(r.won), resDate: r.res_date ?? null, id: Number(r.lead) }))
    .filter((l) => Number.isInteger(l.id) && l.id > 0);
  const okk = await getOkkByLead(leads.map((l) => l.id));
  return {
    factor: "okk",
    label: "Балл ОКК",
    population: "решённые сделки с оценкой ОКК (всё время)",
    caveat: "Балл ОКК по чек-листу почти НЕ связан с Гутшайном — качество звонка не предсказывает закрытие. Низкие бакеты малы.",
    segOrder: [
      { key: "<60", label: "< 60" }, { key: "60-74", label: "60–74" },
      { key: "75-89", label: "75–89" }, { key: "90+", label: "90+" },
    ],
    macro: { aLabel: "90+", bLabel: "< 90" },
    rows: leads
      .map((l) => ({ ...l, score: okk.get(l.id)?.dealOkk ?? null }))
      .filter((l): l is typeof l & { score: number } => typeof l.score === "number")
      .map((l) => ({ won: l.won, resDate: l.resDate, seg: okkBucket(l.score), macro: (l.score >= 90 ? "a" : "b") as "a" | "b", metric: l.score })),
  };
}

function readinessBucket(avg: number): string {
  if (avg < 2.5) return "<2.5";
  if (avg < 3.5) return "2.5-3.4";
  if (avg < 4.5) return "3.5-4.4";
  return "4.5+";
}

/**
 * Уровень подготовки клиента = средний балл его ролевок (score_5, 1–5, обе
 * стороны). Связь со Гутшайном на решённых сделках: получившие Гутшайн против
 * не получивших. Клиенты без ролевок исключены (уровня подготовки нет).
 */
async function readinessData(vertical?: Vertical): Promise<FactorData> {
  const raw = unwrapRows<{ won: number | string; res_date: string | null; avg5: number | string }>(
    await analyticsDb.execute(sql`
      WITH rp AS (
        SELECT lead_id, AVG(score_5)::float AS avg5
        FROM analytics.client_roleplays
        WHERE score_5 IS NOT NULL
        GROUP BY lead_id
      )
      SELECT (lc.status_id = ${WON})::int AS won,
             to_char(res.res_at, 'YYYY-MM-DD') AS res_date,
             rp.avg5 AS avg5
      FROM analytics.leads_cohort lc
      JOIN rp ON rp.lead_id = lc.lead_id
      ${resAtJoin(vertical)}
      WHERE lc.pipeline_id IN (${beraterIn(vertical)}) AND lc.is_deleted = FALSE
        AND lc.exclude_from_analytics = FALSE
        AND lc.status_id IN (${WON}, ${LOST})`),
  );
  return {
    factor: "readiness",
    label: "Уровень готовности",
    population: "решённые сделки с ролевками (всё время)",
    caveat: "Уровень = средний балл ролевок клиента (1–5). Клиенты без ролевок исключены. Это корреляция, не причина.",
    segOrder: [
      { key: "<2.5", label: "< 2.5" }, { key: "2.5-3.4", label: "2.5–3.4" },
      { key: "3.5-4.4", label: "3.5–4.4" }, { key: "4.5+", label: "4.5+" },
    ],
    macro: { aLabel: "Готовы (≥3.5)", bLabel: "Слабо (<3.5)" },
    rows: raw
      .map((r) => ({ won: Number(r.won), resDate: r.res_date ?? null, avg5: Number(r.avg5) }))
      .filter((d) => Number.isFinite(d.avg5))
      .map((d) => ({
        won: d.won,
        resDate: d.resDate,
        seg: readinessBucket(d.avg5),
        macro: (d.avg5 >= 3.5 ? "a" : "b") as "a" | "b",
        metric: d.avg5,
      })),
  };
}

async function loadFactor(factor: string, vertical?: Vertical): Promise<FactorData> {
  if (factor === "language") return languageData(vertical);
  if (factor === "okk") return okkData(vertical);
  if (factor === "readiness") return readinessData(vertical);
  return botData(vertical);
}

// ── Вид «По сегментам» (столбики) ────────────────────────────────────────────

function buildSegments(fd: FactorData) {
  const segments = fd.segOrder.map((s) => {
    const rows = fd.rows.filter((r) => r.seg === s.key);
    const won = rows.reduce((a, r) => a + r.won, 0);
    return { key: s.key, label: s.label, decided: rows.length, won, winPct: pct(won, rows.length), small: rows.length > 0 && rows.length < 15 };
  });
  const totalWon = fd.rows.reduce((a, r) => a + r.won, 0);
  const overallPct = pct(totalWon, fd.rows.length);
  const corr = pearson(fd.rows.map((r) => r.metric), fd.rows.map((r) => r.won));
  const lo = segments[0], hi = segments[segments.length - 1];
  const topline =
    fd.factor === "okk" ? null
    : {
        leftLabel: hi.label, leftPct: hi.winPct, leftN: hi.decided,
        rightLabel: lo.label, rightPct: lo.winPct, rightN: lo.decided,
        ratio: lo.winPct > 0 ? Math.round((10 * hi.winPct) / lo.winPct) / 10 : null,
      };
  return { segments, overallPct, corr, topline };
}

// ── Вид «По времени» (дневное скользящее по дате закрытия) ────────────────────

function addDays(s: string, n: number): string {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function buildTime(fd: FactorData) {
  const rows = fd.rows.filter((r) => r.resDate) as (LeadRow & { resDate: string })[];
  if (rows.length === 0) {
    return { series: [{ key: "a", label: fd.macro.aLabel }, { key: "b", label: fd.macro.bLabel }], points: [] };
  }
  rows.sort((x, y) => (x.resDate < y.resDate ? -1 : 1));
  const minDate = rows[0].resDate;
  const maxDate = rows[rows.length - 1].resDate;

  // Перечисляем календарные дни и для каждого считаем окно [day-W+1, day].
  // Двигаем два указателя по отсортированным rows (скользящее окно).
  const points: { date: string; a: number | null; aN: number; b: number | null; bN: number }[] = [];
  let lo = 0, hi = 0; // [lo, hi) — индексы строк в текущем окне
  for (let day = minDate; day <= maxDate; day = addDays(day, 1)) {
    const from = addDays(day, -(TIME_WINDOW - 1));
    while (hi < rows.length && rows[hi].resDate <= day) hi++;
    while (lo < hi && rows[lo].resDate < from) lo++;
    let aD = 0, aW = 0, bD = 0, bW = 0;
    for (let i = lo; i < hi; i++) {
      const r = rows[i];
      if (r.macro === "a") { aD++; aW += r.won; } else { bD++; bW += r.won; }
    }
    points.push({
      date: day,
      a: aD >= TIME_MIN_N ? pct(aW, aD) : null, aN: aD,
      b: bD >= TIME_MIN_N ? pct(bW, bD) : null, bN: bD,
    });
  }
  // Общий период: обрезаем до диапазона, где есть ОБЕ линии (обе стартуют/кончаются
  // вместе, без пустоты слева) — графики сравнимы напрямую.
  const both = points.map((p, i) => (p.a != null && p.b != null ? i : -1)).filter((i) => i >= 0);
  const trimmed = both.length ? points.slice(both[0], both[both.length - 1] + 1) : [];
  return {
    series: [{ key: "a", label: fd.macro.aLabel }, { key: "b", label: fd.macro.bLabel }],
    points: trimmed,
  };
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const factor = req.nextUrl.searchParams.get("factor") ?? "bot";
  const rawVertical = req.nextUrl.searchParams.get("vertical");
  const vertical: Vertical | undefined =
    rawVertical === "buh" || rawVertical === "med" || rawVertical === "all"
      ? rawVertical
      : undefined;
  try {
    const fd = await loadFactor(factor, vertical);
    // Пояснение к «слабому» коэффициенту при заметной разнице линий: Пирсон
    // считается ПО ОТДЕЛЬНЫМ сделкам (исход 0/1), и когда одна из групп мала,
    // даже двукратная разница win-rate даёт невысокое значение — это норма.
    const aN = fd.rows.filter((r) => r.macro === "a").length;
    const caveat =
      `${fd.caveat} Коэффициент считается по каждой сделке (исход 0/1): ` +
      `группа «${fd.macro.aLabel}» — ${aN} из ${fd.rows.length} решённых, ` +
      `при малой группе даже большая разница win-rate даёт невысокое значение.`;
    const payload = {
      factor: fd.factor, label: fd.label, population: fd.population, caveat,
      windowDays: TIME_WINDOW,
      ...buildSegments(fd),
      ...buildTime(fd),
    };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[/api/funnel/correlation] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
