import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { unwrapRows } from "@/lib/funnel/compute";
import { getOkkByLead } from "@/lib/funnel/okk-by-lead";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/funnel/correlation?factor=bot|language|okk&view=segments|time
 * Связь фактора с Гутшайном на РЕШЁННЫХ берётер-сделках (статус WON 142 / LOST 143).
 *  • view=segments — win-rate по упорядоченным сегментам фактора + средняя + corr.
 *  • view=time     — win-rate по месяцам когорты для 2 макро-сегментов (скользящее
 *                    за 3 мес), с пометкой незрелых последних месяцев.
 * Только analytics-БД (+ D2 для фактора «balls ОКК» через getOkkByLead).
 */

const BERATER = 12154099;
const WON = 142;
const LOST = 143;
const BOT_ERA = "2026-04-01";
const MIN_WINDOW_N = 10; // меньше — точку «по времени» не рисуем (разрыв линии)

// Один наблюдаемый лид: исход + к какому fine-сегменту и макро-группе относится.
interface LeadRow {
  won: number; // 0/1
  month: string; // YYYY-MM (когорта по created_at)
  seg: string; // ключ fine-сегмента (для вида «сегменты»)
  macro: "a" | "b"; // 2 макро-группы (для вида «время»)
  metric: number; // числовое значение для коэффициента корреляции
}

