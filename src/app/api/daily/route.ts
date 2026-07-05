// GET /api/daily?department=b2g&period=day&date=2026-02-28[&vertical=buh|med|all]
import { NextRequest, NextResponse } from "next/server";
import { buildDailyResponseCached } from "@/lib/daily/build-response";
import type { Vertical } from "@/lib/kommo/pipeline-config";

const ALLOWED_DEPARTMENTS = new Set(["b2g", "b2b"]);
const ALLOWED_PERIODS = new Set(["day", "week", "month", "year"]);
// Permissive but bounded — server-side cache (in build-response.ts) already
// dedups bursts; this lets the browser/edge cache identical re-requests for
// half a minute and serve a stale copy for another minute while we revalidate.
const CACHE_HEADER = "private, max-age=30, stale-while-revalidate=60";

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department") ?? "b2g";
    const period = url.searchParams.get("period") ?? "day";
    const dateStr = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

    if (!ALLOWED_DEPARTMENTS.has(department)) {
      return NextResponse.json({ error: `Invalid department: ${department}` }, { status: 400 });
    }
    if (!ALLOWED_PERIODS.has(period)) {
      return NextResponse.json({ error: `Invalid period: ${period}` }, { status: 400 });
    }
    if (!isValidDate(dateStr)) {
      return NextResponse.json({ error: `Invalid date: ${dateStr} (expected YYYY-MM-DD)` }, { status: 400 });
    }

    // Вертикаль (только b2g, spec 21). Без параметра → legacy (буховое
    // поведение) — так старые клиенты и b2b ничего не замечают.
    const rawVertical = url.searchParams.get("vertical");
    const vertical: Vertical | undefined =
      department === "b2g" && (rawVertical === "buh" || rawVertical === "med" || rawVertical === "all")
        ? rawVertical
        : undefined;

    const responseData = await buildDailyResponseCached(department, period, dateStr, vertical);
    return NextResponse.json(responseData, { headers: { "Cache-Control": CACHE_HEADER } });
  } catch (error) {
    console.error("Daily API error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
