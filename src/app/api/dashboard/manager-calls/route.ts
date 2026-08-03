// GET /api/dashboard/manager-calls?department=b2g&manager=<имя>&from=YYYY-MM-DD&to=YYYY-MM-DD[&vertical=]
//
// Детализация звонков ОДНОГО менеджера — drill-down по строке таблицы
// «Менеджеры» на вкладке «Звонки». Одна строка ответа = один звонок: время,
// направление, платформа (CloudTalk / CallGear / WhatsApp / …), длительность,
// гудки, клиент и сделка.
//
// Скоуп и длительность копируют плитки (getManagerCallsDetail использует те же
// deptCond/durationExpr), поэтому суммы детализации сходятся с таблицей.
//
// Отдаём максимум 1000 строк, отсортированных по времени вниз, плюс `total` —
// сколько звонков всего попало в скоуп. У Госников месяц на человека даёт до
// ~5 тыс. строк, и грузить их в модалку нет смысла: клиент честно пишет,
// сколько скрыто, и предлагает сузить период.

import { type NextRequest, NextResponse } from "next/server";
import { getManagerCallsDetail } from "@/lib/daily/analytics-calls";
import { parseVertical } from "@/lib/kommo/pipeline-config";
import { parseDateBoundary } from "@/lib/utils/date";

export const dynamic = "force-dynamic";

const ROW_LIMIT = 1000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const sp = req.nextUrl.searchParams;
    const department = sp.get("department") === "b2b" ? "b2b" : "b2g";
    const manager = sp.get("manager");
    const fromStr = sp.get("from");
    const toStr = sp.get("to");
    if (!manager) {
      return NextResponse.json({ error: "manager required" }, { status: 400 });
    }
    if (!fromStr || !toStr) {
      return NextResponse.json({ error: "from/to required (YYYY-MM-DD)" }, { status: 400 });
    }
    const fromDate = parseDateBoundary(fromStr, "start");
    const toDate = parseDateBoundary(toStr, "end");
    if (!fromDate || !toDate) {
      return NextResponse.json({ error: "bad from/to" }, { status: 400 });
    }
    // Вертикаль осмысленна только у Госников — у Комм медицина слита.
    const vertical = department === "b2g" ? parseVertical(sp.get("vertical")) : undefined;

    const { rows, total } = await getManagerCallsDetail(
      manager,
      department,
      Math.floor(fromDate.getTime() / 1000),
      Math.floor(toDate.getTime() / 1000),
      vertical,
      ROW_LIMIT,
    );

    return NextResponse.json(
      { manager, rows, total, limit: ROW_LIMIT },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("[Dashboard manager-calls] error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
