// GET /api/daily/range?department=b2g&month=2026-03&mode=days[&vertical=buh|med|all]
// Returns array of daily snapshots for every day in a month (or every month in a year)
import { NextRequest, NextResponse } from "next/server";
import { buildDailyResponseCached, getBusinessToday } from "@/lib/daily/build-response";
import type { Vertical } from "@/lib/kommo/pipeline-config";

const ALLOWED_DEPARTMENTS = new Set(["b2g", "b2b"]);
const ALLOWED_MODES = new Set(["days", "weeks", "months"]);
// Mirror /api/daily — burst-dedup on server, browser/edge can serve a 30s
// fresh copy + another 60s stale-while-revalidate window.
const CACHE_HEADER = "private, max-age=30, stale-while-revalidate=60";

function jsonOk<T>(data: T) {
  return NextResponse.json(data, { headers: { "Cache-Control": CACHE_HEADER } });
}

// Sequential fetch with concurrency limit to avoid hammering Kommo API.
// Past dates with DB snapshots resolve instantly; only "live" dates hit Kommo.
async function fetchWithConcurrency<T>(
  items: string[],
  fetcher: (item: string) => Promise<T>,
  concurrency = 3,
): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fetcher(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department") ?? "b2g";
    const mode = url.searchParams.get("mode") ?? "days";
    const monthParam = url.searchParams.get("month") ?? "";

    if (!ALLOWED_DEPARTMENTS.has(department)) {
      return NextResponse.json({ error: `Invalid department: ${department}` }, { status: 400 });
    }
    if (!ALLOWED_MODES.has(mode)) {
      return NextResponse.json({ error: `Invalid mode: ${mode} (expected days|weeks|months)` }, { status: 400 });
    }

    // Вертикаль (только b2g, spec 21). Без параметра → legacy (бух).
    const rawVertical = url.searchParams.get("vertical");
    const vertical: Vertical | undefined =
      department === "b2g" && (rawVertical === "buh" || rawVertical === "med" || rawVertical === "all")
        ? rawVertical
        : undefined;

    if (mode === "days") {
      const [yearStr, monthStr] = monthParam.split("-");
      const year = Number(yearStr);
      const month = Number(monthStr);
      if (!year || !month) {
        return NextResponse.json({ error: "Invalid month param, expected YYYY-MM" }, { status: 400 });
      }

      const daysInMonth = new Date(year, month, 0).getDate();
      const today = getBusinessToday();
      // Data starts from March 24, 2026 — skip earlier dates
      const DATA_START = new Date(2026, 0, 1); // January 1, 2026
      const dates: string[] = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const dateObj = new Date(year, month - 1, d);
        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        // Skip future dates and dates before data start
        if (dateObj >= DATA_START && dateStr <= today) {
          dates.push(dateStr);
        }
      }

      if (dates.length === 0) {
        return jsonOk({
          mode: "days",
          month: monthParam,
          days: [],
          monthlySummary: null,
        });
      }

      // Каждый buildDailyResponse внутри делает ~10 параллельных Neon-запросов,
      // так что 8 × 10 = 80+ одновременных HTTP-fetch'ей перегрузили Neon
      // serverless (видели fetch failed с двумя ретраями в логах 2026-04-24).
      // Concurrency=4 даёт ~40 одновременных — стабильно, умеренно быстро.
      // Monthly summary идёт параллельно — это "+1 билд", не влияет на лимит.
      const monthDate = `${year}-${String(month).padStart(2, "0")}-01`;
      const [results, monthlySummary] = await Promise.all([
        fetchWithConcurrency(
          dates,
          (dateStr) => buildDailyResponseCached(department, "day", dateStr, vertical),
          4,
        ),
        buildDailyResponseCached(department, "month", monthDate, vertical),
      ]);

      return jsonOk({
        mode: "days",
        month: monthParam,
        days: results,
        monthlySummary,
      });
    }

    if (mode === "weeks") {
      // Недели выбранного месяца (Mon-Sun), пересекающиеся с месяцем.
      // Каждая неделя репрезентируется датой её ПОНЕДЕЛЬНИКА.
      // В ответе — массив 4-5 snapshot'ов, каждый — результат buildDailyResponseCached("week", mondayDate).
      const [yearStr, monthStr] = monthParam.split("-");
      const year = Number(yearStr);
      const month = Number(monthStr);
      if (!year || !month) {
        return NextResponse.json({ error: "Invalid month param, expected YYYY-MM" }, { status: 400 });
      }

      // Найти все ISO-недели (Mon-Sun), которые пересекаются с месяцем
      const monthStart = new Date(Date.UTC(year, month - 1, 1));
      const monthEnd = new Date(Date.UTC(year, month, 0));
      // Начало: первый понедельник ≤ monthStart
      const firstMon = new Date(monthStart);
      const dayOfWeek = firstMon.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
      const diffToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      firstMon.setUTCDate(firstMon.getUTCDate() + diffToMon);

      const weekMondays: string[] = [];
      const today = getBusinessToday();
      const DATA_START = new Date(Date.UTC(2026, 0, 1));
      for (let cur = new Date(firstMon); cur <= monthEnd; cur.setUTCDate(cur.getUTCDate() + 7)) {
        const isoDate = cur.toISOString().slice(0, 10);
        // Skip недели, чей понедельник раньше начала данных или в будущем
        if (cur >= DATA_START && isoDate <= today) {
          weekMondays.push(isoDate);
        }
      }

      if (weekMondays.length === 0) {
        return jsonOk({ mode: "weeks", month: monthParam, weeks: [] });
      }

      const results = await fetchWithConcurrency(
        weekMondays,
        (mondayStr) => buildDailyResponseCached(department, "week", mondayStr, vertical),
        4,
      );

      // Расширим каждую неделю красивым подписью "DD.MM-DD.MM"
      const weeksWithLabels = results.map((snap, i) => {
        const mon = new Date(`${weekMondays[i]}T00:00:00Z`);
        const sun = new Date(mon);
        sun.setUTCDate(mon.getUTCDate() + 6);
        const fmt = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        return { ...snap, periodDate: `${fmt(mon)}-${fmt(sun)}` };
      });

      return jsonOk({ mode: "weeks", month: monthParam, weeks: weeksWithLabels });
    }

    if (mode === "months") {
      const year = Number(url.searchParams.get("year") || new Date().getFullYear());
      const dates: string[] = [];
      for (let m = 1; m <= 12; m++) {
        dates.push(`${year}-${String(m).padStart(2, "0")}-01`);
      }

      const results = await fetchWithConcurrency(
        dates,
        (dateStr) => buildDailyResponseCached(department, "month", dateStr, vertical),
        4,
      );

      return jsonOk({
        mode: "months",
        year,
        months: results,
      });
    }

    // Unreachable — ALLOWED_MODES guard above prevents this branch.
    return NextResponse.json({ error: `Invalid mode: ${mode}` }, { status: 400 });
  } catch (error) {
    console.error("Daily range API error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
