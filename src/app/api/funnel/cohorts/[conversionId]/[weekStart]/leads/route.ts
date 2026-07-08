import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computeCohortLeads } from "@/lib/funnel/lead-list";
import { parseLangBuckets } from "@/lib/funnel/compute";
import { funnelFrom, funnelToExclusive } from "@/lib/funnel/date-range";
import type { ConversionId } from "@/lib/funnel/types";
import { CONVERSION_ORDER } from "@/lib/funnel/conversions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ conversionId: string; weekStart: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { conversionId: cidRaw, weekStart } = await params;
  if (!CONVERSION_ORDER.includes(cidRaw as ConversionId)) {
    return NextResponse.json(
      { error: `unknown conversion ${cidRaw}` },
      { status: 400 }
    );
  }
  const conversionId = cidRaw as ConversionId;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return NextResponse.json(
      { error: "weekStart must be YYYY-MM-DD" },
      { status: 400 }
    );
  }

  const sp = req.nextUrl.searchParams;
  const metricRaw = sp.get("metric");
  if (metricRaw !== "base" && metricRaw !== "target") {
    return NextResponse.json(
      { error: "metric must be 'base' or 'target'" },
      { status: 400 }
    );
  }

  // Чтобы посчитать корректно, нужны те же фильтры, что у /cohorts:
  // from/to определяют размер baseLeads-выборки, а потом мы фильтруем по неделе.
  // На фронте — берутся из текущих фильтров.
  // Границы — берлинские гражданские, правая включительна (см. date-range.ts).
  const from = funnelFrom(sp.get("from"));
  const to = funnelToExclusive(sp.get("to"));
  if (!from || !to) {
    return NextResponse.json(
      { error: "from and to are required (YYYY-MM-DD)" },
      { status: 400 }
    );
  }
  const source = sp.get("source") || null;
  const responsibleUserIdRaw = sp.get("responsible_user_id");
  const responsibleUserId = responsibleUserIdRaw
    ? Number(responsibleUserIdRaw)
    : null;
  if (responsibleUserId !== null && Number.isNaN(responsibleUserId)) {
    return NextResponse.json(
      { error: "responsible_user_id must be a number" },
      { status: 400 }
    );
  }

  try {
    const rawVertical = sp.get("vertical");
    const payload = await computeCohortLeads({
      conversionId,
      weekStartIso: weekStart,
      metric: metricRaw,
      from,
      to,
      maturity: "all", // зрелость на drill не влияет
      source,
      responsibleUserId,
      lang: parseLangBuckets(sp.get("lang")),
      vertical:
        rawVertical === "buh" || rawVertical === "med" || rawVertical === "all"
          ? rawVertical
          : undefined,
    });
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("[/api/funnel/cohorts/.../leads] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
