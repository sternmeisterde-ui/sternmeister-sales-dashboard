// PATCH /api/complaints/[id]/comment — ручной комментарий по жалобе из
// вкладки. Единственное ручное поле: статусы/решения пишет только
// batch-endpoint адъюдикатора (/api/complaints/resolve). Права — как у
// модерации (MODERATOR_ROLES в analytics/exclude): masterRole admin | rop.

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { complaints } from "@/lib/db/schema-existing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MODERATOR_ROLES = new Set(["admin", "rop"]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!MODERATOR_ROLES.has(session.masterRole)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const body = (await req.json()) as { comment?: unknown };
    if (typeof body.comment !== "string" || body.comment.length > 4000) {
      return NextResponse.json({ error: "comment: string up to 4000 chars" }, { status: 400 });
    }
    const comment = body.comment.trim() || null; // пустая строка = очистить

    const updated = await db
      .update(complaints)
      .set({ comment, updatedAt: new Date() })
      .where(eq(complaints.id, id))
      .returning({ id: complaints.id });
    if (updated.length === 0) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, id, comment });
  } catch (e) {
    console.error("[/api/complaints/[id]/comment] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
