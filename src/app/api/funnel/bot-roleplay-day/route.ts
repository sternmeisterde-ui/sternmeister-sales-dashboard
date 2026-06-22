import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getBotRoleplaysOnDay } from "@/lib/funnel/bot-roleplays";
import { getLeadNames } from "@/lib/funnel/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KOMMO_BASE = "https://sternmeister.kommo.com/leads/detail";

/**
 * GET /api/funnel/bot-roleplay-day?day=YYYY-MM-DD
 * Кто и сколько тренировался с ботом в этот день (drill по точке графика).
 * Только admin. Без BERATER_BOT_DATABASE_URL — пустой список (graceful).
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const day = req.nextUrl.searchParams.get("day");
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return NextResponse.json({ error: "bad day" }, { status: 400 });
  }

  try {
    const rows = await getBotRoleplaysOnDay(day);
    const names = await getLeadNames(rows.map((r) => r.leadId));
    const clients = rows.map((r) => ({
      leadId: r.leadId,
      count: r.count,
      name: names.get(r.leadId) ?? `Лид #${r.leadId}`,
      kommoUrl: `${KOMMO_BASE}/${r.leadId}`,
    }));
    return NextResponse.json({ day, clients }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[/api/funnel/bot-roleplay-day] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
