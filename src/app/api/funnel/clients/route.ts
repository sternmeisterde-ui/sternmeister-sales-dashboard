import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computeClients } from "@/lib/funnel/clients";
import { parseLangBucket } from "@/lib/funnel/compute";
import { todayBerlinDate, fmtLocalDate } from "@/lib/utils/date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/funnel/clients?termin_from=YYYY-MM-DD&termin_to=YYYY-MM-DD&limit=
 * Таблица клиентов со score «готовности» (ТЗ §5.4), фильтр — по дате термина.
 * По умолчанию — сегодня (Berlin). Только admin.
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
  const today = fmtLocalDate(todayBerlinDate());
  let from = parseDate(sp.get("termin_from")) ?? today;
  // termin_to отсутствует → открытый диапазон «с from и дальше».
  let to = parseDate(sp.get("termin_to"));
  if (to && from > to) {
    [from, to] = [to, from];
  }

  const limitRaw = Number(sp.get("limit"));
  const limit =
    Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 1000 ? limitRaw : 300;

  try {
    const result = await computeClients(
      { terminFrom: from, terminTo: to, lang: parseLangBucket(sp.get("lang")) },
      limit,
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("[/api/funnel/clients] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}
