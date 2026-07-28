import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computeRoleplayAudit } from "@/lib/funnel/roleplay-audit";
import { todayBerlinDate, fmtLocalDate } from "@/lib/utils/date";
import type { Vertical } from "@/lib/kommo/pipeline-config";

function parseVerticalParam(raw: string | null): Vertical | undefined {
  return raw === "buh" || raw === "med" || raw === "all" ? raw : undefined;
}

function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/funnel/roleplay-audit?termin_from=YYYY-MM-DD&termin_to=YYYY-MM-DD&vertical=
 * Таблица «Ролевки»: проведено / оценено ботом / выставлено в Kommo по каждой
 * сделке с термином в периоде. Фильтр — тот же, что у таблицы клиентов.
 * Только admin (вкладка Воронка целиком admin-only).
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const today = fmtLocalDate(todayBerlinDate());
  let from = parseDate(sp.get("termin_from")) ?? today;
  let to = parseDate(sp.get("termin_to"));
  if (to && from > to) [from, to] = [to, from];

  const limitRaw = Number(sp.get("limit"));
  const limit =
    Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 1000 ? limitRaw : 300;

  try {
    const result = await computeRoleplayAudit(
      { terminFrom: from, terminTo: to, vertical: parseVerticalParam(sp.get("vertical")) },
      limit,
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[/api/funnel/roleplay-audit] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
