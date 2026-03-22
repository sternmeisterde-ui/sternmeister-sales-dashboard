import { NextRequest, NextResponse } from "next/server";
import { getAIRoleCalls, getManagerStats } from "@/lib/db/queries-existing";
import { cached } from "@/lib/kommo/cache";

const AI_CALLS_CACHE_TTL = 2 * 60 * 1000;

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const deptParam = searchParams.get("department");
    const department = (deptParam === "b2b" ? "b2b" : "b2g") as "b2g" | "b2b";
    const type = searchParams.get("type") || "all";
    const fromDate = searchParams.get("from") || undefined;
    const toDate = searchParams.get("to") || undefined;

    const cacheKey = `ai-calls:${department}:${type}:${fromDate || ""}:${toDate || ""}`;
    const result = await cached(cacheKey, AI_CALLS_CACHE_TTL, async () => {
      if (type === "all") {
        const [calls, managers] = await Promise.all([
          getAIRoleCalls(department, fromDate, toDate),
          getManagerStats(department),
        ]);
        return { success: true, data: { calls, managers } };
      }

      if (type === "managers") {
        const managers = await getManagerStats(department);
        return { success: true, data: managers };
      }

      const calls = await getAIRoleCalls(department, fromDate, toDate);
      return { success: true, data: calls };
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching calls:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch data", _debug: { hasR1Url: !!process.env.R1_DATABASE_URL } },
      { status: 500 }
    );
  }
}
