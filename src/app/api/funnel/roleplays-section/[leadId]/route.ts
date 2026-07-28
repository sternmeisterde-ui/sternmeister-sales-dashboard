import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getRoleplayAuditDetail } from "@/lib/funnel/roleplay-detail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/funnel/roleplays-section/[leadId]
 * Детализация ролевок сделки: все консультационные звонки, по каждому — балл,
 * 6 критериев и разбор по вопросам банка. Грузится лениво при открытии
 * карточки (question_coverage тяжёлый). Только admin.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ leadId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { leadId } = await params;
  const id = Number(leadId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "bad lead id" }, { status: 400 });
  }

  try {
    const calls = await getRoleplayAuditDetail(id);
    return NextResponse.json({ leadId: id, calls }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error(`[/api/funnel/roleplay-audit/${id}] failed:`, e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
