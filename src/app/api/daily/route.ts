// GET /api/daily?department=b2g&period=day&date=2026-02-28
import { NextRequest, NextResponse } from "next/server";
import { buildDailyResponseCached } from "@/lib/daily/build-response";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department") || "b2g";
    const period = url.searchParams.get("period") || "day";
    const dateStr = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);

    const responseData = await buildDailyResponseCached(department, period, dateStr);
    return NextResponse.json(responseData);
  } catch (error) {
    console.error("Daily API error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
