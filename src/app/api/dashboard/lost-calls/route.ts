// GET /api/dashboard/lost-calls?department=b2b&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Drill-down плитки «Потерянные» (спека 22 п.6): список потерянных звонков
// с менеджером, телефоном, временем и сделкой (если звонок обогащён).
// Условия отбора идентичны счётчику плитки (getAnalyticsLostCalls) — список
// всегда сходится с цифрой. Границы дат — берлинские сутки, как у
// /api/dashboard.

import { type NextRequest, NextResponse } from "next/server";
import { getAnalyticsLostCallsDetail } from "@/lib/daily/analytics-calls";
import { getManagersWithKommo } from "@/lib/db/queries-daily";
import { parseDateBoundary } from "@/lib/utils/date";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const sp = req.nextUrl.searchParams;
    const department = sp.get("department") === "b2b" ? "b2b" : "b2g";
    const fromStr = sp.get("from");
    const toStr = sp.get("to");
    if (!fromStr || !toStr) {
      return NextResponse.json({ error: "from/to required (YYYY-MM-DD)" }, { status: 400 });
    }
    const fromDate = parseDateBoundary(fromStr, "start");
    const toDate = parseDateBoundary(toStr, "end");
    if (!fromDate || !toDate) {
      return NextResponse.json({ error: "bad from/to" }, { status: 400 });
    }

    // Тот же ростер, что у плитки (/api/dashboard) — счётчик и детализация
    // всегда считаются по одному множеству менеджеров.
    const allManagers = await getManagersWithKommo(department);
    const items = await getAnalyticsLostCallsDetail(
      allManagers,
      department,
      Math.floor(fromDate.getTime() / 1000),
      Math.floor(toDate.getTime() / 1000),
    );
    return NextResponse.json(
      { items },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("[Dashboard lost-calls] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
