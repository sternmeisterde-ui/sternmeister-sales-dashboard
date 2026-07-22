// GET /api/category-dynamics?funnel=buh|med|all&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Вкладка «Динамика категорий» (b2b, admin-only). Отдаёт дневные агрегаты
// корзина × день (лиды + продажи) по всем измерениям разом — категория +
// 4 ответа анкеты (dims.category / startDate / income / status / language);
// иерархию (год→месяцы→недели→дни), проценты и сравнение периодов клиент
// собирает сам из этих же строк — один shape на все режимы.
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getCategoryDynamicsDays,
  type CategoryFunnel,
} from "@/lib/category-dynamics/data";
import { parseDateBoundary } from "@/lib/utils/date";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const sp = request.nextUrl.searchParams;
    const funnelParam = sp.get("funnel");
    const funnel: CategoryFunnel =
      funnelParam === "med" || funnelParam === "all" ? funnelParam : "buh";

    const fromStr = sp.get("from");
    const toStr = sp.get("to");
    if (!fromStr || !toStr || !DATE_RE.test(fromStr) || !DATE_RE.test(toStr) || fromStr > toStr) {
      return NextResponse.json({ error: "Invalid from/to" }, { status: 400 });
    }

    const fromDate = parseDateBoundary(fromStr, "start");
    const toDate = parseDateBoundary(toStr, "end");
    if (!fromDate || !toDate) {
      return NextResponse.json({ error: "Invalid from/to" }, { status: 400 });
    }
    const dims = await getCategoryDynamicsDays(
      funnel,
      Math.floor(fromDate.getTime() / 1000),
      Math.floor(toDate.getTime() / 1000),
    );

    return NextResponse.json({ success: true, funnel, from: fromStr, to: toStr, dims });
  } catch (error) {
    console.error("[Category Dynamics API]", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
