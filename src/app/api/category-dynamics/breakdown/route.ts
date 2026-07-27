// GET /api/category-dynamics/breakdown
//   ?funnel=buh|med|all&from=YYYY-MM-DD&to=YYYY-MM-DD&dim=<измерение>&bucket=<ключ>
//
// Drill-down вкладки «Динамика категорий» (b2b, admin-only): из каких сырых
// написаний Kommo складывается корзина за период. bucket может быть пустой
// строкой («Без метки»/«Без ответа»). Границы — строками civil-дат по
// берлинскому календарю (Date-параметры запрещены, см. data.ts).
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  DIM_BUCKETS,
  DIMENSION_KEYS,
  getCategoryBucketBreakdown,
  type CategoryFunnel,
  type DimensionKey,
} from "@/lib/category-dynamics/data";

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

    const from = sp.get("from") ?? "";
    const to = sp.get("to") ?? "";
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
      return NextResponse.json({ error: "Invalid from/to" }, { status: 400 });
    }

    const dim = sp.get("dim") as DimensionKey | null;
    if (!dim || !DIMENSION_KEYS.includes(dim)) {
      return NextResponse.json({ error: "Invalid dim" }, { status: 400 });
    }
    const bucket = sp.get("bucket") ?? "";
    if (!(DIM_BUCKETS[dim] as readonly string[]).includes(bucket)) {
      return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
    }

    const rows = await getCategoryBucketBreakdown(funnel, from, to, dim, bucket);
    return NextResponse.json({ success: true, funnel, from, to, dim, bucket, rows });
  } catch (error) {
    console.error("[Category Dynamics Breakdown API]", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
