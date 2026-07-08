import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computeDcBreakdown } from "@/lib/funnel/dc-breakdown";
import { parseLangBuckets } from "@/lib/funnel/compute";
import { funnelFrom, funnelToExclusive } from "@/lib/funnel/date-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/funnel/dc-breakdown — разбор C3.1 за период: из лидов с состоявшимся
 * Термином ДЦ сколько продвинулись / остались / потеряны (закрыто/отложен/
 * апелляция) + лиды по вёдрам. Период берётся из текущих фильтров воронки.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
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
    const payload = await computeDcBreakdown({
      from,
      to,
      maturity: "all", // разбор за период как есть
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
    console.error("[/api/funnel/dc-breakdown] compute failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
