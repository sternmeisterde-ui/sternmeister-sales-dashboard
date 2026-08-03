// GET /api/dashboard/b2b-tile-details?department=b2b|b2g&from=YYYY-MM-DD&to=YYYY-MM-DD[&line=1|2|3]
//
// Детализация KPI-плиток (Исходящие / Принятых / % дозвона / Ожидание):
// разбивка по платформам (CloudTalk/CallGear по префиксу communication_id),
// менеджер × платформа, почасовка по Берлину и ожидание ответа. Скоуп и
// пороги идентичны счётчикам плиток (getAnalyticsB2bTileDetails копирует
// фильтры fetchCallMetricsByMaster/fetchAvgWaitSeconds) — цифры детализации
// всегда сходятся с плитками. Один ответ обслуживает все четыре модалки —
// клиент фетчит лениво по первому клику и кэширует на период.
//
// Работает для обоих отделов: платформы (ct:/cg-leg:) общие, отличается только
// durationExpr (b2b фолдит wait в cg-leg, b2g — чистый разговор) — по dept.
//
// `line` (только b2g) сужает РОСТЕР до менеджеров этой линии — ровно то же, что
// делают пилюли-переключатель на вкладке. Скоуп задаётся ростером, а не
// фильтром поверх результата, поэтому и платформы, и почасовка, и ожидание
// пересчитываются по линии целиком, а не «шапка от отдела, строки от линии».

import { type NextRequest, NextResponse } from "next/server";
import { getAnalyticsB2bTileDetails } from "@/lib/daily/analytics-calls";
import { getManagersWithKommo } from "@/lib/db/queries-daily";
import { parseDateBoundary } from "@/lib/utils/date";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const sp = req.nextUrl.searchParams;
    const department = sp.get("department") === "b2g" ? "b2g" : "b2b";
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

    // Тот же ростер, что у плиток (/api/dashboard) — единое множество агентов.
    const allManagers = await getManagersWithKommo(department);
    const lineParam = sp.get("line");
    const line = lineParam === "1" || lineParam === "2" || lineParam === "3" ? lineParam : null;
    const scopedManagers = line ? allManagers.filter((m) => m.line === line) : allManagers;
    const details = await getAnalyticsB2bTileDetails(
      scopedManagers,
      department,
      Math.floor(fromDate.getTime() / 1000),
      Math.floor(toDate.getTime() / 1000),
    );
    return NextResponse.json(details, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    console.error("[Dashboard b2b-tile-details] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
