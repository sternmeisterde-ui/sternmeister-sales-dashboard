import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getRoleplaysForLeads } from "@/lib/funnel/roleplays";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/funnel/roleplays?lead_ids=1,2,3
 * Возвращает клиентские оценки ролевок (ДЦ/АА, попытки, готовность) по лидам.
 * Только для admin. В ответе — лиды, у которых ролевки есть.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const raw = req.nextUrl.searchParams.get("lead_ids");
  if (!raw) {
    return NextResponse.json(
      { error: "lead_ids required (comma-separated)" },
      { status: 400 },
    );
  }
  const leadIds = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (leadIds.length === 0) {
    return NextResponse.json({ error: "no valid lead_ids" }, { status: 400 });
  }
  if (leadIds.length > 500) {
    return NextResponse.json({ error: "too many lead_ids (max 500)" }, { status: 400 });
  }

  try {
    const map = await getRoleplaysForLeads(leadIds);
    const leads = Array.from(map.values());
    return NextResponse.json(
      { leads },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[/api/funnel/roleplays] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
