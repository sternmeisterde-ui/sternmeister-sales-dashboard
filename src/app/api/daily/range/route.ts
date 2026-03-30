// GET /api/daily/range?department=b2g&month=2026-03&mode=days
// Returns array of daily snapshots for every day in a month (or every month in a year)
import { NextRequest, NextResponse } from "next/server";
import { buildDailyResponseCached } from "@/lib/daily/build-response";

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
      // Data starts from March 24, 2026 — skip earlier dates
      const DATA_START = new Date(2026, 2, 24); // March 24, 2026
      const dates: string[] = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const dateObj = new Date(year, month - 1, d);
        if (dateObj >= DATA_START) {
          dates.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
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

      // Fetch all days in parallel (each individually cached)
      const results = await Promise.all(
        dates.map((dateStr) => buildDailyResponseCached(department, "day", dateStr))
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

      const results = await Promise.all(
        dates.map((dateStr) => buildDailyResponseCached(department, "month", dateStr))
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
