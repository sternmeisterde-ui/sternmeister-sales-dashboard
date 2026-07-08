import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computeCohorts, parseLangBuckets } from "@/lib/funnel/compute";
import { funnelFrom, funnelToExclusive } from "@/lib/funnel/date-range";
import type { MaturityFilter } from "@/lib/funnel/types";
import type { Vertical } from "@/lib/kommo/pipeline-config";

/** Вертикаль b2g из query (buh/med/all). Иначе undefined = буховая (legacy). */
function parseVerticalParam(raw: string | null): Vertical | undefined {
  return raw === "buh" || raw === "med" || raw === "all" ? raw : undefined;
}

export const runtime = "nodejs";
// Не кешируем — данные читаются прямо из аналитики каждый раз.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // По плану 04 §1.5 — вкладка только для admin (роли проверены в page.tsx).
  // role === "admin" (не masterRole): РОП получает admin-доступ как в остальных
  // admin-роутах, иначе видит вкладку (nav гейтит по role), но ловит 403.
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

  const maturity = parseMaturity(params.get("maturity_state"));
  const source = params.get("source") || null;
  const responsibleUserIdRaw = params.get("responsible_user_id");
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
    const payload = await computeCohorts({
      from,
      to,
      maturity,
      source,
      responsibleUserId,
      lang: parseLangBuckets(params.get("lang")),
      vertical: parseVerticalParam(params.get("vertical")),
    });
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("[/api/funnel/cohorts] compute failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

function parseMaturity(raw: string | null): MaturityFilter {
  if (raw === "mature" || raw === "immature") return raw;
  return "all";
}
