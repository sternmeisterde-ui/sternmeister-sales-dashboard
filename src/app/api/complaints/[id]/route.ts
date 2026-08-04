// PATCH /api/complaints/[id] — смена статуса/решения по жалобе из вкладки.
// Доступ: masterRole admin | rop (как MODERATOR_ROLES в analytics/exclude —
// teamlead намеренно не модератор). Семантика — applyResolution:
// resolved_at/оценка «после» замораживаются один раз при первом решении.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { applyResolution } from "@/lib/complaints/resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

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
    const body = (await req.json()) as {
      status?: unknown;
      decision?: unknown;
      verdict?: unknown;
    };
    if (typeof body.status !== "string") {
      return NextResponse.json({ error: "status required" }, { status: 400 });
    }

    const result = await applyResolution(id, {
      status: body.status,
      decision: typeof body.decision === "string" ? body.decision.trim() : undefined,
      verdict: typeof body.verdict === "string" ? body.verdict : undefined,
      resolvedBy: session.name,
    });

    if (!result.ok) {
      const code = result.error === "not found" ? 404 : 400;
      return NextResponse.json({ error: result.error }, { status: code });
    }
    return NextResponse.json({ ok: true, id: result.id, status: result.status });
  } catch (e) {
    console.error("[/api/complaints/[id]] PATCH failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
