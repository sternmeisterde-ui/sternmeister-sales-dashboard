// GET /api/complaints/[id]/eval?phase=before|after — замороженный снимок
// детализации оценки (FrozenEvalPayload) для модалки EvalDetailView.
// Вынесен из списка отдельной ручкой, чтобы GET /api/complaints оставался
// лёгким (без jsonb). Менеджер может смотреть только снимки СВОИХ жалоб.

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { complaints } from "@/lib/db/schema-existing";
import { getManagersForDept, matchMasterManager } from "@/lib/complaints/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const phase = req.nextUrl.searchParams.get("phase") === "after" ? "after" : "before";

  try {
    const rows = await db
      .select({
        department: complaints.department,
        managerName: complaints.managerName,
        managerTelegram: complaints.managerTelegram,
        masterManagerId: complaints.masterManagerId,
        status: complaints.status,
        evalBefore: complaints.evalBefore,
        evalAfter: complaints.evalAfter,
      })
      .from(complaints)
      .where(eq(complaints.id, id))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const row = rows[0];

    // Менеджер: только свой отдел и только собственные жалобы — тот же
    // предикат владения, что в списке (master-id ЛИБО telegram/имя строки).
    if (session.role !== "admin") {
      if (row.department !== session.department) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
      const managers = await getManagersForDept(session.department);
      const caller = matchMasterManager(managers, {
        telegram: session.telegramUsername,
        name: session.name,
      });
      const tg = (session.telegramUsername || "").replace(/^@/, "").toLowerCase();
      const rowTg = (row.managerTelegram || "").replace(/^@/, "").toLowerCase();
      const owns =
        (caller && row.masterManagerId === caller.id) ||
        (tg && rowTg && tg === rowTg) ||
        row.managerName === session.name;
      if (!owns) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }

    const payload = phase === "after" ? row.evalAfter : row.evalBefore;
    if (!payload) {
      return NextResponse.json({ error: "no snapshot" }, { status: 404 });
    }

    return NextResponse.json(
      { phase, payload },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[/api/complaints/[id]/eval] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
