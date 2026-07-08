import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computeManagers } from "@/lib/funnel/managers";
import { parseLangBuckets } from "@/lib/funnel/compute";
import { funnelFrom, funnelToExclusive } from "@/lib/funnel/date-range";
import type { Vertical } from "@/lib/kommo/pipeline-config";

/** Вертикаль b2g из query (buh/med/all). Иначе undefined = буховая (legacy). */
function parseVerticalParam(raw: string | null): Vertical | undefined {
  return raw === "buh" || raw === "med" || raw === "all" ? raw : undefined;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  // Границы — берлинские гражданские, правая включительна (см. date-range.ts).
  const from = funnelFrom(params.get("from"));
  const to = funnelToExclusive(params.get("to"));
  if (!from || !to) {
    return NextResponse.json(
      { error: "from and to are required (YYYY-MM-DD)" },
      { status: 400 }
    );
  }
  const source = params.get("source") || null;

  try {
    // Считаем все 3 роли за один проход — фронт переключает мгновенно.
    const payload = await computeManagers({
      from,
      to,
      maturity: "all",
      source,
      responsibleUserId: null,
      lang: parseLangBuckets(params.get("lang")),
      vertical: parseVerticalParam(params.get("vertical")),
    });
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("[/api/funnel/managers] compute failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
