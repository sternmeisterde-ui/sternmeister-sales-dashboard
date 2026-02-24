import { NextRequest, NextResponse } from "next/server";
import { getAIRoleCalls, getManagerStats } from "@/lib/db/queries-existing";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const department = searchParams.get("department") as "b2g" | "b2b" || "b2g";
    const type = searchParams.get("type") || "all";

    // Возвращаем оба набора данных за один запрос
    if (type === "all") {
      const [calls, managers] = await Promise.all([
        getAIRoleCalls(department),
        getManagerStats(department),
      ]);
      return NextResponse.json({ success: true, data: { calls, managers } });
    }

    if (type === "managers") {
      const managers = await getManagerStats(department);
      return NextResponse.json({ success: true, data: managers });
    }

    const calls = await getAIRoleCalls(department);
    return NextResponse.json({ success: true, data: calls });
  } catch (error) {
    console.error("Error fetching calls:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch data" },
      { status: 500 }
    );
  }
}