interface FactorData {
  factor: string;
  label: string;
  population: string;
  caveat: string;
  segOrder: { key: string; label: string }[]; // fine-сегменты по порядку
  macro: { aLabel: string; bLabel: string }; // a = выше/больше, b = базовая
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

// ── Сборщики данных по фактору ───────────────────────────────────────────────

function botBucket(rp: number): string {
  if (rp === 0) return "0";
  if (rp <= 2) return "1-2";
  if (rp <= 4) return "3-4";
  return "5+";
}

async function botData(): Promise<FactorData> {
  const raw = unwrapRows<{ won: number | string; month: string; rp: number | string }>(
    await analyticsDb.execute(sql`
      WITH bot AS (
        SELECT lead_id, count(*) AS cnt FROM analytics.bot_roleplays
        WHERE lead_id IS NOT NULL GROUP BY lead_id)
      SELECT (lc.status_id = ${WON})::int AS won,
             to_char(lc.created_at, 'YYYY-MM') AS month,
             COALESCE(bot.cnt, 0) AS rp
      FROM analytics.leads_cohort lc
      LEFT JOIN bot ON bot.lead_id = lc.lead_id
      WHERE lc.pipeline_id = ${BERATER} AND lc.is_deleted = FALSE
        AND lc.status_id IN (${WON}, ${LOST})
        AND lc.created_at >= ${BOT_ERA}`),
  );
  return {
    factor: "bot",
    label: "Ролевки с ботом",
    population: "решённые сделки с апреля 2026 (старт бота)",
    caveat:
      "Тренируются мотивированные клиенты — это корреляция, не причина. Верхние бакеты и свежие месяцы малы.",
    segOrder: [
      { key: "0", label: "0 ролевок" }, { key: "1-2", label: "1–2" },
      { key: "3-4", label: "3–4" }, { key: "5+", label: "5+" },
    ],
    macro: { aLabel: "Тренировался", bLabel: "Не тренировался" },
    rows: raw.map((r) => {
      const rp = Number(r.rp);
      return { won: Number(r.won), month: String(r.month), seg: botBucket(rp), macro: rp > 0 ? "a" : "b", metric: rp };
    }),
  };
}

async function languageData(): Promise<FactorData> {
  const raw = unwrapRows<{ won: number | string; month: string; lang: string }>(
    await analyticsDb.execute(sql`
      SELECT (status_id = ${WON})::int AS won,
             to_char(created_at, 'YYYY-MM') AS month,
             CASE
               WHEN TRIM(language_level) ILIKE 'A1%' THEN 'a1'
               WHEN TRIM(language_level) ILIKE 'B1%' THEN 'b1'
               WHEN TRIM(language_level) ILIKE 'B2%' THEN 'b2'
               WHEN TRIM(language_level) ILIKE 'C1%' OR TRIM(language_level) ILIKE 'C2%' THEN 'c1'
               ELSE 'a2' END AS lang
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${BERATER} AND is_deleted = FALSE
        AND status_id IN (${WON}, ${LOST})`),
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
      .map((r) => ({ won: Number(r.won), month: String(r.month), lang: String(r.lang) }))
      .filter((d) => d.lang !== "a1") // A1 не идёт в аналитику
      .map((d) => ({ won: d.won, month: d.month, seg: d.lang, macro: (d.lang === "b2" || d.lang === "c1" ? "a" : "b"), metric: rank[d.lang] })),
  };
}

function okkBucket(s: number): string {
  if (s < 60) return "<60";
  if (s < 75) return "60-74";
  if (s < 90) return "75-89";
  return "90+";
}

async function okkData(): Promise<FactorData> {
  const raw = unwrapRows<{ won: number | string; month: string; lead: number | string }>(
    await analyticsDb.execute(sql`
      SELECT (status_id = ${WON})::int AS won,
             to_char(created_at, 'YYYY-MM') AS month, lead_id AS lead
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${BERATER} AND is_deleted = FALSE
        AND status_id IN (${WON}, ${LOST})`),
  );
  const leads = raw
    .map((r) => ({ won: Number(r.won), month: String(r.month), id: Number(r.lead) }))
    .filter((l) => Number.isInteger(l.id) && l.id > 0);
  const okk = await getOkkByLead(leads.map((l) => l.id));
  return {
    factor: "okk",
    label: "Балл ОКК",
    population: "решённые сделки с оценкой ОКК (всё время)",
    caveat:
      "Балл ОКК по чек-листу почти НЕ связан с Гутшайном — качество звонка не предсказывает закрытие. Низкие бакеты малы.",
    segOrder: [
      { key: "<60", label: "< 60" }, { key: "60-74", label: "60–74" },
      { key: "75-89", label: "75–89" }, { key: "90+", label: "90+" },
    ],
    macro: { aLabel: "90+", bLabel: "< 90" },
    rows: leads
      .map((l) => ({ ...l, score: okk.get(l.id)?.dealOkk ?? null }))
      .filter((l): l is typeof l & { score: number } => typeof l.score === "number")
      .map((l) => ({ won: l.won, month: l.month, seg: okkBucket(l.score), macro: l.score >= 90 ? "a" : "b", metric: l.score })),
  };
}

async function loadFactor(factor: string): Promise<FactorData> {
  if (factor === "language") return languageData();
  if (factor === "okk") return okkData();
  return botData();
}

// ── Вид «По сегментам» ───────────────────────────────────────────────────────

function buildSegments(fd: FactorData) {
  const segments = fd.segOrder.map((s) => {
    const rows = fd.rows.filter((r) => r.seg === s.key);
    const won = rows.reduce((a, r) => a + r.won, 0);
    return { key: s.key, label: s.label, decided: rows.length, won, winPct: pct(won, rows.length), small: rows.length > 0 && rows.length < 15 };
  });
  const totalWon = fd.rows.reduce((a, r) => a + r.won, 0);
  const overallPct = pct(totalWon, fd.rows.length);
  const corr = pearson(fd.rows.map((r) => r.metric), fd.rows.map((r) => r.won));
  // topline — только для монотонных факторов (язык, бот); у ОКК связи нет.
  const lo = segments[0], hi = segments[segments.length - 1];
  const topline =
    fd.factor === "okk"
      ? null
      : {
          leftLabel: hi.label, leftPct: hi.winPct, leftN: hi.decided,
          rightLabel: lo.label, rightPct: lo.winPct, rightN: lo.decided,
          ratio: lo.winPct > 0 ? Math.round((10 * hi.winPct) / lo.winPct) / 10 : null,
        };
  return {
    view: "segments" as const, factor: fd.factor, label: fd.label, population: fd.population,
    segments, overallPct, corr, topline, caveat: fd.caveat,
  };
}

// ── Вид «По времени» ─────────────────────────────────────────────────────────

function nowMonthMinus(months: number): string {
  // Текущий месяц минус N (для пометки незрелых). Date в route доступен.
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function buildTime(fd: FactorData) {
  // месяц → макро → {decided, won}
  const byMonth = new Map<string, { a: { d: number; w: number }; b: { d: number; w: number } }>();
  for (const r of fd.rows) {
    let m = byMonth.get(r.month);
    if (!m) { m = { a: { d: 0, w: 0 }, b: { d: 0, w: 0 } }; byMonth.set(r.month, m); }
    const cell = m[r.macro];
    cell.d += 1; cell.w += r.won;
  }
  const months = Array.from(byMonth.keys()).sort();
  const immatureFrom = nowMonthMinus(2); // последние ~2 месяца ещё зреют
  const points = months.map((mon, i) => {
    // скользящее за 3 мес (текущий + 2 предыдущих ПРИСУТСТВУЮЩИХ месяца)
    const window = months.slice(Math.max(0, i - 2), i + 1);
    const agg = (k: "a" | "b") => window.reduce(
      (acc, w) => { const c = byMonth.get(w)![k]; return { d: acc.d + c.d, w: acc.w + c.w }; },
      { d: 0, w: 0 },
    );
    const a = agg("a"), b = agg("b");
    return {
      month: mon,
      a: a.d >= MIN_WINDOW_N ? pct(a.w, a.d) : null, aN: a.d,
      b: b.d >= MIN_WINDOW_N ? pct(b.w, b.d) : null, bN: b.d,
      immature: mon >= immatureFrom,
    };
  });
  return {
    view: "time" as const, factor: fd.factor, label: fd.label, population: fd.population,
    series: [
      { key: "a", label: fd.macro.aLabel },
      { key: "b", label: fd.macro.bLabel },
    ],
    points,
    caveat: fd.caveat + " По месяцам — скользящее за 3 мес; пунктир — месяцы ещё не дозрели.",
  };
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const factor = sp.get("factor") ?? "bot";
  const view = sp.get("view") === "time" ? "time" : "segments";
  try {
    const fd = await loadFactor(factor);
    const payload = view === "time" ? buildTime(fd) : buildSegments(fd);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[/api/funnel/correlation] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
