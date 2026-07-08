import { NextRequest, NextResponse } from "next/server";
import { getManagersWithKommo } from "@/lib/db/queries-daily";
import { getAnalyticsDailyTrendByManager } from "@/lib/daily/analytics-calls";
import { parseDateBoundary } from "@/lib/utils/date";
import { parseVertical, type Vertical } from "@/lib/kommo/pipeline-config";

export const dynamic = "force-dynamic";

// GET /api/dashboard/manager-trend?department=&from=YYYY-MM-DD&to=YYYY-MM-DD[&vertical=]
// Лёгкая ручка per-manager дневного тренда за ПРОИЗВОЛЬНЫЙ период — нужна для
// режима «сравнение периодов» в графике «Динамика звонков» (второй период).
// Возвращает ту же форму, что `trendByManager` в /api/dashboard.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const department = sp.get("department") === "b2b" ? "b2b" : "b2g";
    const fromStr = sp.get("from");
    const toStr = sp.get("to");
    if (!fromStr || !toStr) {
      return NextResponse.json({ success: false, error: "from/to required" }, { status: 400 });
    }

    const vertical: Vertical | undefined =
      department === "b2g" ? parseVertical(sp.get("vertical")) : undefined;

    // Berlin-local boundaries (правило TZ: from=00:00 Берлин, to=23:59:59 Берлин).
    const fromD = parseDateBoundary(fromStr, "start");
    const toD = parseDateBoundary(toStr, "end");
    if (!fromD || !toD) {
      return NextResponse.json({ success: false, error: "bad date" }, { status: 400 });
    }
    const fromTs = Math.floor(fromD.getTime() / 1000);
    const toTs = Math.floor(toD.getTime() / 1000);

    const allManagers = await getManagersWithKommo(department);
    const trendByManager = await getAnalyticsDailyTrendByManager(
      department,
      fromTs,
      toTs,
      allManagers.map((m) => m.name),
      vertical,
    );

    return NextResponse.json({ success: true, trendByManager });
  } catch (e) {
    console.error("[manager-trend] error:", e);
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "error" },
      { status: 500 },
    );
  }
}
