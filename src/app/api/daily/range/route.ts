// GET /api/daily/range?department=b2g&month=2026-03&mode=days
// Returns array of daily snapshots for every day in a month (or every month in a year)
import { NextRequest, NextResponse } from "next/server";
import { buildDailyResponseCached, getBusinessToday } from "@/lib/daily/build-response";

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
    const department = url.searchParams.get("department") || "b2g";
    const mode = url.searchParams.get("mode") || "days";
    const monthParam = url.searchParams.get("month") || "";

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
      const DATA_START = new Date(2026, 2, 24); // March 24, 2026
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
        return NextResponse.json({
          mode: "days",
          month: monthParam,
          days: [],
          monthlySummary: null,
        });
      }

      // Fetch days with limited concurrency — past dates with snapshots are instant,
      // only today (and days without snapshots) hit Kommo API
      const results = await fetchWithConcurrency(
        dates,
        (dateStr) => buildDailyResponseCached(department, "day", dateStr),
        3,
      );

      // Also fetch the full month summary
      const monthDate = `${year}-${String(month).padStart(2, "0")}-01`;
      const monthlySummary = await buildDailyResponseCached(department, "month", monthDate);

      return NextResponse.json({
        mode: "days",
        month: monthParam,
        days: results,
        monthlySummary,
      });
    }

    if (mode === "months") {
      const year = Number(url.searchParams.get("year") || new Date().getFullYear());
      const dates: string[] = [];
      for (let m = 1; m <= 12; m++) {
        dates.push(`${year}-${String(m).padStart(2, "0")}-01`);
      }

      const results = await fetchWithConcurrency(
        dates,
        (dateStr) => buildDailyResponseCached(department, "month", dateStr),
        3,
      );

      return NextResponse.json({
        mode: "months",
        year,
        months: results,
      });
    }

    return NextResponse.json({ error: "Invalid mode, expected days or months" }, { status: 400 });
  } catch (error) {
    console.error("Daily range API error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
