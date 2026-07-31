import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getBotTrainingStats } from "@/lib/funnel/bot-roleplays";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/funnel/bot-roleplay-stats?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Дневная статистика тренировок и целевой пул для сравнительной таблицы.
 * Только admin; данные тренировок читаются из analytics-зеркала.
 * Ответ больше не зависит от модуля рассылок.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = sp.get("from");
  const to = sp.get("to");
  if (!from || !to || !re.test(from) || !re.test(to)) {
    return NextResponse.json({ error: "bad range" }, { status: 400 });
  }

  try {
    const training = await getBotTrainingStats(from, to);
    return NextResponse.json(
      training,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[/api/funnel/bot-roleplay-stats] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
