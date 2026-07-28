import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computeRoleplaysSection } from "@/lib/funnel/roleplays-section";
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
 * GET /api/funnel/roleplays-section?from=YYYY-MM-DD&to=YYYY-MM-DD&vertical=
 * Раздел «Ролевки»: консультации ≥10 мин, разбор ОКК, подтверждённые ролевки,
 * ручные vs ботовые оценки в Kommo. Период — по ДАТЕ КОНСУЛЬТАЦИИ (звонка).
 * Только admin.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const today = fmtLocalDate(todayBerlinDate());
  let from = parseDate(sp.get("from")) ?? today;
  let to = parseDate(sp.get("to")) ?? today;
  if (from > to) [from, to] = [to, from];

  try {
    const result = await computeRoleplaysSection({
      from,
      to,
      vertical: parseVerticalParam(sp.get("vertical")),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[/api/funnel/roleplays-section] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
