import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { unwrapRows } from "@/lib/funnel/compute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/funnel/correlation?factor=bot|language
 * Связь фактора с Гутшайном на РЕШЁННЫХ берётер-сделках (статус WON 142 / LOST 143).
 * Считаем win-rate (доля Гутшайна среди решённых) по сегментам фактора + общий
 * коэффициент корреляции. «В работе» лиды исключены — у них исхода ещё нет.
 * Только admin. Только analytics-БД (без D2).
 */

const BERATER = 12154099;
const WON = 142;
const LOST = 143;
const BOT_ERA = "2026-04-01"; // бот ролевок запущен в апреле 2026

interface Segment {
  key: string;
  label: string;
  decided: number; // решённых сделок в сегменте
  won: number; // из них Гутшайн
  winPct: number; // % (1 знак)
  small: boolean; // выборка мала (< 15) — верить по отдельности рано
}

interface CorrelationPayload {
  factor: string;
  label: string;
  population: string;
  segments: Segment[];
  topline: {
    leftLabel: string; leftPct: number; leftN: number;
    rightLabel: string; rightPct: number; rightN: number;
    ratio: number | null;
  } | null;
  corr: number | null; // коэффициент корреляции с исходом
  caveat: string;
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

function seg(key: string, label: string, rows: { won: number }[]): Segment {
  const won = rows.reduce((s, r) => s + r.won, 0);
  return { key, label, decided: rows.length, won, winPct: pct(won, rows.length), small: rows.length > 0 && rows.length < 15 };
}

async function botFactor(): Promise<CorrelationPayload> {
  const rows = unwrapRows<{ won: number | string; rp: number | string }>(
    await analyticsDb.execute(sql`
      WITH bot AS (
        SELECT lead_id, count(*) AS cnt FROM analytics.bot_roleplays
        WHERE lead_id IS NOT NULL GROUP BY lead_id)
      SELECT (lc.status_id = ${WON})::int AS won, COALESCE(bot.cnt, 0) AS rp
      FROM analytics.leads_cohort lc
      LEFT JOIN bot ON bot.lead_id = lc.lead_id
      WHERE lc.pipeline_id = ${BERATER} AND lc.is_deleted = FALSE
        AND lc.status_id IN (${WON}, ${LOST})
        AND lc.created_at >= ${BOT_ERA}`),
  );
  const data = rows.map((r) => ({ won: Number(r.won), rp: Number(r.rp) }));
  const segments = [
    seg("0", "0 ролевок", data.filter((d) => d.rp === 0)),
    seg("1-2", "1–2", data.filter((d) => d.rp >= 1 && d.rp <= 2)),
    seg("3-4", "3–4", data.filter((d) => d.rp >= 3 && d.rp <= 4)),
    seg("5+", "5+", data.filter((d) => d.rp >= 5)),
  ];
  const trained = data.filter((d) => d.rp > 0);
  const untrained = data.filter((d) => d.rp === 0);
  const tPct = pct(trained.reduce((s, d) => s + d.won, 0), trained.length);
  const uPct = pct(untrained.reduce((s, d) => s + d.won, 0), untrained.length);
  return {
    factor: "bot",
    label: "Ролевки с ботом",
    population: "решённые сделки с апреля 2026 (старт бота)",
    segments,
    topline: {
      leftLabel: "Тренировался", leftPct: tPct, leftN: trained.length,
      rightLabel: "Не тренировался", rightPct: uPct, rightN: untrained.length,
      ratio: uPct > 0 ? Math.round((10 * tPct) / uPct) / 10 : null,
    },
    corr: pearson(data.map((d) => d.rp), data.map((d) => d.won)),
    caveat:
      "Верхние бакеты по числу ролевок пока малы. Тренируются мотивированные клиенты — это корреляция, не доказательство причины.",
  };
}

async function languageFactor(): Promise<CorrelationPayload> {
  const rows = unwrapRows<{ won: number | string; lang: string }>(
    await analyticsDb.execute(sql`
      SELECT (status_id = ${WON})::int AS won,
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
  // A1 = «не квал по языку» — из аналитики исключён.
  const data = rows
    .map((r) => ({ won: Number(r.won), lang: String(r.lang) }))
    .filter((d) => d.lang !== "a1");
  const levels: { key: string; label: string; rank: number }[] = [
    { key: "a2", label: "A2", rank: 0 },
    { key: "b1", label: "B1", rank: 1 },
    { key: "b2", label: "B2", rank: 2 },
    { key: "c1", label: "C1", rank: 3 },
  ];
  const segments = levels.map((l) => seg(l.key, l.label, data.filter((d) => d.lang === l.key)));
  const rankByKey = Object.fromEntries(levels.map((l) => [l.key, l.rank]));
  const lo = segments[0];
  const hi = segments[segments.length - 1];
  return {
    factor: "language",
    label: "Уровень языка",
    population: "решённые сделки (всё время)",
    segments,
    topline: {
      leftLabel: hi.label, leftPct: hi.winPct, leftN: hi.decided,
      rightLabel: lo.label, rightPct: lo.winPct, rightN: lo.decided,
      ratio: lo.winPct > 0 ? Math.round((10 * hi.winPct) / lo.winPct) / 10 : null,
    },
    corr: pearson(data.map((d) => rankByKey[d.lang]), data.map((d) => d.won)),
    caveat: "A1 («не квал по языку») исключён из аналитики. Это корреляция, не причинность.",
  };
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const factor = req.nextUrl.searchParams.get("factor") ?? "bot";
  try {
    const payload = factor === "language" ? await languageFactor() : await botFactor();
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[/api/funnel/correlation] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
