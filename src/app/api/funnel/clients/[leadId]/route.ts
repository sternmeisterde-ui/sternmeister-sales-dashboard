import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getClientDetail } from "@/lib/funnel/client-detail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/funnel/clients/[leadId]
 * Детали клиента для drawer'а: таймлайн касаний + история стадий (ТЗ §8).
 * Грузится лениво при открытии карточки. Только admin.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { leadId } = await params;
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "bad lead id" }, { status: 400 });
  }

  try {
    const detail = await getClientDetail(id);
    return NextResponse.json(detail, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error(`[/api/funnel/clients/${id}] failed:`, e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
