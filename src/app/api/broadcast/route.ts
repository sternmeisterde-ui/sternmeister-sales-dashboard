import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getBroadcastStats } from "@/lib/broadcast/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Бот-Neon scale-to-zero: первый запрос будит БД, даём запас по времени.
export const maxDuration = 30;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/broadcast?from=YYYY-MM-DD&to=YYYY-MM-DD&campaign=<id>
 * Статистика drip-рассылки бота (B2G «прогрев к термину»). Только admin.
 * campaign не задан → самая объёмная кампания. Нет BERATER_BOT_DATABASE_URL /
 * БД недоступна → available:false (graceful, UI рисует пустое состояние).
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: "bad range" }, { status: 400 });
  }
  const campaign = sp.get("campaign") || undefined;

  try {
    const stats = await getBroadcastStats({ campaignId: campaign, from, to });
    return NextResponse.json(stats, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[/api/broadcast] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
