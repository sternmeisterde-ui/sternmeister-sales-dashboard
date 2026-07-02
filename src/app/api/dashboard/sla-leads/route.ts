// GET /api/dashboard/sla-leads?department=b2b&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Drill-down SLA-плитки (спека 22 п.5.3): сделки, из которых состоит
// среднее — ссылка на лид, ФИ клиента, телефон, значение и статус SLA,
// разбивка по МОПам (группировка на клиенте). Скоуп идентичен плитке —
// среднее по списку равно цифре плитки.

import { type NextRequest, NextResponse } from "next/server";
import { getAnalyticsSlaLeadsDetail } from "@/lib/daily/analytics-calls";
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

    const items = await getAnalyticsSlaLeadsDetail(
      department,
      Math.floor(fromDate.getTime() / 1000),
      Math.floor(toDate.getTime() / 1000),
    );
    return NextResponse.json(
      { items },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("[Dashboard sla-leads] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
