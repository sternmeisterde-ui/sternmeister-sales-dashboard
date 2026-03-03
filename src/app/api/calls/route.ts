import { NextRequest, NextResponse } from "next/server";
import { getAIRoleCalls, getManagerStats } from "@/lib/db/queries-existing";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const department = searchParams.get("department") as "b2g" | "b2b" || "b2g";
    const type = searchParams.get("type") || "all";

    // Диагностика: какая БД используется
    const dbInfo = {
      department,
      hasR1Url: !!process.env.R1_DATABASE_URL,
      tables: department === "b2b" ? "r1_calls + r1_users" : "d1_calls + d1_users",
    };

    // Возвращаем оба набора данных за один запрос
    if (type === "all") {
      const [calls, managers] = await Promise.all([
        getAIRoleCalls(department),
        getManagerStats(department),
      ]);
      return NextResponse.json({ success: true, data: { calls, managers }, _debug: dbInfo });
    }

    if (type === "managers") {
      const managers = await getManagerStats(department);
      return NextResponse.json({ success: true, data: managers, _debug: dbInfo });
    }

    const calls = await getAIRoleCalls(department);
    return NextResponse.json({ success: true, data: calls, _debug: dbInfo });
  } catch (error) {
    console.error("Error fetching calls:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch data", _debug: { hasR1Url: !!process.env.R1_DATABASE_URL } },
      { status: 500 }
    );
  }
}
