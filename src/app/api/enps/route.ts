import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getEnpsStats } from "@/lib/enps/stats";
import { maybeSyncEnpsInBackground } from "@/lib/enps/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/enps?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Агрегаты анонимного пульс-опроса eNPS (b2g). Только admin.
 * from/to опциональны — без них весь накопленный период.
 * Отдаём из D1 сразу; освежение из Google Sheets — фоном (stale-while-revalidate).
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    return NextResponse.json({ error: "bad range" }, { status: 400 });
  }

  maybeSyncEnpsInBackground();

  try {
    const stats = await getEnpsStats({ department: "b2g", from, to });
    return NextResponse.json(stats, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[/api/enps] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
